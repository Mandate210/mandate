import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig } from '@drain-cover/sdk'
import { SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, setupTestEnv, validatorReachable } from './harness'

const DAY = 86_400
const ATTEST_WINDOW = 2 * 3600
const reachable = await validatorReachable()

// Config is a singleton: its PDA has constant seeds, so one program id has exactly
// one config and the account can only be created once. That shapes this file — the
// rejection is asserted **before** the successful call, while the address is still
// free. Afterwards every attempt fails on "already in use" regardless of its
// parameters, which would make a passing test prove nothing.
describe.skipIf(!reachable)('initialize', () => {
  let env: TestEnv
  let program: Program<DrainCover>

  const initialize = (quorumBps: number, admin = env.payer): Promise<string> =>
    program.methods
      .initialize(new BN(DAY), new BN(ATTEST_WINDOW), quorumBps, new BN(1_000_000))
      .accountsPartial({
        admin: admin.publicKey,
        assetMint: env.assetMint,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc()

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)

    // A singleton cannot be created twice, so this suite is not idempotent against
    // a validator that already ran it. Said plainly here, because the alternative
    // is three failures whose message is "account already in use".
    if ((await env.connection.getAccountInfo(findConfig(program.programId))) !== null) {
      throw new Error(
        'Config already exists on this validator. Restart it with --reset and redeploy: solana-test-validator --reset, then anchor deploy.',
      )
    }
  })

  it('rejects a quorum of zero through the runtime', async () => {
    const error = await initialize(0).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('InvalidQuorum')

    // The whole transaction failed, so the account the init constraint allocated
    // is gone too. Without this the next test would be measuring the wrong thing.
    const info = await env.connection.getAccountInfo(findConfig(program.programId))
    expect(info).toBeNull()
  })

  it('creates the config and records the settlement asset', async () => {
    await initialize(6_000)

    const config = await program.account.config.fetch(findConfig(program.programId))
    expect(config.admin.equals(env.payer.publicKey)).toBe(true)
    expect(config.assetMint.equals(env.assetMint)).toBe(true)
    expect(config.declarationDelay.toNumber()).toBe(DAY)
    expect(config.attestWindow.toNumber()).toBe(ATTEST_WINDOW)
    expect(config.quorumBps).toBe(6_000)
    expect(config.openBond.toNumber()).toBe(1_000_000)
    expect(config.paused).toBe(false)
  })

  it('refuses a second config, even from another signer', async () => {
    const other = await env.fundedKeypair(5)
    await expect(initialize(5_000, other)).rejects.toThrow()

    // Still the first admin: a failed re-initialization must not hand the service
    // operations to whoever called it last.
    const config = await program.account.config.fetch(findConfig(program.programId))
    expect(config.admin.equals(env.payer.publicKey)).toBe(true)
  })
})
