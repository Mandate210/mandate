import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram } from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, setupTestEnv, validatorReachable } from './harness'
import { type RegisteredProtocol, ensureConfig, fundPool, registerProtocol } from './world'

const reachable = await validatorReachable()

// Temporary instruction (T014), removed in T036 when the real deposit arrives. What
// matters until then is that the program's own accounting matches the vault: every
// later capital check reads total_assets, not the token balance.
describe.skipIf(!reachable)('service_fund_pool', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    target = await registerProtocol(program, env)
  })

  it('moves the asset into the vault and records it', async () => {
    await fundPool(program, env, target, asset(1_000_000))

    const pool = await program.account.pool.fetch(target.pool)
    const vault = await getAccount(env.connection, pool.vault)

    expect(vault.amount).toBe(asset(1_000_000))
    expect(BigInt(pool.totalAssets.toString())).toBe(asset(1_000_000))
    // No shares: this capital belongs to nobody and cannot be withdrawn. That is the
    // whole reason the instruction cannot survive into US2.
    expect(pool.totalShares.toNumber()).toBe(0)
    expect(pool.lockedLimit.toNumber()).toBe(0)
  })

  it('accumulates across calls', async () => {
    await fundPool(program, env, target, asset(500_000))

    const pool = await program.account.pool.fetch(target.pool)
    expect(BigInt(pool.totalAssets.toString())).toBe(asset(1_500_000))
  })

  it('rejects a zero amount', async () => {
    const source = await env.assetAccount(env.payer.publicKey, asset(1))
    const error = await program.methods
      .serviceFundPool(new BN(0))
      .accountsPartial({
        admin: env.payer.publicKey,
        protocol: target.protocol,
        pool: target.pool,
        vault: target.vault,
        source,
      })
      .rpc()
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('AmountMustBePositive')
  })

  it('refuses anyone but the admin', async () => {
    const stranger = await env.fundedKeypair(5)
    const source = await env.assetAccount(stranger.publicKey, asset(10))

    await expect(
      program.methods
        .serviceFundPool(new BN(asset(10).toString()))
        .accountsPartial({
          admin: stranger.publicKey,
          protocol: target.protocol,
          pool: target.pool,
          vault: target.vault,
          source,
        })
        .signers([stranger])
        .rpc(),
    ).rejects.toThrow()
  })
})
