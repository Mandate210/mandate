import { AnchorError, type Program } from '@coral-xyz/anchor'
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
  closeExpiredIncident,
  ensureConfig,
  fundPool,
  issuePolicy,
  openIncident,
  registerProtocol,
  releaseAttestors,
  resolve,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(500_000)
const RETENTION = asset(50_000)
const PREMIUM = asset(4_000)
/** How long the policy that has to lapse before its deadline gets. */
const SHORT_POLICY = 45

/**
 * The only suite that waits out a deadline, so it is the only one that cares how long
 * `Config.attest_window` is — and `Config` is a singleton that outlives a test run.
 * Longer than this and the wait below would look like a hang, so say what it is.
 */
const REFUSE_WINDOW_ABOVE = 180

describe.skipIf(!reachable)('close_expired_incident', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let attestors: Keypair[]
  /** No attestations at all: the plain expiry, and the bond is forfeited. */
  let expiring: { target: RegisteredProtocol; incident: PublicKey; bond: bigint }
  /** Quorum reached, but its policy runs out before anyone settles it. */
  let lapsed: { target: RegisteredProtocol; incident: PublicKey }
  /** Quorum reached on a policy still in force — `resolve` territory. */
  let payable: { target: RegisteredProtocol; incident: PublicKey }

  /** A protocol with capital and one policy, unentangled from the others here. */
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
    const opened = await openIncident(program, env, expiringTarget, expiringPolicy)
    expiring = { target: expiringTarget, incident: opened.incident, bond: opened.bond }

    // Its policy ends while the attestation window is still open, so by the deadline
    // `resolve` would refuse it (FR-016) and nothing but this instruction can end it.
    const lapsingEnd = (await clusterTimestamp(env.connection)) + SHORT_POLICY
    const [lapsedTarget, lapsedPolicy] = await coveredProtocol(lapsingEnd)
    lapsed = {
      target: lapsedTarget,
      incident: (await openIncident(program, env, lapsedTarget, lapsedPolicy)).incident,
    }

    const [payableTarget, payablePolicy] = await coveredProtocol()
    payable = {
      target: payableTarget,
      incident: (await openIncident(program, env, payableTarget, payablePolicy)).incident,
    }

    for (const attestor of attestors) {
      await attest(program, lapsed.target, lapsed.incident, attestor)
      await attest(program, payable.target, payable.incident, attestor)
    }

    // One wait for all three: they were opened within seconds of each other, and the
    // clock that matters is the cluster's, not this machine's.
    const deadlines = await Promise.all(
      [expiring, lapsed, payable].map(async ({ incident }) =>
        (await program.account.incident.fetch(incident)).deadline.toNumber(),
      ),
    )
    await waitPastClusterTime(env.connection, Math.max(...deadlines))
  }, 240_000)

  afterAll(async () => {
    if (attestors !== undefined) await releaseAttestors(program, env, attestors)
  })

  it('refuses to close an incident whose window is still open', async () => {
    const [target, policySeq] = await coveredProtocol()
    const { incident } = await openIncident(program, env, target, policySeq)

    const error = await closeExpiredIncident(program, env, target, incident).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('IncidentDeadlineNotReached')
  })

  it('closes an expired incident without paying, and the bond becomes pool capital', async () => {
    const { target, incident: opened, bond } = expiring
    const poolBefore = await program.account.pool.fetch(target.pool)
    const vaultBefore = (await getAccount(env.connection, target.vault)).amount
    const openerToken = await env.assetAccount(
      (await program.account.incident.fetch(opened)).opener,
    )
    const openerBefore = (await getAccount(env.connection, openerToken)).amount

    await closeExpiredIncident(program, env, target, opened)

    const incident = await program.account.incident.fetch(opened)
    expect(incident.status).toEqual({ closedNoPayout: {} })
    expect(incident.payout.toNumber()).toBe(0)
    expect(incident.shortfall.toNumber()).toBe(0)

    const pool = await program.account.pool.fetch(target.pool)
    // The bond changes side of the ledger without moving: it was already in the vault,
    // and now it counts as capital the pool can underwrite with.
    expect(BigInt(pool.totalAssets.toString())).toBe(
      BigInt(poolBefore.totalAssets.toString()) + bond,
    )
    expect((await getAccount(env.connection, target.vault)).amount).toBe(vaultBefore)
    expect((await getAccount(env.connection, openerToken)).amount).toBe(openerBefore)
    // The capital the incident froze is released — and only this releases it (FR-019).
    expect(pool.openIncidents).toBe(poolBefore.openIncidents - 1)
    // Nothing was paid, so the cover stands exactly as it did.
    expect(BigInt(pool.lockedLimit.toString())).toBe(BigInt(poolBefore.lockedLimit.toString()))

    const policy = await program.account.policy.fetch(incident.policy)
    expect(BigInt(policy.remainingLimit.toString())).toBe(LIMIT)
    expect(policy.status).not.toEqual({ exhausted: {} })
  })

  it('refuses to close an incident the quorum confirmed while its policy is in force', async () => {
    const { target, incident } = payable

    const error = await closeExpiredIncident(program, env, target, incident).catch(
      (thrown: unknown) => thrown,
    )

    // Past its deadline, but a decision was already taken and FR-012 makes it final:
    // closing it here would take a payout away from the beneficiary.
    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('IncidentPayable')

    // And the path it points at is open, deadline or not.
    await resolve(program, env, target, incident)
    expect((await program.account.incident.fetch(incident)).status).toEqual({ paidOut: {} })
  })

  it('returns the bond when the quorum confirmed an incident its policy outlived', async () => {
    const { target, incident: opened } = lapsed
    const incidentBefore = await program.account.incident.fetch(opened)
    const openerToken = await env.assetAccount(incidentBefore.opener)
    const openerBefore = (await getAccount(env.connection, openerToken)).amount
    const poolBefore = await program.account.pool.fetch(target.pool)
    const bond = BigInt(incidentBefore.bond.toString())

    // `resolve` cannot end this one: the policy ran out before anyone came to settle
    // it (FR-016), so without this instruction the pool's capital would stay frozen.
    const rejected = await resolve(program, env, target, opened).catch((thrown: unknown) => thrown)
    expect(rejected).toBeInstanceOf(AnchorError)
    expect((rejected as AnchorError).error.errorCode.code).toBe('PolicyNotActive')

    await closeExpiredIncident(program, env, target, opened)

    const incident = await program.account.incident.fetch(opened)
    expect(incident.status).toEqual({ closedNoPayout: {} })
    expect(incident.payout.toNumber()).toBe(0)
    // The bond is what a claim costs to make, and this claim was not a false one —
    // the set confirmed it. Nothing was paid, so it is not the pool's either.
    expect((await getAccount(env.connection, openerToken)).amount).toBe(openerBefore + bond)
    const pool = await program.account.pool.fetch(target.pool)
    expect(BigInt(pool.totalAssets.toString())).toBe(BigInt(poolBefore.totalAssets.toString()))
    expect(pool.openIncidents).toBe(poolBefore.openIncidents - 1)
    expect((await getAccount(env.connection, target.vault)).amount).toBe(
      BigInt(pool.totalAssets.toString()),
    )
  })

  it('refuses to close the same incident twice', async () => {
    const error = await closeExpiredIncident(
      program,
      env,
      expiring.target,
      expiring.incident,
    ).catch((thrown: unknown) => thrown)

    // Closed is as final as paid out: releasing the same incident twice would credit
    // the pool a bond it holds once and unfreeze capital no incident froze.
    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('IncidentNotOpen')
  })
})
