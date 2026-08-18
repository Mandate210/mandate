// T029 — the two numbers M1 owes, measured on devnet rather than on a validator.
//
//   pnpm --filter @drain-cover/scenarios devnet:measure
//
// Needs `devnet:setup` to have run at least one epoch earlier: FR-008 admits an attestor
// into the set from the *following* epoch, and a devnet epoch is about thirty-two hours.
// This script checks that and says so rather than producing a run where nobody can vote.
//
// **SC-001** — from the confirmation of an unauthorized privileged transaction to the
// initiation of the payout, p95 ≤ 30s. Measured between two block times: the trigger
// transaction's and the `resolve` transaction's. Block times are cluster facts anybody
// can read back from an explorer, where a stopwatch in this process would also be
// measuring how fast this laptop polls.
//
// **SC-008** — total fees for carrying one incident from opening to payout, ≤ 1 USD.
// T064 measured this on a validator, where a fee is only ever the base signature fee.
// Devnet prices blockspace, so this run reports what was actually paid **and** what the
// same incident would cost at the prioritization fee the cluster is currently quoting.
//
// **Why the whole cycle runs through real workers.** SC-001 is a claim about the system,
// not about the program: the clock starts when the offending transaction confirms, and
// most of what happens next is an attestor noticing it. A script that opened the
// incident itself would measure the program and report it as the product.

import { AnchorProvider, BN, type Program, Wallet } from '@coral-xyz/anchor'
import { createActor } from '@drain-cover/attestor/act'
import { createChain } from '@drain-cover/attestor/chain'
import { type WatchedAddress, connectionWatchRpc, createWatcher } from '@drain-cover/attestor/watch'
import {
  type DrainCover,
  createProgram,
  findAttestor,
  findConfig,
  findIncident,
} from '@drain-cover/sdk'
import { base58Decode } from '@drain-cover/shared'
import { type TestEnv, asset } from '@drain-cover/tests/harness'
import { fundPool, issuePolicy, registerProtocol } from '@drain-cover/tests/world'
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  createTransferInstruction,
  mintTo,
} from '@solana/spl-token'
import { Keypair, type PublicKey } from '@solana/web3.js'
import { UNIT, sendWith } from './compromises'
import { decodeKeypair, readState, secondsPerSlot, setupDevnetEnv, withRetry } from './devnet'

/** SC-001. */
const LATENCY_BUDGET_SECONDS = 30
/** SC-008, at the same reference price T064 used. */
const SOL_PRICE_USD = 200
const LAMPORTS_PER_SOL = 1_000_000_000
const FEE_BUDGET_LAMPORTS = LAMPORTS_PER_SOL / SOL_PRICE_USD

/**
 * Samples. Twenty, because p95 of fewer is just the maximum wearing a percentile's
 * name — at twenty the ninety-fifth percentile is the second-slowest run, which is a
 * statement about the tail rather than about one unlucky sample.
 */
const SAMPLES = Number(process.env.DEVNET_SAMPLES ?? 20)

/** Long enough that a sample which fails is a failure and not an impatient script:
 * six times the budget it is being measured against. */
const SAMPLE_TIMEOUT_SECONDS = 180

const POOL_CAPITAL = asset(1_000_000)
const POLICY_LIMIT = asset(10_000)
const POLICY_RETENTION = asset(500)
const POLICY_PREMIUM = asset(100)

const say = (message: string): void => {
  console.log(message)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const quiet = {
  info: () => {},
  warn: () => {},
  error: (fields: Record<string, unknown>, message: string) => {
    console.error(`\n  ! ${message}`, fields.error)
  },
}

interface Sample {
  index: number
  triggerSignature: string
  /** Cluster time the offending transaction landed. */
  triggeredAt: number
  /** Cluster time `resolve` landed. */
  paidAt: number
  /** What this process saw on its own clock, as a cross-check on the block times. */
  wallSeconds: number
  incident: PublicKey
}

/**
 * The percentile the criterion is written in, computed the way a reader would check it:
 * sort, take the ceil(0.95·n)-th. Nearest-rank rather than interpolated — an
 * interpolated p95 reports a latency no sample actually had.
 */
const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[rank - 1] ?? Number.NaN
}

