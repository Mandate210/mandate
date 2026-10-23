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
  attestToQuorum,
  closeExpiredIncident,
  completeWithdraw,
  deposit,
  ensureConfig,
  issuePolicy,
  openIncident,
  registerProtocol,
  releaseAttestors,
  releaseExpiredPolicy,
  requestWithdraw,
} from './world'

const reachable = await validatorReachable()

const codeOf = (error: unknown): string | undefined =>
  error instanceof AnchorError ? error.error.errorCode.code : undefined

const held = async (program: Program<DrainCover>, position: PublicKey) => {
  const stored = await program.account.underwriterPosition.fetch(position)
  return {
    shares: BigInt(stored.shares.toString()),
    pending: BigInt(stored.pendingWithdraw.toString()),
    unlockTs: stored.unlockTs.toNumber(),
  }
}

const books = async (program: Program<DrainCover>, target: RegisteredProtocol) => {
  const pool = await program.account.pool.fetch(target.pool)
  return {
    totalAssets: BigInt(pool.totalAssets.toString()),
    totalShares: BigInt(pool.totalShares.toString()),
    lockedLimit: BigInt(pool.lockedLimit.toString()),
    openIncidents: pool.openIncidents,
  }
}

type Books = Awaited<ReturnType<typeof books>>

const balance = async (env: TestEnv, account: PublicKey): Promise<bigint> =>
  (await getAccount(env.connection, account)).amount

/** What `shares` are worth against the pool as it stands, rounded down like the program. */
const worth = (shares: bigint, pool: Books): bigint =>
  (shares * pool.totalAssets) / pool.totalShares

/** `a`'s share price is at least `b`'s, compared without dividing. */
const pricedNoLower = (a: Books, b: Books): boolean =>
  a.totalAssets * b.totalShares >= b.totalAssets * a.totalShares

/**
 * The withdrawal blocks of US2 from the story's side (SPEC → US2, acceptance 3 and 4):
 * what an underwriter who wants out runs into, and what is left of their exit after.
 *
 * Each refusal on its own — before the wait is over, while an incident is open, with
 * the free capital already locked — is in `complete_withdraw.itest.ts` and is not
 * repeated here. What only a sequence shows is what the blocks are *for*: an
 * underwriter cannot leave ahead of a payout, an incident does not use up the
 * completion window, and the cover stays funded however many underwriters queue
 * for the door at once.
 */
