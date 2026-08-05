import type { Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig } from '@drain-cover/sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, setupTestEnv, validatorReachable } from './harness'
import { CONFIG_PARAMS, ensureConfig, initializeConfig } from './world'

const reachable = await validatorReachable()

// `Config` is a singleton — constant seeds, so one program id has exactly one, and it
// can be created only once per ledger. That bounds what this file can assert. The
// parameter rejections live in the Rust unit tests, where they can be replayed; that
// a custom error reaches a caller through the runtime at all is shown by
// register_protocol.itest.ts, which rejects without consuming a singleton.
describe.skipIf(!reachable)('initialize', () => {
  let env: TestEnv
  let program: Program<DrainCover>

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
  })

  it('records the admin, the settlement asset and the parameters it was given', async () => {
    const config = await program.account.config.fetch(findConfig(program.programId))

    expect(config.admin.equals(env.payer.publicKey)).toBe(true)
    expect(config.assetMint.equals(env.assetMint)).toBe(true)
    expect(config.declarationDelay.toNumber()).toBe(CONFIG_PARAMS.declarationDelay)
    expect(config.attestWindow.toNumber()).toBe(CONFIG_PARAMS.attestWindow)
    expect(config.quorumBps).toBe(CONFIG_PARAMS.quorumBps)
    expect(config.openBond.toNumber()).toBe(CONFIG_PARAMS.openBond)
    expect(config.paused).toBe(false)
  })

  it('refuses a second config', async () => {
    const before = await program.account.config.fetch(findConfig(program.programId))

    await expect(initializeConfig(program, env, 5_000)).rejects.toThrow()

    // Unchanged: a failed re-initialization must not hand the service operations to
    // whoever called it last, nor move the settlement asset.
    const after = await program.account.config.fetch(findConfig(program.programId))
    expect(after.admin.equals(before.admin)).toBe(true)
    expect(after.assetMint.equals(before.assetMint)).toBe(true)
    expect(after.quorumBps).toBe(before.quorumBps)
  })
})