/** Every transaction that ever touched this incident account — its whole life cycle. */
const feesFor = async (env: TestEnv, incident: PublicKey): Promise<number> => {
  const signatures = await withRetry(() =>
    env.connection.getSignaturesForAddress(incident, { limit: 100 }),
  )
  let total = 0
  for (const { signature } of signatures) {
    const transaction = await withRetry(() =>
      env.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }),
    )
    total += transaction?.meta?.fee ?? 0
  }
  return total
}

const main = async (): Promise<void> => {
  const env = await setupDevnetEnv()
  const program = createProgram(env.provider)

  say('drain-cover — devnet measurement (T029)\n')

  const state = readState()
  if (state === null || state.attestors.length === 0) {
    throw new Error('No devnet-state.json with attestors. Run devnet:setup first.')
  }
  const config = await program.account.config.fetchNullable(findConfig(program.programId))
  if (config === null) throw new Error('No Config on this cluster. Run devnet:setup first.')

  // ── Can anybody vote yet ──────────────────────────────────────────────────────
  const attestorKeys = state.attestors.map(decodeKeypair)
  const { epoch } = await env.connection.getEpochInfo()
  const memberships = await program.account.attestor.fetchMultiple(
    attestorKeys.map((attestor) => findAttestor(program.programId, attestor.publicKey)),
  )
  const active = memberships.filter(
    (attestor) => attestor?.inSet && attestor.activeFromEpoch.toNumber() <= epoch,
  ).length
  const needed = Math.ceil((config.attestorCount * config.quorumBps) / 10_000)

  if (active < needed) {
    const info = await env.connection.getEpochInfo()
    const hours =
      ((info.slotsInEpoch - info.slotIndex) * (await secondsPerSlot(env.connection))) / 3_600
    throw new Error(
      `Only ${active} of ${attestorKeys.length} attestors can vote in epoch ${epoch}, and a quorum of the set of ${config.attestorCount} needs ${needed}. FR-008 admits an attestor from the epoch after the one it was admitted in, and this epoch has about ${hours.toFixed(1)}h to run. Nothing to fix — wait.`,
    )
  }
  say(`epoch ${epoch}: ${active} attestors can vote, quorum needs ${needed} of ${config.attestorCount}\n`)

  // ── Stage ─────────────────────────────────────────────────────────────────────
  //
  // One protocol carrying `SAMPLES` policies, not one protocol per sample. A policy
  // whose limit is fully paid becomes `Exhausted`, and `findPolicyInForce` skips it, so
  // the workers walk the policies in order without being told to. That saves a protocol,
  // a pool and a vault per sample — on devnet those are rent nobody gets back.
  say('staging one protocol, its pool and its policies…')
  const privileged = Keypair.generate()
  const attacker = Keypair.generate()

  const target = await registerProtocol(program, env, [privileged.publicKey])
  await fundPool(program, env, target, POOL_CAPITAL)
  for (let index = 0; index < SAMPLES; index += 1) {
    await issuePolicy(program, env, target, {
      limit: POLICY_LIMIT,
      retention: POLICY_RETENTION,
      premium: POLICY_PREMIUM,
    })
  }
  // `resolve` pays the beneficiary and cannot create its account.
  await env.assetAccount(target.treasury)

  // The protocol's own token, with the privileged address as its authority — the thing
  // a compromised admin key would reach for.
  const token = await createMint(env.connection, env.payer, privileged.publicKey, null, 6)
  const treasury = await createAssociatedTokenAccountIdempotent(
    env.connection,
    env.payer,
    token,
    privileged.publicKey,
    { commitment: 'confirmed' },
  )
  const pocket = await createAssociatedTokenAccountIdempotent(
    env.connection,
    env.payer,
    token,
    attacker.publicKey,
    { commitment: 'confirmed' },
  )
  await mintTo(
    env.connection,
    env.payer,
    token,
    treasury,
    privileged,
    BigInt(SAMPLES + 5) * BigInt(1_000) * BigInt(UNIT),
    [],
    { commitment: 'confirmed' },
  )
  // The privileged key signs its own transfers and pays for them.
  await env.fund(privileged.publicKey, 0.05)
  say(`  protocol ${target.protocol.toBase58()}`)
  say(`  ${SAMPLES} policies, privileged address ${privileged.publicKey.toBase58()}\n`)

  // ── Workers ───────────────────────────────────────────────────────────────────
  const watched: WatchedAddress[] = [
    { protocol: target.protocol.toBase58(), address: privileged.publicKey.toBase58() },
  ]
  const watchers = attestorKeys.map((attestor) => {
    const provider = new AnchorProvider(env.connection, new Wallet(attestor), {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    })
    const actor = createActor({
      chain: createChain({
        program: createProgram(provider),
        connection: env.connection,
        attestor,
      }),
      logger: quiet,
    })
    return createWatcher({
      rpc: connectionWatchRpc(env.connection),
      watched,
      logger: quiet,
      // No lookback: everything above is scaffolding, and an attestor that judged the
      // staging would be judging this script rather than a compromise.
      policy: { startupLookbackSeconds: 0, reconcileSeconds: 20, pollSeconds: 5 },
      onTransaction: (transaction) => actor.act(transaction).then(() => undefined),
    })
  })

  await sleep(3_000)
  for (const watcher of watchers) await watcher.start()
  say(`${watchers.length} attestor workers watching\n`)

  // ── Measure ───────────────────────────────────────────────────────────────────
  const samples: Sample[] = []
  const failures: string[] = []

  for (let index = 0; index < SAMPLES; index += 1) {
    process.stdout.write(`  sample ${String(index + 1).padStart(2)}/${SAMPLES}  `)

    // Read before firing, so the wait knows which account to watch without asking the
    // cluster to search for it. Racing workers can only push this higher, never lower,
    // and the trigger signature is verified on arrival either way.
    const incidentSeq = (
      await withRetry(() => program.account.protocol.fetch(target.protocol))
    ).nextIncidentSeq.toNumber()

    // A different amount every time: two identical transfers inside one blockhash would
    // be the same transaction, and the second would be rejected as a duplicate.
    const signature = await sendWith(
      env.connection,
      env.payer,
      [
        createTransferInstruction(
          treasury,
          pocket,
          privileged.publicKey,
          (100 + index) * UNIT,
        ),
      ],
      [privileged],
    )

    const settled = await awaitPayout(program, env, target.protocol, signature, incidentSeq)
    if (settled === null) {
      failures.push(`sample ${index + 1} (${signature.slice(0, 12)}…) never paid out`)
      say('NOT SETTLED')
      continue
    }

    samples.push({ index, triggerSignature: signature, ...settled })
    say(
      `${(settled.paidAt - settled.triggeredAt).toFixed(0)}s on chain, ${settled.wallSeconds.toFixed(1)}s observed`,
    )
    // A breath between samples. Not pacing for its own sake: the workers are still
    // finishing the last incident's `resolve` when this loop is ready to fire again,
    // and firing into that would measure two overlapping cycles as one.
    await sleep(1_500)
  }

  for (const watcher of watchers) await watcher.stop()

  if (samples.length === 0) {
    console.error('\nNo sample settled — nothing to measure.')
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }

  // ── SC-001 ────────────────────────────────────────────────────────────────────
  const latencies = samples.map((sample) => sample.paidAt - sample.triggeredAt)
  const p95 = percentile(latencies, 0.95)
  const median = percentile(latencies, 0.5)

  // ── SC-008 ────────────────────────────────────────────────────────────────────
  const fees = await Promise.all(samples.map((sample) => feesFor(env, sample.incident)))
  const worstFee = Math.max(...fees)
  const medianFee = percentile(fees, 0.5)

  // What the same incident would cost if it had to bid for blockspace. Quoted by the
  // cluster for the accounts this incident actually writes to, which is what a
  // prioritization fee is priced against.
  const quotes = await env.connection.getRecentPrioritizationFees({
    lockedWritableAccounts: [target.pool, target.vault],
  })
  const microLamportsPerCu =
    quotes.length === 0
      ? 0
      : percentile(quotes.map((quote) => quote.prioritizationFee), 0.95)
  // Seven transactions carry an incident (T064), and 200k CU is the ceiling a client
  // would request for one of ours.
  const priorityLamports = Math.round((microLamportsPerCu * 200_000 * 7) / 1_000_000)

  const usd = (lamports: number): string => ((lamports / LAMPORTS_PER_SOL) * SOL_PRICE_USD).toFixed(4)

  say('\n────────────────────────────────────────────────')
  say(`samples          ${samples.length} settled of ${SAMPLES}`)
  say(`SC-001  p95      ${p95}s            (needs ≤ ${LATENCY_BUDGET_SECONDS}s)`)
  say(`        median   ${median}s`)
  say(`        range    ${Math.min(...latencies)}s … ${Math.max(...latencies)}s`)
  say(`SC-008  worst    ${worstFee} lamports = $${usd(worstFee)}   (needs ≤ $1.00)`)
  say(`        median   ${medianFee} lamports = $${usd(medianFee)}`)
  say(`        priority ${priorityLamports} lamports = $${usd(priorityLamports)} at ${microLamportsPerCu} µlamports/CU (p95 quoted)`)
  say(`        together $${usd(worstFee + priorityLamports)}`)
  say('────────────────────────────────────────────────')

  const verdicts: string[] = []
  if (samples.length < SAMPLES) {
    verdicts.push(`${SAMPLES - samples.length} of ${SAMPLES} samples never settled`)
    for (const failure of failures) verdicts.push(`  ${failure}`)
  }
  if (p95 > LATENCY_BUDGET_SECONDS) {
    verdicts.push(`SC-001: p95 ${p95}s over the ${LATENCY_BUDGET_SECONDS}s budget`)
  }
  if (worstFee + priorityLamports > FEE_BUDGET_LAMPORTS) {
    verdicts.push(`SC-008: $${usd(worstFee + priorityLamports)} per incident over the $1.00 budget`)
  }

  say('')
  say('first sample on chain:')
  const first = samples[0]
  if (first !== undefined) {
    say(`  trigger  https://explorer.solana.com/tx/${first.triggerSignature}?cluster=devnet`)
    say(`  incident https://explorer.solana.com/address/${first.incident.toBase58()}?cluster=devnet`)
  }

  if (verdicts.length > 0) {
    say('')
    for (const verdict of verdicts) console.error(`FAILED  ${verdict}`)
    process.exit(1)
  }
  say('\nboth criteria met.')
  process.exit(0)
}

