import { AnchorProvider, Wallet } from '@coral-xyz/anchor'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js'

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

export const setupTestEnv = async (): Promise<TestEnv> => {
  const endpoint = testRpcUrl()
  assertLocalEndpoint(endpoint)

  // `confirmed` rather than `processed`: every helper below is a precondition for
  // the assertion that follows it, and a precondition that might not have landed
  // yet produces failures that look like logic bugs.
  const connection = new Connection(endpoint, 'confirmed')

  const fundedKeypair = async (sol = 10): Promise<Keypair> => {
    const keypair = Keypair.generate()
    const signature = await connection.requestAirdrop(keypair.publicKey, sol * LAMPORTS_PER_SOL)
    const status = await connection.confirmTransaction(signature, 'confirmed')
    if (status.value.err !== null) {
      throw new Error(`Airdrop failed: ${JSON.stringify(status.value.err)}`)
    }
    return keypair
  }

  const payer = await fundedKeypair(100)
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: 'confirmed',
  })

  const assetMint = await createMint(connection, payer, payer.publicKey, null, ASSET_DECIMALS)

  const assetAccount = async (owner: PublicKey, amount = 0n): Promise<PublicKey> => {
    const account = await getOrCreateAssociatedTokenAccount(connection, payer, assetMint, owner)
    if (amount > 0n) {
      await mintTo(connection, payer, assetMint, account.address, payer, amount)
    }
    return account.address
  }

  return { connection, payer, provider, assetMint, fundedKeypair, assetAccount }
}
