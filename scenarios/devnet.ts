// The devnet counterpart of `tests/harness.ts`.
//
// A separate file, not a flag on that one, and deliberately so: `harness.ts` airdrops
// 500 SOL and refuses any endpoint that is not loopback (`assertLocalEndpoint`). Both
// are correct for a test world and both are impossible here — devnet SOL is bought by
// hand, and the ledger is shared, permanent and full of other people's state. Loosening
// the guard would have made every integration test one environment variable away from
// running against a real cluster.
//
// What this file does provide is the same `TestEnv` shape, so every helper in
// `tests/world.ts` works against devnet unchanged.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AnchorProvider, Wallet } from '@coral-xyz/anchor'
import { ASSET_DECIMALS, type TestEnv } from '@mandate/tests/harness'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * `.env` is parsed here rather than through a dependency or `node --env-file`.
 *
 * Ten lines against one more package, and the runtime flag would have had to be
 * repeated in every script that ever touches devnet. The absence of `SOLANA_RPC_URL`
 * also has to produce a sentence rather than a stack trace: pointed at the public
 * endpoint by accident, this whole file fails as rate limiting, which reads like
 * anything but a missing variable.
 */
const readEnvFile = (): Map<string, string> => {
  const path = join(REPO_ROOT, '.env')
  const values = new Map<string, string>()
  if (!existsSync(path)) return values

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim())
  }
  return values
}

/**
 * The WebSocket endpoint, given explicitly rather than derived.
 *
 * `Connection` builds one by swapping the scheme and the port, which drops the query
 * string — and on a provider that carries the API key there, that produces a socket
 * that never connects. The watcher then falls back to polling and keeps working, so
 * nothing fails: SC-001 just measures the poll interval instead of the system, which
 * is the kind of wrong number that gets believed.
 */
export const devnetWsUrl = (): string | undefined =>
  process.env.SOLANA_WS_URL || readEnvFile().get('SOLANA_WS_URL') || undefined

export const devnetRpcUrl = (): string => {
  const url = process.env.SOLANA_RPC_URL || readEnvFile().get('SOLANA_RPC_URL')
  if (!url) {
    throw new Error(
      'SOLANA_RPC_URL is not set. Put a devnet RPC URL in .env — the public endpoint rate-limits hard enough that this script fails in ways that look like bugs. See docs/deploy-devnet.md → Крок 3.',
    )
  }
  const host = new URL(url).hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    throw new Error(
      `SOLANA_RPC_URL points at ${host}. This script is for devnet; the local validator is what tests/harness.ts is for.`,
    )
  }
  return url
}

/**
 * Where the keys live — outside the repository, always.
 *
 * The program keypair, the deploy payer and everything created here share one
 * directory so that «back up the deployment» is one directory to copy rather than a
 * scavenger hunt. Overridable because the default is a Windows-shaped guess.
 */
export const keysDir = (): string =>
  process.env.MANDATE_KEYS_DIR || join(homedir(), '.secrets', 'mandate')

const keypairFromFile = (path: string): Keypair => {
  if (!existsSync(path)) {
    throw new Error(
      `No keypair at ${path}. The devnet deploy payer is created and backed up in T063 — see docs/deploy-devnet.md → Ключі.`,
    )
  }
  const bytes: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(bytes)) throw new Error(`${path} is not a Solana CLI keypair file.`)
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]))
}

/** The deploy payer, which is also the upgrade authority and `Config.admin`. */
export const deployerKeypair = (): Keypair =>
  keypairFromFile(join(keysDir(), 'devnet-deployer.json'))

/**
 * What survives between runs.
 *
 * The measurement of SC-001 cannot happen in the session that sets devnet up: an
 * attestor admitted in one epoch votes from the next (FR-008), and a devnet epoch is
 * about thirty-two hours. So the attestors' keys, and the mint `Config` married itself
 * to, have to outlive the process that made them.
 */
export interface DevnetState {
  /** Fixed inside `Config` forever at creation (FR-014). */
  assetMint: string
  /** Secret keys, base64. Devnet only, and outside the repository. */
  attestors: string[]
}

const statePath = (): string => join(keysDir(), 'devnet-state.json')

export const readState = (): DevnetState | null => {
  const path = statePath()
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as DevnetState
}

export const writeState = (state: DevnetState): void => {
  const directory = keysDir()
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export const encodeKeypair = (keypair: Keypair): string =>
  Buffer.from(keypair.secretKey).toString('base64')

export const decodeKeypair = (encoded: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(Buffer.from(encoded, 'base64')))

/**
 * Spaces outgoing RPC calls so the provider never has to refuse one.
 *
 * A free tier caps requests per second, and `@solana/web3.js` answers a refusal by
 * retrying with backoff and then, after a few tries, throwing — which kills a run
 * that is minutes deep. Being refused is also strictly worse than waiting: each 429
 * costs the retry delay *and* the round trip that earned it.
 *
 * A leaky bucket over dispatch, not over completion: rate limits are counted on
 * requests arriving, so delaying when a call goes out is the whole of it, and nothing
 * here has to serialise responses.
 */
const spacedDispatch = (minIntervalMs: number) => {
  let nextAt = 0
  return (dispatch: () => void): void => {
    const now = Date.now()
    const at = Math.max(now, nextAt)
    nextAt = at + minIntervalMs
    if (at === now) dispatch()
    else setTimeout(dispatch, at - now)
  }
}

/** Eight per second, against the ten a free tier typically allows. */
const RPC_MIN_INTERVAL_MS = 125

/**
 * Retries anything that failed for a reason the cluster is likely to stop having.
 *
 * Used around this script's *own* calls only. The attestors' calls are deliberately
 * left alone: they are the system under measurement, and wrapping them in retries this
 * script invented would report a resilience the product does not have.
 */
export const withRetry = async <T>(operation: () => Promise<T>, attempts = 5): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
    }
  }
  throw lastError
}

