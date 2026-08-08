import { AnchorProvider, Wallet } from '@coral-xyz/anchor'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey,
  SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js'

/// Decimals of the settlement asset. USDC has six, and the program handles one
/// dollar-denominated asset only (FR-014), so every test amount is in these units.
export const ASSET_DECIMALS = 6

/** Base units of the settlement asset. `asset(1_000)` is a thousand dollars. */
export const asset = (amount: number): bigint => {
  if (!Number.isInteger(amount)) {
    throw new Error(`asset() takes whole units, got ${amount}`)
  }
  return BigInt(amount) * 10n ** BigInt(ASSET_DECIMALS)
}

/**
 * Integration tests airdrop freely and mint an asset out of nothing. Pointed at a
 * real cluster that is either rate-limited nonsense or, worse, live state — so the
 * endpoint has to be loopback. `SOLANA_RPC_URL` is deliberately not consulted: in
 * `.env.example` it points at devnet.
 */
export const assertLocalEndpoint = (endpoint: string): void => {
  if (process.env.ALLOW_NON_LOCAL_TEST_RPC === '1') return

  const host = new URL(endpoint).hostname
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!loopback) {
    throw new Error(
      `Refusing to run integration tests against ${endpoint}. Start solana-test-validator, or set ALLOW_NON_LOCAL_TEST_RPC=1 if you mean it.`,
    )
  }
}

/**
 * The validator runs inside WSL and Vitest runs on Windows; WSL2 forwards
 * localhost, so this address reaches it from either side
 * (docs/PLAN.md → «Тулчейн: розподіл між WSL і Windows»).
 */
// `||` rather than `??`: an env var set to an empty string is how CI and shell
// wrappers express "unset", and an empty string is not a URL either way.
export const testRpcUrl = (): string => process.env.TEST_RPC_URL || 'http://127.0.0.1:8899'

/**
 * Blocks until the cluster enters a new epoch.
 *
 * An attestor admitted in one epoch votes from the next (FR-008), so anything that
 * needs an attestation has to cross a boundary. That is only feasible on a validator
 * started with `--slots-per-epoch 32`, where an epoch is about thirteen seconds
 * rather than two days — see `CLAUDE.md` → Commands.
 */
export const waitForNextEpoch = async (connection: Connection): Promise<number> => {
  const started = (await connection.getEpochInfo()).epoch
  const giveUpAt = Date.now() + 45_000

  for (;;) {
    const { epoch } = await connection.getEpochInfo()
    if (epoch > started) return epoch
    if (Date.now() > giveUpAt) {
      throw new Error(
        `Still in epoch ${epoch} after 45s. Start the validator with --slots-per-epoch 32; the default epoch is two days long and no attestor would ever become active.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * The `unix_timestamp` the program itself would read from `Clock::get()`.
 *
 * Taken from the sysvar rather than from `Date.now()`: every deadline in the program
 * is compared against the cluster's clock, which drifts from the host's — a test that
 * timed its waits by the wall clock would be off by that drift, in whichever direction
 * happened to make it flaky.
 */
export const clusterTimestamp = async (connection: Connection): Promise<number> => {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
  if (clock === null) throw new Error('Clock sysvar is missing — is this a real validator?')

  // Clock lays out slot, epoch_start_timestamp, epoch, leader_schedule_epoch,
  // unix_timestamp — five little-endian 64-bit fields, the last one at offset 32.
  const view = new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength)
  return Number(view.getBigInt64(32, true))
}

/** Blocks until the cluster clock is past `timestamp` (seconds). */
export const waitPastClusterTime = async (
  connection: Connection,
  timestamp: number,
): Promise<void> => {
  for (;;) {
    const now = await clusterTimestamp(connection)
    if (now > timestamp) return
    // Long enough not to hammer the RPC, short enough to overshoot a deadline by
    // little: the caller is holding a test open for the whole wait.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

export const validatorReachable = async (): Promise<boolean> => {
  try {
    await new Connection(testRpcUrl(), 'confirmed').getVersion()
    return true
  } catch {
    return false
  }
}

export interface TestEnv {
  connection: Connection
  /** Funded, and the mint authority of `assetMint`. */
  payer: Keypair
  provider: AnchorProvider
  /** Stand-in for USDC: same decimals, freely mintable in tests. */
  assetMint: PublicKey
  fundedKeypair(sol?: number): Promise<Keypair>
  /** Associated token account for `owner`, optionally credited with `amount`. */
  assetAccount(owner: PublicKey, amount?: bigint): Promise<PublicKey>
}

/**
 * The admin and the settlement asset are fixed forever when `Config` is created, and
 * `Config` is a singleton. If each test file generated its own keys, only the file
 * that happened to run first would hold admin rights or own the right mint — every
 * other one would fail `has_one`, and Vitest promises nothing about file order.
 *
 * So both are derived from constant seeds: whichever file runs first creates them,
 * the rest find the same addresses. Test-only keys, and the endpoint guard already
 * refuses anything but a local validator.
 */
export const adminKeypair = (): Keypair => Keypair.fromSeed(new Uint8Array(32).fill(7))
export const assetMintKeypair = (): Keypair => Keypair.fromSeed(new Uint8Array(32).fill(9))

export const setupTestEnv = async (): Promise<TestEnv> => {
  const endpoint = testRpcUrl()
  assertLocalEndpoint(endpoint)

  // `confirmed` rather than `processed`: every helper below is a precondition for
  // the assertion that follows it, and a precondition that might not have landed
  // yet produces failures that look like logic bugs.
  const connection = new Connection(endpoint, 'confirmed')

  const airdrop = async (keypair: Keypair, sol: number): Promise<void> => {
    const signature = await connection.requestAirdrop(keypair.publicKey, sol * LAMPORTS_PER_SOL)
    const status = await connection.confirmTransaction(signature, 'confirmed')
    if (status.value.err !== null) {
      throw new Error(`Airdrop failed: ${JSON.stringify(status.value.err)}`)
    }
  }

  const fundedKeypair = async (sol = 10): Promise<Keypair> => {
    const keypair = Keypair.generate()
    await airdrop(keypair, sol)
    return keypair
  }

  const payer = adminKeypair()
  // Topped up rather than funded once: several files share this key within a
  // validator run, and each of them pays rent for the accounts it creates.
  if ((await connection.getBalance(payer.publicKey)) < 50 * LAMPORTS_PER_SOL) {
    await airdrop(payer, 500)
  }

  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: 'confirmed',
  })

  const mint = assetMintKeypair()
  if ((await connection.getAccountInfo(mint.publicKey)) === null) {
    await createMint(connection, payer, payer.publicKey, null, ASSET_DECIMALS, mint)
  }
  const assetMint = mint.publicKey

  const assetAccount = async (owner: PublicKey, amount = 0n): Promise<PublicKey> => {
    const account = await getOrCreateAssociatedTokenAccount(connection, payer, assetMint, owner)
    if (amount > 0n) {
      await mintTo(connection, payer, assetMint, account.address, payer, amount)
    }
    return account.address
  }

  return { connection, payer, provider, assetMint, fundedKeypair, assetAccount }
}
