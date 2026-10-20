import { AnchorError, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig } from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
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
  completeWithdraw,
  deposit,
  ensureConfig,
  issuePolicy,
  openIncident,
  registerProtocol,
  releaseExpiredPolicy,
  requestWithdraw,
  setAttestor,
} from './world'

const reachable = await validatorReachable()

const CAPITAL = asset(100_000)

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

const books = async (program: Program<DrainCover>, env: TestEnv, target: RegisteredProtocol) => {
  const pool = await program.account.pool.fetch(target.pool)
  return {
    totalAssets: BigInt(pool.totalAssets.toString()),
    totalShares: BigInt(pool.totalShares.toString()),
    lockedLimit: BigInt(pool.lockedLimit.toString()),
    vault: (await getAccount(env.connection, target.vault)).amount,
  }
}

const balance = async (env: TestEnv, account: PublicKey): Promise<bigint> =>
  (await getAccount(env.connection, account)).amount

/** What `shares` are worth against the pool as it stands, rounded down like the program. */
const worth = (shares: bigint, pool: { totalAssets: bigint; totalShares: bigint }): bigint =>
  (shares * pool.totalAssets) / pool.totalShares

/**
 * `complete_withdraw` against a real program (T033).
 *
 * The arithmetic — pricing, both roundings, the FR-020 cap and every refusal's
 * boundary — is unit tests in Rust. What a validator adds is the cluster clock on both
 * sides of the window, the token transfer signed by the pool, and the sequence SC-009
 * is about: capital locked by a policy leaves in part now and the rest once the
 * policy releases it, with no second request.
 */
