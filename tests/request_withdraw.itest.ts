import { AnchorError, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig } from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, clusterTimestamp, setupTestEnv, validatorReachable } from './harness'
import {
  type RegisteredProtocol,
  deposit,
  ensureConfig,
  issuePolicy,
  openIncident,
  registerProtocol,
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
    vault: (await getAccount(env.connection, target.vault)).amount,
  }
}

/**
 * `request_withdraw` against a real program (T032).
 *
 * The arithmetic — the bounds on shares and the overflow of the clock — is unit tests
 * in Rust. What a validator adds is the clock itself, the binding of a position to the
 * key that signs, and the two things the request deliberately does *not* do: move
 * anything out of the pool, and refuse because an incident is open.
 */
describe.skipIf(!reachable)('request_withdraw', () => {
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

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    withdrawDelay = (
      await program.account.config.fetch(findConfig(program.programId))
    ).withdrawDelay.toNumber()
  })

  it('holds the shares until the cluster clock plus the delay', async () => {
    const { target, underwriter, position } = await funded()

    const before = await clusterTimestamp(env.connection)
    await requestWithdraw(program, target, underwriter, asset(40_000))
    const after = await clusterTimestamp(env.connection)

    const stored = await held(program, position)
    expect(stored.pending).toBe(asset(40_000))
    // Bracketed, not pinned: the transaction lands in some slot between the two reads.
    expect(stored.unlockTs).toBeGreaterThanOrEqual(before + withdrawDelay)
    expect(stored.unlockTs).toBeLessThanOrEqual(after + withdrawDelay)
  })

  /**
   * The price is taken at completion (T033), so until then the shares are exactly as
   * they were: still in the position, still in the pool, still backing its policies.
   */
  it('moves nothing and prices nothing', async () => {
    const { target, underwriter, position } = await funded()
    const pool = await books(program, env, target)

    await requestWithdraw(program, target, underwriter, CAPITAL)

    expect(await books(program, env, target)).toEqual(pool)
    expect((await held(program, position)).shares).toBe(CAPITAL)
  })

  it('refuses more shares than the position holds, and nothing', async () => {
    const { target, underwriter, position } = await funded()
    const before = await held(program, position)

    await expect(requestWithdraw(program, target, underwriter, CAPITAL + 1n)).rejects.toSatisfy(
      (error) => codeOf(error) === 'WithdrawExceedsShares',
    )
    await expect(requestWithdraw(program, target, underwriter, 0n)).rejects.toSatisfy(
      (error) => codeOf(error) === 'AmountMustBePositive',
    )

    expect(await held(program, position)).toEqual(before)
  })

  it('replaces an earlier request and restarts its clock', async () => {
    const { target, underwriter, position } = await funded()

    await requestWithdraw(program, target, underwriter, asset(80_000))
    const first = await held(program, position)
    // A second apart at least, so a restarted clock is visible as a later unlock.
    const past = first.unlockTs - withdrawDelay
    while ((await clusterTimestamp(env.connection)) <= past) {
      await new Promise((r) => setTimeout(r, 400))
    }

    await requestWithdraw(program, target, underwriter, asset(30_000))
    const second = await held(program, position)

    // Replaced, not added: 30 000, not 110 000 — which the position would not even hold.
    expect(second.pending).toBe(asset(30_000))
    expect(second.unlockTs).toBeGreaterThan(first.unlockTs)
  })

  it('refuses a signer who does not own the position', async () => {
    const { target, position } = await funded()
    const stranger = await env.fundedKeypair(1)
    const before = await held(program, position)

    await expect(requestWithdraw(program, target, stranger, asset(1), position)).rejects.toSatisfy(
      (error) => codeOf(error) === 'ConstraintSeeds',
    )

    expect(await held(program, position)).toEqual(before)
  })

  it('refuses an address that never deposited', async () => {
    const target = await registerProtocol(program, env)
    const nobody = await env.fundedKeypair(1)

    await expect(requestWithdraw(program, target, nobody, asset(1))).rejects.toSatisfy(
      (error) => codeOf(error) === 'AccountNotInitialized',
    )
  })

  it('keeps the request when the position takes another deposit', async () => {
    const { target, underwriter, position } = await funded()
    await requestWithdraw(program, target, underwriter, asset(10_000))
    const requested = await held(program, position)

    await deposit(program, env, target, CAPITAL, underwriter)

    const after = await held(program, position)
    expect(after.shares).toBe(2n * CAPITAL)
    expect(after.pending).toBe(requested.pending)
    expect(after.unlockTs).toBe(requested.unlockTs)
  })

  /**
   * FR-019 is enforced at completion, not here — see `request_withdraw.rs`. Refusing
   * the request would let a bond stop every underwriter's clock, and would protect
   * nothing that the completion check does not.
   */
  it('accepts a request while an incident on the pool is open', async () => {
    const { target, underwriter, position } = await funded()
    const { seq } = await issuePolicy(program, env, target, {
      limit: asset(50_000),
      retention: asset(5_000),
      premium: asset(1_000),
    })
    // `open_incident` refuses an empty set. Counted from admission, so there is no
    // epoch to wait for: this attestor never votes.
    const attestor = await env.fundedKeypair(1)
    await setAttestor(program, env, attestor.publicKey)
    try {
      await openIncident(program, env, target, seq)
      expect((await program.account.pool.fetch(target.pool)).openIncidents).toBe(1)

      await requestWithdraw(program, target, underwriter, asset(20_000))

      expect((await held(program, position)).pending).toBe(asset(20_000))
    } finally {
      await setAttestor(program, env, attestor.publicKey, false)
    }
  })
})
