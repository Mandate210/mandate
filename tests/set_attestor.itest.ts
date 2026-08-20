import { AnchorError, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findAttestor, findConfig } from '@mandate/sdk'
import { Keypair, SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, setupTestEnv, validatorReachable } from './harness'
import { ensureConfig, setAttestor } from './world'

const reachable = await validatorReachable()

describe.skipIf(!reachable)('set_attestor', () => {
  let env: TestEnv
  let program: Program<DrainCover>

  /** The quorum denominator. Asserted as a delta: this file is not the only writer. */
  const attestorCount = async (): Promise<number> =>
    (await program.account.config.fetch(findConfig(program.programId))).attestorCount

  const epoch = async (): Promise<number> => (await env.connection.getEpochInfo()).epoch

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
  })

  it('admits an attestor from the next epoch and counts it', async () => {
    const authority = Keypair.generate().publicKey
    const before = await attestorCount()
    const epochBefore = await epoch()

    const account = await setAttestor(program, env, authority)
    const epochAfter = await epoch()

    const attestor = await program.account.attestor.fetch(account)
    expect(attestor.authority.equals(authority)).toBe(true)
    expect(attestor.inSet).toBe(true)
    // Never the current epoch: an epoch is far longer than the attestation window,
    // so the set that decides an incident is settled before the incident exists and
    // nobody can be added into an open one (FR-008). Bounded rather than compared
    // for equality — the chain may cross an epoch between the two reads.
    expect(attestor.activeFromEpoch.toNumber()).toBeGreaterThanOrEqual(epochBefore + 1)
    expect(attestor.activeFromEpoch.toNumber()).toBeLessThanOrEqual(epochAfter + 1)
    expect(attestor.stake.toNumber()).toBe(0)

    expect(await attestorCount()).toBe(before + 1)
  })

  it('refuses to admit the same authority twice', async () => {
    const authority = Keypair.generate().publicKey
    await setAttestor(program, env, authority)
    const before = await attestorCount()

    // A no-op would be worse than an error: it would push active_from_epoch forward
    // and disarm an attestor the admin believes is voting.
    const error = await setAttestor(program, env, authority).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('AttestorAlreadyInSet')
    expect(await attestorCount()).toBe(before)
  })

  it('removes an attestor at once', async () => {
    const authority = Keypair.generate().publicKey
    const account = await setAttestor(program, env, authority)
    const before = await attestorCount()

    await setAttestor(program, env, authority, false)

    // Removal is immediate in both the flag and the count, so the quorum denominator
    // is never larger than the set that can actually vote.
    expect((await program.account.attestor.fetch(account)).inSet).toBe(false)
    expect(await attestorCount()).toBe(before - 1)
  })

  it('refuses to remove someone who is not in the set', async () => {
    const stranger = Keypair.generate().publicKey
    const before = await attestorCount()

    const error = await setAttestor(program, env, stranger, false).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('AttestorNotInSet')
    // The failed transaction left nothing behind — no account, no count.
    expect(await env.connection.getAccountInfo(findAttestor(program.programId, stranger))).toBe(
      null,
    )
    expect(await attestorCount()).toBe(before)
  })

  it('takes a removed attestor back', async () => {
    const authority = Keypair.generate().publicKey
    const account = await setAttestor(program, env, authority)
    await setAttestor(program, env, authority, false)
    const before = await attestorCount()
    const epochBefore = await epoch()

    await setAttestor(program, env, authority)

    const attestor = await program.account.attestor.fetch(account)
    expect(attestor.inSet).toBe(true)
    expect(attestor.activeFromEpoch.toNumber()).toBeGreaterThanOrEqual(epochBefore + 1)
    expect(await attestorCount()).toBe(before + 1)
    // The account outlived the removal, which is the point of keeping it: from US3
    // it carries a stake and the record of agreements, and a re-admission must not
    // wipe either (FR-022, FR-023).
    expect(attestor.agreed).toBe(0)
    expect(attestor.disagreed).toBe(0)
    expect(attestor.stake.toNumber()).toBe(0)
  })

  it('refuses anyone but the admin', async () => {
    const stranger = await env.fundedKeypair(5)
    const authority = Keypair.generate().publicKey

    await expect(
      program.methods
        .setAttestor(authority, true)
        .accountsPartial({
          admin: stranger.publicKey,
          attestor: findAttestor(program.programId, authority),
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc(),
    ).rejects.toThrow()
  })
})
