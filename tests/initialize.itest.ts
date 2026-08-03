import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnchorError, BN, type Idl, Program } from '@coral-xyz/anchor'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, setupTestEnv, validatorReachable } from './harness'

// The IDL is read straight from the build output. T010 turns this into a typed
// client in packages/sdk; until then the test does the two lines itself rather
// than waiting on a package that has nothing to export yet.
const idl = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'target', 'idl', 'drain_cover.json'), 'utf8'),
) as Idl

const DAY = 86_400
const ATTEST_WINDOW = 2 * 3600
const reachable = await validatorReachable()

/**
 * Hand-written because the generated types live in `target/`, which is gitignored —
 * a test that imports them would typecheck only on a machine that has just built
 * the program. T010 moves the IDL and its types into `packages/sdk`, and this
 * interface goes with it.
 */
interface ConfigAccount {
  admin: PublicKey
  assetMint: PublicKey
  declarationDelay: BN
  attestWindow: BN
  quorumBps: number
  openBond: BN
  paused: boolean
}

// Config is a singleton: its PDA has constant seeds, so one program id has exactly
// one config and the account can only be created once. That shapes this file — the
// rejection is asserted **before** the successful call, while the address is still
// free. Afterwards every attempt fails on "already in use" regardless of its
// parameters, which would make a passing test prove nothing.
describe.skipIf(!reachable)('initialize', () => {
  let env: TestEnv
  let program: Program
  let configPda: PublicKey

  const initialize = (quorumBps: number, admin = env.payer): Promise<string> => {
    // The IDL is JSON at runtime, so the instruction is genuinely optional as far
    // as the type system knows. The guard turns a missing instruction into a clear
    // failure instead of "cannot invoke undefined" three frames deep.
    const method = program.methods.initialize
    if (method === undefined) throw new Error('IDL has no initialize instruction')

    return method(new BN(DAY), new BN(ATTEST_WINDOW), quorumBps, new BN(1_000_000))
      .accountsPartial({
        config: configPda,
        admin: admin.publicKey,
        assetMint: env.assetMint,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc()
  }

  const fetchConfig = async (): Promise<ConfigAccount> => {
    const info = await env.connection.getAccountInfo(configPda)
    if (info === null) throw new Error('config account does not exist')
    return program.coder.accounts.decode<ConfigAccount>('config', info.data)
  }

  beforeAll(async () => {
    env = await setupTestEnv()
    program = new Program(idl, env.provider)
    configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId)[0]

    // A singleton cannot be created twice, so this suite is not idempotent against
    // a validator that already ran it. Said plainly here, because the alternative
    // is three failures whose message is "account already in use".
    if ((await env.connection.getAccountInfo(configPda)) !== null) {
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
    expect(await env.connection.getAccountInfo(configPda)).toBeNull()
  })

  it('creates the config and records the settlement asset', async () => {
    await initialize(6_000)

    const config = await fetchConfig()
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
    const config = await fetchConfig()
    expect(config.admin.equals(env.payer.publicKey)).toBe(true)
  })
})
