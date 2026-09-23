import type { Program } from '@coral-xyz/anchor'
import { createSweepChain } from '@mandate/attestor/chain'
import { type SweepChain, type SweepReport, createSweeper } from '@mandate/attestor/sweep'
import { type DrainCover, createProgram, findConfig } from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type TestEnv,
  asset,
  clusterTimestamp,
  setupTestEnv,
  validatorReachable,
  waitPastClusterTime,
} from './harness'
import {
  type RegisteredProtocol,
  admitQuorumSet,
  attest,
  ensureConfig,
  fundPool,
  issuePolicy,
  openIncident,
  registerProtocol,
  releaseAttestors,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(500_000)
const RETENTION = asset(50_000)
const PREMIUM = asset(4_000)
/** How long the policy that has to lapse before its deadline gets. */
const SHORT_POLICY = 45

/** The same guard as `close_expired_incident.itest.ts`: this suite waits out a window. */
const REFUSE_WINDOW_ABOVE = 180

/**
 * What the sweeper does against a real program, as opposed to against a fake.
 *
 * `sweep.test.ts` already covers every branch of the decision; what only a validator can
 * show is that the transactions it builds are ones the program accepts — the account
 * lists, the `memcmp` the listing rides on, and the order the two instructions have to
 * go in. The three incidents below are the three outcomes: paid out, forfeited, refunded.
 */
describe.skipIf(!reachable)('the expired-incident sweep', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let attestors: Keypair[]
  let chain: SweepChain
  let report: SweepReport
  let poolsBefore: {
    expiring: Awaited<ReturnType<Program<DrainCover>['account']['pool']['fetch']>>
    lapsed: Awaited<ReturnType<Program<DrainCover>['account']['pool']['fetch']>>
  }
  let lapsedOpenerBefore: bigint
  let beneficiaryBefore: bigint

  /** No attestations at all: the plain expiry, and the bond is forfeited. */
  let expiring: { target: RegisteredProtocol; incident: PublicKey; bond: bigint }
  /** Quorum reached, but its policy runs out before anyone settles it. */
  let lapsed: { target: RegisteredProtocol; incident: PublicKey; bond: bigint; opener: PublicKey }
  /** Quorum reached on a policy still in force, and nobody called `resolve`. */
  let payable: { target: RegisteredProtocol; incident: PublicKey; beneficiary: PublicKey }

  const coveredProtocol = async (endTs?: number): Promise<[RegisteredProtocol, number]> => {
    const target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
    const { seq } = await issuePolicy(program, env, target, {
      limit: LIMIT,
      retention: RETENTION,
      premium: PREMIUM,
      ...(endTs === undefined
        ? {}
        : { startTs: (await clusterTimestamp(env.connection)) - 60, endTs }),
    })
    return [target, seq]
  }

  /**
   * The real chain, listing only this file's incidents.
   *
   * Every integration file shares one ledger, and a sweep is global by nature — it
   * would act on whatever earlier files left behind, which makes the report
   * unassertable rather than wrong. The listing itself is the real one, `memcmp` and
   * all; only its output is narrowed, and every write below goes through the
   * production adapter untouched.
   */
  const scopedTo = (targets: RegisteredProtocol[]): SweepChain => {
    const real = createSweepChain({ program, connection: env.connection })
    const ours = new Set(targets.map(({ protocol }) => protocol.toBase58()))
    return {
      ...real,
      listOpenIncidents: async () =>
        (await real.listOpenIncidents()).filter((incident) => ours.has(incident.protocol)),
    }
  }

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)

    const attestWindow = (
      await program.account.config.fetch(findConfig(program.programId))
    ).attestWindow.toNumber()
    if (attestWindow > REFUSE_WINDOW_ABOVE) {
      throw new Error(
        `Config on this validator has an attestation window of ${attestWindow}s, so an incident here would take that long to expire. Restart solana-test-validator with --reset: the config is a singleton and this one predates the window the tests use.`,
      )
    }

    attestors = await admitQuorumSet(program, env)

    const [expiringTarget, expiringPolicy] = await coveredProtocol()
    const expiringOpened = await openIncident(program, env, expiringTarget, expiringPolicy)
    expiring = {
      target: expiringTarget,
      incident: expiringOpened.incident,
      bond: expiringOpened.bond,
    }

    const lapsingEnd = (await clusterTimestamp(env.connection)) + SHORT_POLICY
    const [lapsedTarget, lapsedPolicy] = await coveredProtocol(lapsingEnd)
    const lapsedOpened = await openIncident(program, env, lapsedTarget, lapsedPolicy)
    lapsed = {
      target: lapsedTarget,
      incident: lapsedOpened.incident,
      bond: lapsedOpened.bond,
      opener: lapsedOpened.opener.publicKey,
    }

    const [payableTarget, payablePolicy] = await coveredProtocol()
    const payableOpened = await openIncident(program, env, payableTarget, payablePolicy)
    payable = {
      target: payableTarget,
      incident: payableOpened.incident,
      // `resolve` derives this account and cannot create it, so the beneficiary has to
      // have one before the sweep runs — the same thing `resolve.itest.ts` does.
      beneficiary: await env.assetAccount(payableTarget.treasury),
    }

    for (const attestor of attestors) {
      await attest(program, lapsed.target, lapsed.incident, attestor)
      await attest(program, payable.target, payable.incident, attestor)
    }

    const deadlines = await Promise.all(
      [expiring, lapsed, payable].map(async ({ incident }) =>
        (await program.account.incident.fetch(incident)).deadline.toNumber(),
      ),
    )
    await waitPastClusterTime(env.connection, Math.max(...deadlines))

    chain = scopedTo([expiring.target, lapsed.target, payable.target])

    poolsBefore = {
      expiring: await program.account.pool.fetch(expiring.target.pool),
      lapsed: await program.account.pool.fetch(lapsed.target.pool),
    }
    lapsedOpenerBefore = (await getAccount(env.connection, await env.assetAccount(lapsed.opener)))
      .amount
    beneficiaryBefore = (await getAccount(env.connection, payable.beneficiary)).amount

    // The cluster's clock, not this machine's: the deadlines came from the cluster, and
    // a sweeper judging by a drifting local clock would be testing the drift.
    const at = await clusterTimestamp(env.connection)
    report = await createSweeper({ chain, now: () => at }).sweepOnce()
  }, 240_000)

  afterAll(async () => {
    if (attestors !== undefined) await releaseAttestors(program, env, attestors)
  })

  it('finds the three incidents and acts on each of them', () => {
    expect(report.scanned).toBe(3)
    expect(report.resolved).toEqual([payable.incident.toBase58()])
    expect(report.closed).toHaveLength(2)
    expect(report.failed).toEqual([])
    expect(report.blocked).toEqual([])
  })

  // Nobody called `resolve` after the quorum was reached — the case `act.ts` logs and
  // walks away from. Without the sweep this incident closes with no payout at its
  // deadline: decision taken, money not sent.
  it('pays out a quorum that nobody settled', async () => {
    const incident = await program.account.incident.fetch(payable.incident)

    expect(incident.status).toHaveProperty('paidOut')
    expect(incident.payout.toString()).toBe((LIMIT - RETENTION).toString())
    expect((await getAccount(env.connection, payable.beneficiary)).amount).toBe(
      beneficiaryBefore + (LIMIT - RETENTION),
    )
  })

  it('closes an incident the window left behind and forfeits its bond to the pool', async () => {
    const incident = await program.account.incident.fetch(expiring.incident)
    const pool = await program.account.pool.fetch(expiring.target.pool)

    expect(incident.status).toHaveProperty('closedNoPayout')
    expect(pool.openIncidents).toBe(poolsBefore.expiring.openIncidents - 1)
    // The bond was in the vault all along, outside `total_assets`; counting it in is
    // the whole of forfeiting it.
    expect(pool.totalAssets.toString()).toBe(
      (BigInt(poolsBefore.expiring.totalAssets.toString()) + expiring.bond).toString(),
    )
  })

  // Confirmed by the set, so the bond was not a groundless claim — but the policy ran
  // out before anyone settled it, so `resolve` refuses it (FR-016) and this is the only
  // thing that can release the pool's reservation.
  it('closes a confirmed incident whose policy lapsed, and returns its bond', async () => {
    const incident = await program.account.incident.fetch(lapsed.incident)
    const pool = await program.account.pool.fetch(lapsed.target.pool)

    expect(incident.status).toHaveProperty('closedNoPayout')
    expect(pool.openIncidents).toBe(poolsBefore.lapsed.openIncidents - 1)
    expect(pool.totalAssets.toString()).toBe(poolsBefore.lapsed.totalAssets.toString())
    expect((await getAccount(env.connection, await env.assetAccount(lapsed.opener))).amount).toBe(
      lapsedOpenerBefore + lapsed.bond,
    )
  })

  it('leaves an incident whose window is still open', async () => {
    const [target, policySeq] = await coveredProtocol()
    const { incident } = await openIncident(program, env, target, policySeq)
    const at = await clusterTimestamp(env.connection)

    const pass = await createSweeper({ chain: scopedTo([target]), now: () => at }).sweepOnce()

    expect(pass.waiting).toBe(1)
    expect(pass.closed).toEqual([])
    expect(await program.account.incident.fetch(incident)).toHaveProperty('status.open')
  })

  // A sweeper runs on a timer and every attestor may run one, so a pass over incidents
  // that are already settled has to be a no-op rather than a fee spent per pass.
  it('finds nothing left to do on a second pass', async () => {
    const at = await clusterTimestamp(env.connection)

    const second = await createSweeper({ chain, now: () => at }).sweepOnce()

    expect(second.scanned).toBe(0)
    expect(second.resolved).toEqual([])
    expect(second.closed).toEqual([])
  })
})