/**
 * How long a slot actually takes on this cluster, measured rather than assumed.
 *
 * The 400ms target is not what devnet does — it has been running nearer 0.27s, which
 * turns «when does the next epoch start» into an answer that is off by half a day if
 * the constant is used instead. Every wait in a devnet script is long enough that
 * being wrong about it wastes a session.
 */
export const secondsPerSlot = async (connection: Connection): Promise<number> => {
  const samples = await connection.getRecentPerformanceSamples(30)
  const slots = samples.reduce((total, sample) => total + sample.numSlots, 0)
  const seconds = samples.reduce((total, sample) => total + sample.samplePeriodSecs, 0)
  // Falls back to the target rather than dividing by zero: an RPC that returns no
  // samples is a reason to be approximate, not to fail.
  return slots > 0 ? seconds / slots : 0.4
}

/**
 * What a helper account is given, whatever the caller asked for.
 *
 * `tests/world.ts` asks for one or two SOL per protocol authority and per incident
 * opener. On a validator that is free; here eleven staged protocols would be twenty-two
 * SOL, against a balance that was transferred in by hand.
 *
 * What such an account actually spends: a protocol authority pays rent for the
 * declaration entries it files (~0.0016 each) and the fees to file them, and most of
 * them file none at all. Fifteen thousandths is several times the worst case and still
 * an order of magnitude below what the callers ask for.
 */
const HELPER_SOL = 0.015

export const setupDevnetEnv = async (): Promise<TestEnv> => {
  const endpoint = devnetRpcUrl()

  // `confirmed` everywhere, including preflight: on a shared cluster a simulation run
  // against a slot that has not caught up rejects transactions whose accounts exist,
  // and that failure is indistinguishable from a real constraint violation.
  const ws = devnetWsUrl()
  const dispatch = spacedDispatch(RPC_MIN_INTERVAL_MS)
  const connection = new Connection(endpoint, {
    commitment: 'confirmed',
    fetchMiddleware: (info, init, next) => {
      dispatch(() => {
        next(info, init)
      })
    },
    ...(ws === undefined ? {} : { wsEndpoint: ws }),
  })
  const payer = deployerKeypair()

  const balance = await connection.getBalance(payer.publicKey)
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    throw new Error(
      `The devnet payer ${payer.publicKey.toBase58()} holds ${balance / LAMPORTS_PER_SOL} SOL. Devnet faucets cap out well below what this needs (docs/deploy-devnet.md → Крок 3) — top it up by hand.`,
    )
  }

  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  })

  const fund = async (recipient: PublicKey, sol: number): Promise<void> => {
    const lamports = Math.round(sol * LAMPORTS_PER_SOL)
    const existing = await connection.getBalance(recipient)
    // Idempotent on purpose: the setup script is meant to be safe to re-run after a
    // devnet hiccup, and topping an account up twice is how a run ends short of SOL.
    if (existing >= lamports) return

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports: lamports - existing,
        }),
      ),
      [payer],
      { commitment: 'confirmed' },
    )
  }

  const fundedKeypair = async (_sol = HELPER_SOL): Promise<Keypair> => {
    const keypair = Keypair.generate()
    await fund(keypair.publicKey, HELPER_SOL)
    return keypair
  }

  const state = readState()
  let assetMint: PublicKey
  if (state !== null) {
    assetMint = new PublicKey(state.assetMint)
    if ((await connection.getAccountInfo(assetMint)) === null) {
      throw new Error(
        `devnet-state.json names mint ${state.assetMint}, which does not exist on this cluster. Either the state file belongs to another deployment or it was written against a different RPC.`,
      )
    }
  } else {
    // Created once and recorded before anything else can reference it: `Config` fixes
    // `asset_mint` forever, so a mint that exists but was not written down is a
    // deployment nobody can fund.
    assetMint = await createMint(connection, payer, payer.publicKey, null, ASSET_DECIMALS)
    writeState({ assetMint: assetMint.toBase58(), attestors: [] })
  }

  // Both calls are this script's own scaffolding, so they get the retry (see
  // `withRetry`). What they fail with under a rate limit is «Blockhash not found»:
  // web3.js backs off on every 429 and, by the time the send gets through, the
  // blockhash it was built on has expired. A fresh call builds a fresh transaction.
  const assetAccount = async (owner: PublicKey, amount = 0n): Promise<PublicKey> => {
    const account = await withRetry(() =>
      getOrCreateAssociatedTokenAccount(connection, payer, assetMint, owner, true, 'confirmed'),
    )
    if (amount > 0n) {
      await withRetry(() =>
        mintTo(connection, payer, assetMint, account.address, payer, amount, [], {
          commitment: 'confirmed',
        }),
      )
    }
    return account.address
  }

  return { connection, payer, provider, assetMint, fundedKeypair, assetAccount, fund }
}