/**
 * Waits for the incident this transaction raised to pay out, and reports when — in
 * cluster time.
 *
 * **The incident is addressed, not searched for.** The obvious way to find it is a
 * `memcmp` on the stored trigger signature, which is what the attestor itself does —
 * but that is `getProgramAccounts`, the most expensive call a provider meters, and
 * polling it every second is what killed the first run of this script. Worse than the
 * crash: the quota it burned was the quota the attestors needed, so the script was
 * slowing down the very thing it was timing.
 *
 * The sequence number is known instead, read off the protocol before the transaction
 * was fired, which turns the wait into a single-account fetch. The signature is still
 * checked on arrival — an incident at the expected sequence raised by something else
 * would otherwise be recorded as this sample's.
 */
const awaitPayout = async (
  program: Program<DrainCover>,
  env: TestEnv,
  protocol: PublicKey,
  signature: string,
  incidentSeq: number,
): Promise<{ triggeredAt: number; paidAt: number; wallSeconds: number; incident: PublicKey } | null> => {
  const started = Date.now()
  const trigger = await withRetry(() =>
    env.connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    }),
  )
  const triggeredAt = trigger?.blockTime ?? 0
  if (triggeredAt === 0) return null

  const incident = findIncident(program.programId, protocol, incidentSeq)
  const expected = base58Decode(signature)

  for (;;) {
    const account = await withRetry(() => program.account.incident.fetchNullable(incident))

    if (account !== null && 'paidOut' in account.status) {
      const raisedBy = [...account.triggerSig]
      if (raisedBy.length !== expected.length || raisedBy.some((byte, at) => byte !== expected[at])) {
        return null
      }
      // The newest transaction touching the incident is the `resolve` that paid it:
      // nothing can follow a payout.
      const [latest] = await withRetry(() =>
        env.connection.getSignaturesForAddress(incident, { limit: 1 }),
      )
      const paidAt = latest?.blockTime ?? 0
      if (paidAt === 0) return null
      return {
        triggeredAt,
        paidAt,
        wallSeconds: (Date.now() - started) / 1_000,
        incident,
      }
    }
    if (Date.now() - started > SAMPLE_TIMEOUT_SECONDS * 1_000) return null
    await sleep(2_000)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
