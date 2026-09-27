import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig, findPolicy } from '@mandate/sdk'
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
  releaseExpiredPolicy,
  resolve,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(500_000)
const RETENTION = asset(50_000)
const PREMIUM = asset(4_000)
/**
 * How long the policies that have to run out get. Long enough to open an incident on
 * one and collect its attestations while it is still in force.
 */
const SHORT_POLICY = 45

/** The same guard as `close_expired_incident.itest.ts`: this suite waits out a window. */
const REFUSE_WINDOW_ABOVE = 180

const codeOf = (error: unknown): string | undefined =>
  error instanceof AnchorError ? error.error.errorCode.code : undefined

const pooled = async (program: Program<DrainCover>, target: RegisteredProtocol) => {
  const pool = await program.account.pool.fetch(target.pool)
  return {
    totalAssets: BigInt(pool.totalAssets.toString()),
    lockedLimit: BigInt(pool.lockedLimit.toString()),
    openIncidents: pool.openIncidents,
  }
}

/**
 * `release_expired_policy` against a real program (T067).
 *
 * The boundaries of `validate_release` — the end second, a second release, an exhausted
 * policy — are unit tests in Rust. What only a validator shows is the account binding
 * (a policy of one protocol cannot be released against another's pool) and how the
 * release sits next to `resolve` and `close_expired_incident` on a policy whose
 * incident is still open: in any order, with the pool's books square at the end.
 */
describe.skipIf(!reachable)('release_expired_policy', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let attestors: Keypair[]
  /** Ran out with nothing against it. */
  let quiet: { target: RegisteredProtocol; seq: number }
  /** Ran out while an incident on it sat at quorum, unsettled. */
  let contested: { target: RegisteredProtocol; seq: number; incident: PublicKey }

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

    const end = (await clusterTimestamp(env.connection)) + SHORT_POLICY
    const [quietTarget, quietSeq] = await coveredProtocol(end)
    quiet = { target: quietTarget, seq: quietSeq }

    const [contestedTarget, contestedSeq] = await coveredProtocol(end)
    const { incident } = await openIncident(program, env, contestedTarget, contestedSeq)
    for (const attestor of attestors) {
      await attest(program, contestedTarget, incident, attestor)
    }
    contested = { target: contestedTarget, seq: contestedSeq, incident }

    await waitPastClusterTime(env.connection, end)
  }, 240_000)

  afterAll(async () => {
    if (attestors !== undefined) await releaseAttestors(program, env, attestors)
  })

  it('releases exactly the remaining limit and keeps the premium', async () => {
    const before = await pooled(program, quiet.target)

    await releaseExpiredPolicy(program, quiet.target, quiet.seq)

    const after = await pooled(program, quiet.target)
    expect(after.lockedLimit).toBe(before.lockedLimit - LIMIT)
    // The premium was earned when the cover was sold; ending the cover gives nothing
    // back to anyone.
    expect(after.totalAssets).toBe(before.totalAssets)
    const policy = await program.account.policy.fetch(
      findPolicy(program.programId, quiet.target.protocol, quiet.seq),
    )
    expect(policy.status).toEqual({ expired: {} })
    // The account stays: it is part of the trail.
    expect(policy.remainingLimit.toString()).toBe(LIMIT.toString())
  })

  it('refuses to release the same policy twice', async () => {
    const error = await releaseExpiredPolicy(program, quiet.target, quiet.seq).catch(
      (thrown: unknown) => thrown,
    )

    // A second release would take the reservation of some other policy in the pool.
    expect(codeOf(error)).toBe('PolicyAlreadyReleased')
  })

  it('refuses a policy that still covers', async () => {
    const [target, seq] = await coveredProtocol()
    const before = await pooled(program, target)

    const error = await releaseExpiredPolicy(program, target, seq).catch(
      (thrown: unknown) => thrown,
    )

    expect(codeOf(error)).toBe('PolicyNotExpired')
    expect((await pooled(program, target)).lockedLimit).toBe(before.lockedLimit)
  })

  // `Policy` records neither its protocol nor its pool, so the seeds are all that ties
  // it to them. Without the binding, an expired policy here would unlock capital that
  // backs live cover in some other pool.
  it("refuses one protocol's policy against another's pool", async () => {
    const [other] = await coveredProtocol()
    const before = await pooled(program, other)

    const error = await program.methods
      .releaseExpiredPolicy(new BN(0))
      .accountsPartial({
        protocol: other.protocol,
        pool: other.pool,
        policy: findPolicy(program.programId, contested.target.protocol, contested.seq),
      })
      .rpc()
      .catch((thrown: unknown) => thrown)

    expect(codeOf(error)).toBe('ConstraintSeeds')
    expect((await pooled(program, other)).lockedLimit).toBe(before.lockedLimit)
  })

  // Exhausted is already released: `resolve` gave the retention back when the payout
  // used up what was payable. Refused as such even before `end_ts`.
  it('refuses a policy a payout exhausted', async () => {
    const [target, seq] = await coveredProtocol()
    const { incident } = await openIncident(program, env, target, seq)
    for (const attestor of attestors) await attest(program, target, incident, attestor)
    await resolve(program, env, target, incident)
    expect((await pooled(program, target)).lockedLimit).toBe(0n)

    const error = await releaseExpiredPolicy(program, target, seq).catch(
      (thrown: unknown) => thrown,
    )

    expect(codeOf(error)).toBe('PolicyAlreadyReleased')
  })

  // The case the plan turned on. The quorum was reached while the policy was in force,
  // nobody settled it, and the policy ran out. `resolve` can no longer pay (FR-016), so
  // the reservation backs nothing and is released with the incident still open; the
  // incident is closed separately at its deadline. The three instructions touch
  // disjoint fields, and at the end the pool holds no lock and no open incident.
  it('releases a policy whose incident is still open, and the incident closes after', async () => {
    const { target, seq, incident } = contested
    const before = await pooled(program, target)
    expect(before.openIncidents).toBe(1)

    await releaseExpiredPolicy(program, target, seq)

    const released = await pooled(program, target)
    expect(released.lockedLimit).toBe(before.lockedLimit - LIMIT)
    expect(released.openIncidents).toBe(1)
    expect((await program.account.incident.fetch(incident)).status).toEqual({ open: {} })

    const refused = await resolve(program, env, target, incident).catch((thrown: unknown) => thrown)
    expect(codeOf(refused)).toBe('PolicyNotActive')

    const { deadline, opener, bond } = await program.account.incident.fetch(incident)
    const openerToken = await env.assetAccount(opener)
    const openerBefore = (await getAccount(env.connection, openerToken)).amount
    await waitPastClusterTime(env.connection, deadline.toNumber())
    await closeExpiredIncident(program, env, target, incident)

    const after = await pooled(program, target)
    expect(after).toEqual({ totalAssets: before.totalAssets, lockedLimit: 0n, openIncidents: 0 })
    // Confirmed by the set, so the bond goes back — the release did not change that.
    expect((await getAccount(env.connection, openerToken)).amount).toBe(
      openerBefore + BigInt(bond.toString()),
    )
    // The vault invariant: with no incident open, the balance is `total_assets`.
    expect((await getAccount(env.connection, target.vault)).amount).toBe(after.totalAssets)
  }, 240_000)
})
