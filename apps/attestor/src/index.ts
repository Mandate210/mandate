// Attestor worker: watch privileged addresses, compare each privileged transaction
// against the effective declaration, open an incident and attest (T026, T027).
//
// In production every attestor is run by an independent party — this binary holds
// exactly one key. Running several instances locally is how the demo produces a quorum
// (docs/PLAN.md → Межа P1).
//
// Assembly only: what to watch is `watch.ts`, what it means is `packages/shared`, what
// to do about it is `act.ts`, and how to say it on chain is `chain.ts`. Nothing here
// decides anything, which is the point — an attestor that made judgements in its wiring
// would be an attestor nobody could reproduce.

import { AnchorProvider, Wallet } from '@coral-xyz/anchor'
import { createProgram } from '@mandate/sdk'
import { base58Decode } from '@mandate/shared'
import { Connection, Keypair } from '@solana/web3.js'
import pino from 'pino'
import { createActor } from './act'
import { createChain, createSweepChain } from './chain'
import { buildReport, serveHeartbeat } from './heartbeat'
import { DEFAULT_SWEEP_INTERVAL_SECONDS, createSweeper } from './sweep'
import {
  DEFAULT_WATCH_POLICY,
  type WatchPolicy,
  type WatchedAddress,
  connectionWatchRpc,
  createWatcher,
} from './watch'

const logger = pino({ name: 'attestor' })

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

const seconds = (name: string): number | undefined => {
  const value = process.env[name]
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} is not a positive number`)
  return parsed
}

/**
 * How often to sweep expired incidents, in seconds. `0` turns the sweep off.
 *
 * Off is a real choice, unlike the rest of the worker: sweeping is permissionless
 * housekeeping that any party can do, so an operator running several attestors on one
 * machine has no reason to have all of them doing it. It is on by default because the
 * alternative — assuming somebody else will — is exactly how 17 incidents came to sit
 * open on devnet holding pool capital (T071).
 */
const sweepInterval = (): number => {
  const value = process.env.ATTESTOR_SWEEP_SECONDS
  if (value === undefined || value === '') return DEFAULT_SWEEP_INTERVAL_SECONDS
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('ATTESTOR_SWEEP_SECONDS is not a non-negative number')
  }
  return parsed
}

/**
 * Port of the heartbeat (T069), or none. Unset means no server, which is right for a
 * local run of several attestors and wrong for a hosted one — `api` then reports it
 * `unreachable`, which is how a forgotten port gets noticed.
 */
const heartbeatPort = (): number | undefined => {
  const value = process.env.ATTESTOR_HEALTH_PORT
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('ATTESTOR_HEALTH_PORT is not a port number')
  }
  return parsed
}

/**
 * Base58 secret key from the environment, never a path.
 *
 * A keypair file inside the repository is one `git add -A` away from being published,
 * which is why `*.keypair.json` and `id.json` are blocked by the pre-commit guard and
 * why this reads no files at all (`docs/PLAN.md` → Безпека).
 */
const loadAttestor = (): Keypair => {
  const bytes = base58Decode(required('ATTESTOR_KEYPAIR'))
  if (bytes.length !== 64) {
    throw new Error(`ATTESTOR_KEYPAIR must be a base58 secret key of 64 bytes, got ${bytes.length}`)
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes))
}

/**
 * Every privileged address of every registered protocol, read from the chain.
 *
 * Read once at startup: a protocol registered afterwards is picked up by the next
 * restart. Rescanning on a timer is a `packages/db` concern in P2, and until there is
 * more than a handful of protocols the restart is the cheaper answer.
 */
const watchedAddresses = async (
  program: ReturnType<typeof createProgram>,
): Promise<WatchedAddress[]> => {
  const protocols = await program.account.protocol.all()
  return protocols.flatMap(({ publicKey, account }) =>
    account.privileged.map((address) => ({
      protocol: publicKey.toBase58(),
      address: address.toBase58(),
    })),
  )
}

const main = async (): Promise<void> => {
  const attestor = loadAttestor()
  const connection = new Connection(required('SOLANA_RPC_URL'), {
    commitment: 'confirmed',
    ...(process.env.SOLANA_WS_URL ? { wsEndpoint: process.env.SOLANA_WS_URL } : {}),
  })
  const program = createProgram(
    new AnchorProvider(connection, new Wallet(attestor), { commitment: 'confirmed' }),
  )

  const watched = await watchedAddresses(program)
  if (watched.length === 0) {
    logger.warn({}, 'no registered protocol has a privileged address; nothing to watch')
  }

  const actor = createActor({ chain: createChain({ program, connection, attestor }), logger })

  const pollSeconds = seconds('ATTESTOR_FALLBACK_POLL_SECONDS')
  const reconcileSeconds = seconds('ATTESTOR_RECONCILE_SECONDS')
  const startupLookbackSeconds = seconds('ATTESTOR_STARTUP_LOOKBACK_SECONDS')

  // Resolved here rather than inside the watcher, so the heartbeat reports the policy the
  // attestor actually runs and `api` judges it by that.
  const policy: WatchPolicy = {
    ...DEFAULT_WATCH_POLICY,
    ...(pollSeconds === undefined ? {} : { pollSeconds }),
    ...(reconcileSeconds === undefined ? {} : { reconcileSeconds }),
    ...(startupLookbackSeconds === undefined ? {} : { startupLookbackSeconds }),
  }

  const watcher = createWatcher({
    rpc: connectionWatchRpc(connection),
    watched,
    logger,
    policy,
    onTransaction: async (transaction) => {
      const outcome = await actor.act(transaction)
      logger.info({ signature: transaction.signature, ...outcome }, 'handled')
    },
  })

  // Housekeeping, not attestation: `close_expired_incident` and `release_expired_policy` take no
  // signer, and this worker runs them only because it is the process that already has
  // a key, an RPC and a program client (T071, FR-011, FR-019).
  const intervalSeconds = sweepInterval()
  const sweeper =
    intervalSeconds === 0
      ? null
      : createSweeper({
          chain: createSweepChain({ program, connection }),
          logger,
          intervalSeconds,
        })

  // Before the watcher starts, so the startup sweep shows as `starting` rather than as
  // an attestor that does not answer at all.
  const port = heartbeatPort()
  const heartbeat =
    port === undefined
      ? null
      : await serveHeartbeat({
          port,
          ...(process.env.ATTESTOR_HEALTH_HOST ? { host: process.env.ATTESTOR_HEALTH_HOST } : {}),
          report: () =>
            buildReport({
              attestor: attestor.publicKey.toBase58(),
              health: watcher.health(),
              policy,
              now: Date.now(),
            }),
        })
  if (heartbeat) logger.info({ address: heartbeat.address() }, 'heartbeat listening')

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'stopping')
    heartbeat?.close()
    sweeper?.stop()
    watcher
      .stop()
      .catch((error: unknown) => logger.error({ error }, 'failed to stop cleanly'))
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  logger.info(
    { attestor: attestor.publicKey.toBase58(), addresses: watched.length },
    'attestor started',
  )
  await watcher.start()
  // After the watcher: a compromise happening right now matters more than an incident
  // that has been sitting expired for hours.
  await sweeper?.start()
}

main().catch((error: unknown) => {
  logger.error({ error }, 'attestor failed to start')
  process.exit(1)
})