describe.skipIf(!reachable)('complete_withdraw', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let withdrawDelay: number

  const funded = async (): Promise<{
    target: RegisteredProtocol
    underwriter: Keypair
    position: PublicKey
  }> => {
    const target = await registerProtocol(program, env)
    const { underwriter, position } = await deposit(program, env, target, CAPITAL)
    return { target, underwriter, position }
  }

  /** Requests `shares` and waits until the request can be completed. */
  const matured = async (
    target: RegisteredProtocol,
    underwriter: Keypair,
    position: PublicKey,
    shares: bigint,
  ): Promise<number> => {
    await requestWithdraw(program, target, underwriter, shares)
    const { unlockTs } = await held(program, position)
    await waitPastClusterTime(env.connection, unlockTs - 1)
    return unlockTs
  }

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    withdrawDelay = (
      await program.account.config.fetch(findConfig(program.programId))
    ).withdrawDelay.toNumber()
  })

  /**
   * A premium lands after the request, and the leaver takes their part of it: the
   * price is the one at completion. Expected amounts come from the pool as it stands
   * just before, not from arithmetic on what the test put in.
   */
  it('pays the requested shares at the price at completion, out of the vault', async () => {
    const { target, underwriter, position } = await funded()
    await requestWithdraw(program, target, underwriter, asset(40_000))
    await issuePolicy(program, env, target, {
      limit: asset(10_000),
      retention: asset(1_000),
      premium: asset(5_000),
    })
    await waitPastClusterTime(env.connection, (await held(program, position)).unlockTs - 1)

    const before = await books(program, env, target)
    const expected = worth(asset(40_000), before)
    expect(expected).toBeGreaterThan(asset(40_000))

    const destination = await completeWithdraw(program, env, target, underwriter)

    expect(await balance(env, destination)).toBe(expected)
    expect(await books(program, env, target)).toEqual({
      totalAssets: before.totalAssets - expected,
      totalShares: before.totalShares - asset(40_000),
      lockedLimit: before.lockedLimit,
      vault: before.vault - expected,
    })
    expect(await held(program, position)).toMatchObject({
      shares: CAPITAL - asset(40_000),
      pending: 0n,
    })
  })

  it('refuses before the wait is over, and moves nothing', async () => {
    const { target, underwriter, position } = await funded()
    await requestWithdraw(program, target, underwriter, asset(10_000))
    const pool = await books(program, env, target)
    const stored = await held(program, position)

    await expect(completeWithdraw(program, env, target, underwriter)).rejects.toSatisfy(
      (error) => codeOf(error) === 'WithdrawNotUnlocked',
    )

    expect(await books(program, env, target)).toEqual(pool)
    expect(await held(program, position)).toEqual(stored)
  })

  it('refuses a position with nothing requested', async () => {
    const { target, underwriter } = await funded()

    await expect(completeWithdraw(program, env, target, underwriter)).rejects.toSatisfy(
      (error) => codeOf(error) === 'NoWithdrawRequested',
    )
  })

  /**
   * The request is accepted during an incident (T032); this is where FR-019 bites —
   * including on an incident opened after the request, which only this check sees.
   */
  it('refuses while an incident on the pool is open', async () => {
    const { target, underwriter, position } = await funded()
    const { seq } = await issuePolicy(program, env, target, {
      limit: asset(50_000),
      retention: asset(5_000),
      premium: asset(1_000),
    })
    await requestWithdraw(program, target, underwriter, asset(20_000))
    // `open_incident` refuses an empty set. This attestor never votes.
    const attestor = await env.fundedKeypair(1)
    await setAttestor(program, env, attestor.publicKey)
    try {
      await openIncident(program, env, target, seq)
      await waitPastClusterTime(env.connection, (await held(program, position)).unlockTs - 1)
      const pool = await books(program, env, target)

      await expect(completeWithdraw(program, env, target, underwriter)).rejects.toSatisfy(
        (error) => codeOf(error) === 'WithdrawalBlockedByIncident',
      )

      expect(await books(program, env, target)).toEqual(pool)
    } finally {
      await setAttestor(program, env, attestor.publicKey, false)
    }
  })

  it('refuses a signer who does not own the position', async () => {
    const { target, underwriter, position } = await funded()
    await matured(target, underwriter, position, asset(10_000))
    const stranger = await env.fundedKeypair(1)

    await expect(completeWithdraw(program, env, target, stranger, position)).rejects.toSatisfy(
      (error) => codeOf(error) === 'ConstraintSeeds',
    )

    expect((await held(program, position)).pending).toBe(asset(10_000))
  })

  /**
   * FR-020 and SC-009 together. A policy locks most of the pool; the request is for
   * all of it. Completion pays what the free capital buys and leaves the rest
   * requested under the same clock. Once the policy's period ends and its
   * reservation is released, the rest completes — a second completion, not a second
   * request, so there is no second wait.
   */
  it('pays what free capital allows, then the rest once a policy releases it', async () => {
    const { target, underwriter, position } = await funded()
    const now = await clusterTimestamp(env.connection)
    const { seq } = await issuePolicy(program, env, target, {
      limit: asset(70_000),
      retention: asset(7_000),
      premium: asset(1_000),
      startTs: now - 60,
      // Ends well inside the wait, so it is releasable by the time the request unlocks.
      endTs: now + Math.floor(withdrawDelay / 2),
    })
    const unlockTs = await matured(target, underwriter, position, CAPITAL)

    const before = await books(program, env, target)
    const free = before.totalAssets - before.lockedLimit
    const burned = (free * before.totalShares) / before.totalAssets
    const paid = worth(burned, before)
    expect(burned).toBeLessThan(CAPITAL)

    const destination = await completeWithdraw(program, env, target, underwriter)

    expect(await balance(env, destination)).toBe(paid)
    expect(paid).toBeLessThanOrEqual(free)
    expect(await held(program, position)).toEqual({
      shares: CAPITAL - burned,
      pending: CAPITAL - burned,
      unlockTs,
    })
    // Nothing whole is left to buy until the policy lets go of its limit.
    await expect(completeWithdraw(program, env, target, underwriter)).rejects.toSatisfy(
      (error) => codeOf(error) === 'CapitalLocked',
    )

    await releaseExpiredPolicy(program, target, seq)
    const released = await books(program, env, target)
    const rest = worth(CAPITAL - burned, released)

    await completeWithdraw(program, env, target, underwriter)

    expect(await balance(env, destination)).toBe(paid + rest)
    expect(await held(program, position)).toMatchObject({ shares: 0n, pending: 0n })
    // The underwriter was the pool's only one: everything it held went with them,
    // premium included, bar what the rounding kept.
    const after = await books(program, env, target)
    expect(after.totalShares).toBe(0n)
    expect(after.totalAssets).toBe(released.totalAssets - rest)
    expect(after.totalAssets).toBeLessThanOrEqual(1n)
  })

  /**
   * A request is completable for one wait after it unlocks. Past that, it is a stale
   * option to leave on short notice, which the wait exists to prevent: request again.
   */
  it('refuses a request whose window has lapsed', async () => {
    const { target, underwriter, position } = await funded()
    const unlockTs = await matured(target, underwriter, position, asset(10_000))
    await waitPastClusterTime(env.connection, unlockTs + withdrawDelay - 1)
    const pool = await books(program, env, target)

    await expect(completeWithdraw(program, env, target, underwriter)).rejects.toSatisfy(
      (error) => codeOf(error) === 'WithdrawRequestExpired',
    )

    expect(await books(program, env, target)).toEqual(pool)
  })
})
