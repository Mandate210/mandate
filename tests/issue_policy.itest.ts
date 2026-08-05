import { AnchorError, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram } from '@drain-cover/sdk'
import { getAccount } from '@solana/spl-token'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, setupTestEnv, validatorReachable } from './harness'
import {
  type RegisteredProtocol,
  ensureConfig,
  fundPool,
  issuePolicy,
  registerProtocol,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(750_000)
const RETENTION = asset(112_500)
const PREMIUM = asset(5_000)

describe.skipIf(!reachable)('issue_policy', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol

  /**
   * Read from the chain rather than tracked in the test: each premium becomes pool
   * capital too, so free capital is not simply "what was funded minus what is
   * locked", and hand arithmetic here silently stops testing what it claims to.
   */
  const freeCapital = async (): Promise<bigint> => {
    const pool = await program.account.pool.fetch(target.pool)
    return BigInt(pool.totalAssets.toString()) - BigInt(pool.lockedLimit.toString())
  }

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
  })

  it('records the terms and locks the limit against the pool', async () => {
    const { policy, beneficiary } = await issuePolicy(program, env, target, {
      limit: LIMIT,
      retention: RETENTION,
      premium: PREMIUM,
    })

    const stored = await program.account.policy.fetch(policy)
    expect(BigInt(stored.limit.toString())).toBe(LIMIT)
    expect(BigInt(stored.retention.toString())).toBe(RETENTION)
    expect(BigInt(stored.remainingLimit.toString())).toBe(LIMIT)
    expect(BigInt(stored.premiumPaid.toString())).toBe(PREMIUM)
    expect(stored.beneficiary.equals(beneficiary)).toBe(true)
    expect(stored.status).toEqual({ active: {} })

    const pool = await program.account.pool.fetch(target.pool)
    // Locked at issuance, not at payout: otherwise there is a window where an
    // underwriter withdraws capital out from under an active policy (FR-020).
    expect(BigInt(pool.lockedLimit.toString())).toBe(LIMIT)
    // The premium became pool capital, and the vault agrees with the accounting.
    expect(BigInt(pool.totalAssets.toString())).toBe(CAPITAL + PREMIUM)
    const vault = await getAccount(env.connection, pool.vault)
    expect(vault.amount).toBe(CAPITAL + PREMIUM)

    expect((await program.account.protocol.fetch(target.protocol)).nextPolicySeq.toNumber()).toBe(1)
  })

  it('gives the next policy its own address and adds to the locked limit', async () => {
    const free = await freeCapital()
    const { policy, seq } = await issuePolicy(program, env, target, {
      limit: free,
      retention: 0n,
      premium: asset(1_000),
    })

    expect(seq).toBe(1)
    const stored = await program.account.policy.fetch(policy)
    expect(BigInt(stored.limit.toString())).toBe(free)

    const pool = await program.account.pool.fetch(target.pool)
    expect(BigInt(pool.lockedLimit.toString())).toBe(LIMIT + free)
  })

  it('refuses a limit the pool cannot back', async () => {
    // One unit above what the pool has free. The premium arriving with this policy
    // would cover the gap, which is exactly why FR-027 is checked before it is
    // credited: a policy must not back itself.
    const error = await issuePolicy(program, env, target, {
      limit: (await freeCapital()) + 1n,
      retention: 0n,
      premium: asset(1_000),
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('LimitExceedsFreeCapital')
  })

  it('refuses a retention that leaves nothing payable', async () => {
    const other = await registerProtocol(program, env)
    await fundPool(program, env, other, asset(10_000))

    const error = await issuePolicy(program, env, other, {
      limit: asset(1_000),
      retention: asset(1_000),
      premium: asset(10),
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('RetentionAtOrAboveLimit')
  })

  it('marks a policy that has not started yet as pending', async () => {
    const other = await registerProtocol(program, env)
    await fundPool(program, env, other, asset(10_000))
    const now = Math.floor(Date.now() / 1000)

    const { policy } = await issuePolicy(program, env, other, {
      limit: asset(1_000),
      retention: asset(100),
      premium: asset(10),
      startTs: now + 86_400,
      endTs: now + 30 * 86_400,
    })

    // Status is a summary; the period is the truth. FR-016 is answered from the
    // timestamps, which is why nothing has to wake up and flip this field.
    expect(await program.account.policy.fetch(policy).then((p) => p.status)).toEqual({
      pending: {},
    })
  })

  it('refuses a period that has already ended', async () => {
    const other = await registerProtocol(program, env)
    await fundPool(program, env, other, asset(10_000))
    const now = Math.floor(Date.now() / 1000)

    const error = await issuePolicy(program, env, other, {
      limit: asset(1_000),
      retention: asset(100),
      premium: asset(10),
      startTs: now - 2 * 86_400,
      endTs: now - 86_400,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('PolicyEndsInThePast')
  })
})
