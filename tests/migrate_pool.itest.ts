import { AnchorError, type Program } from '@coral-xyz/anchor'
import { type DrainCover, POOL_SIZE, createProgram } from '@mandate/sdk'
import { SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, setupTestEnv, validatorReachable } from './harness'
import { ensureConfig, registerProtocol } from './world'

const reachable = await validatorReachable()

const codeOf = (error: unknown): string | undefined =>
  error instanceof AnchorError ? error.error.errorCode.code : undefined

/**
 * `migrate_pool` against a real program (T082).
 *
 * Only the refusal is reachable here: this program writes every pool at the current
 * length, so no test can make an old one. The growing itself — fields kept, rent
 * topped up to the new length — was checked once against a pre-T082 pool loaded into
 * a validator with `--account`, and is what `pnpm --filter @mandate/scenarios
 * migrate-pools` does on devnet (docs/deploy-devnet.md → «Міграція пулів (T082)»).
 */
describe.skipIf(!reachable)('migrate_pool', () => {
  let env: TestEnv
  let program: Program<DrainCover>

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
  })

  it('refuses a pool already at the current layout, and leaves it as it was', async () => {
    const target = await registerProtocol(program, env)
    const before = await env.connection.getAccountInfo(target.pool)
    expect(before?.data.length).toBe(POOL_SIZE)

    await expect(
      program.methods
        .migratePool()
        .accountsPartial({
          payer: env.payer.publicKey,
          protocol: target.protocol,
          pool: target.pool,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
    ).rejects.toSatisfy((error) => codeOf(error) === 'PoolNotLegacy')

    const after = await env.connection.getAccountInfo(target.pool)
    expect(after?.data).toEqual(before?.data)
    expect(after?.lamports).toBe(before?.lamports)
  })
})