describe.skipIf(!reachable)('US2 — withdrawal blocks', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let attestors: Keypair[]
  let withdrawDelay: number

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    withdrawDelay = (
      await program.account.config.fetch(findConfig(program.programId))
    ).withdrawDelay.toNumber()

    attestors = await admitQuorumSet(program, env)
  })

  afterAll(async () => {
    if (attestors !== undefined) await releaseAttestors(program, env, attestors)
  })

  /**
   * FR-019 is what makes a payout land on everyone in the pool. The leaver asked
   * before anything happened and the wait is over, but the incident is open, so the
   * exit waits for the verdict — and then goes at the price the payout left, the same
   * one as for the underwriter who stayed.
   */
  it('lets nobody leave ahead of a payout: the exit waits for it and bears its share', async () => {
    const target = await registerProtocol(program, env)
    const leaver = await deposit(program, env, target, asset(60_000))
    // The stayer: only here so that the pool outlives the leaver's exit.
    await deposit(program, env, target, asset(40_000))
    const { seq } = await issuePolicy(program, env, target, {
      limit: asset(50_000),
      retention: asset(5_000),
      premium: asset(1_000),
    })
    await requestWithdraw(program, target, leaver.underwriter, asset(30_000))
    const { incident } = await openIncident(program, env, target, seq)
    await waitPastClusterTime(env.connection, (await held(program, leaver.position)).unlockTs - 1)
    const unharmed = await books(program, target)

    await expect(completeWithdraw(program, env, target, leaver.underwriter)).rejects.toSatisfy(
      (error) => codeOf(error) === 'WithdrawalBlockedByIncident',
    )

    await attestToQuorum(program, target, incident, attestors)
    const paidOut = await books(program, target)
    expect(paidOut.openIncidents).toBe(0)
    expect(paidOut.totalAssets).toBeLessThan(unharmed.totalAssets)
    const expected = worth(asset(30_000), paidOut)

    const destination = await completeWithdraw(program, env, target, leaver.underwriter)

    expect(await balance(env, destination)).toBe(expected)
    expect(expected).toBeLessThan(worth(asset(30_000), unharmed))
    // The two lost in the same proportion: the leaver's exit moved the price of what
    // the stayer holds by no more than the rounding, and only in the stayer's favour.
    expect(pricedNoLower(await books(program, target), paidOut)).toBe(true)
  })

  /**
   * The block lasts as long as the incident, and the window does not run out
   * underneath it (T082, SPEC → US2, acceptance 4: blocked *until* the incident
   * closes). The test's config makes the case ordinary — a 20 s window, a 90 s
   * incident — where with the product's values it is the request whose window closes
   * during one. Closed without a quorum, the request completes as it stands: no second
   * request, no second wait, and a fresh window from the moment the pool unblocked.
   */
  it('keeps the request alive through an incident that outlasts its window', async () => {
    const target = await registerProtocol(program, env)
    const { underwriter, position } = await deposit(program, env, target, asset(100_000))
    const { seq } = await issuePolicy(program, env, target, {
      limit: asset(50_000),
      retention: asset(5_000),
      premium: asset(1_000),
    })
    await requestWithdraw(program, target, underwriter, asset(20_000))
    const { incident } = await openIncident(program, env, target, seq)
    const { unlockTs } = await held(program, position)
    const { deadline } = await program.account.incident.fetch(incident)
    // The premise, stated rather than assumed: the incident is still open when the
    // window would have closed.
    expect(deadline.toNumber()).toBeGreaterThanOrEqual(unlockTs + withdrawDelay)

    // Past the window's own end, and the refusal names the incident: the request is
    // still alive.
    await waitPastClusterTime(env.connection, unlockTs + withdrawDelay)
    await expect(completeWithdraw(program, env, target, underwriter)).rejects.toSatisfy(
      (error) => codeOf(error) === 'WithdrawalBlockedByIncident',
    )

    await waitPastClusterTime(env.connection, deadline.toNumber())
    await closeExpiredIncident(program, env, target, incident)
    const unblocked = await program.account.pool.fetch(target.pool)
    expect(unblocked.openIncidents).toBe(0)
    expect(unblocked.unblockedAt.toNumber()).toBeGreaterThan(deadline.toNumber())
    // No payout, so the forfeited bond is pool capital now and the leaver takes
    // their part of it.
    const expected = worth(asset(20_000), await books(program, target))

    const destination = await completeWithdraw(program, env, target, underwriter)

    expect(await balance(env, destination)).toBe(expected)
    expect(expected).toBeGreaterThan(asset(20_000))
    // The same request, completed: the clock it started on is still the one it holds.
    expect(await held(program, position)).toEqual({
      shares: asset(80_000),
      pending: 0n,
      unlockTs,
    })
  }, 240_000)

  /**
   * FR-020 is a floor under the pool, not a quota per underwriter. Both underwriters
   * ask for everything, and a policy is still sold afterwards — a request reserves
   * nothing. Whoever completes first takes the free capital; the next one finds at
   * most the rounding left. Neither can take the pool below the cover it sold, and
   * once the policy lets go, both drain the rest without asking again.
   */
  it('keeps the cover funded however many underwriters queue to leave', async () => {
    const target = await registerProtocol(program, env)
    const first = await deposit(program, env, target, asset(60_000))
    const second = await deposit(program, env, target, asset(40_000))
    await requestWithdraw(program, target, first.underwriter, asset(60_000))
    await requestWithdraw(program, target, second.underwriter, asset(40_000))
    const now = await clusterTimestamp(env.connection)
    const { seq } = await issuePolicy(program, env, target, {
      limit: asset(70_000),
      retention: asset(7_000),
      premium: asset(1_000),
      startTs: now - 60,
      // Ends inside the wait, so it is releasable while both requests can complete.
      endTs: now + Math.floor(withdrawDelay / 2),
    })
    await waitPastClusterTime(env.connection, (await held(program, second.position)).unlockTs - 1)

    const queued = await books(program, target)
    const free = queued.totalAssets - queued.lockedLimit
    const firstTo = await completeWithdraw(program, env, target, first.underwriter)
    const firstPaid = await balance(env, firstTo)
    expect(firstPaid).toBeGreaterThan(0n)
    expect(firstPaid).toBeLessThanOrEqual(free)
    expect((await held(program, first.position)).pending).toBeGreaterThan(0n)

    const afterFirst = await books(program, target)
    expect(afterFirst.totalAssets).toBeGreaterThanOrEqual(afterFirst.lockedLimit)
    expect(pricedNoLower(afterFirst, queued)).toBe(true)

    // Only rounding dust is free now. Whether it buys a whole share depends on the
    // price, so the second completion either takes that dust or is refused — never more.
    const secondTo = await env.assetAccount(second.underwriter.publicKey)
    const outcome = await completeWithdraw(program, env, target, second.underwriter).then(
      () => 'paid',
      (error: unknown) => codeOf(error),
    )
    expect(['paid', 'CapitalLocked']).toContain(outcome)
    const secondDust = await balance(env, secondTo)
    expect(secondDust).toBeLessThanOrEqual(afterFirst.totalAssets - afterFirst.lockedLimit)

    const locked = await books(program, target)
    expect(locked.totalAssets).toBeGreaterThanOrEqual(locked.lockedLimit)
    expect(locked.lockedLimit).toBe(queued.lockedLimit)

    await releaseExpiredPolicy(program, target, seq)
    await completeWithdraw(program, env, target, second.underwriter)
    await completeWithdraw(program, env, target, first.underwriter)

    expect(await held(program, first.position)).toMatchObject({ shares: 0n, pending: 0n })
    expect(await held(program, second.position)).toMatchObject({ shares: 0n, pending: 0n })
    // Everything the pool held went to the two of them, premium included, bar what
    // the roundings kept.
    const emptied = await books(program, target)
    expect(emptied.totalShares).toBe(0n)
    expect(emptied.totalAssets).toBeLessThanOrEqual(2n)
    expect((await balance(env, firstTo)) + (await balance(env, secondTo))).toBe(
      queued.totalAssets - emptied.totalAssets,
    )
  })
})
