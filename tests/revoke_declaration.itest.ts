import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findDeclarationEntry } from '@drain-cover/sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, setupTestEnv, validatorReachable } from './harness'
import {
  type RegisteredProtocol,
  ensureConfig,
  registerProtocol,
  revokeDeclaration,
  submitDeclaration,
} from './world'

const reachable = await validatorReachable()

describe.skipIf(!reachable)('revoke_declaration', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol

  const now = (): number => Math.floor(Date.now() / 1000)

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    target = await registerProtocol(program, env)
  })

  it('revokes an entry at once, without waiting for it to take effect', async () => {
    const { entry, seq } = await submitDeclaration(program, target)

    await revokeDeclaration(program, target, seq)

    const stored = await program.account.declarationEntry.fetch(entry)
    expect(stored.revokedAt).not.toBe(null)
    // The asymmetry FR-031 and FR-032 are made of, in one line: the entry would only
    // have started covering anything a day from now, and it is already withdrawn.
    // That is what a team gets against an authority that declares its own operation.
    expect(stored.revokedAt?.toNumber()).toBeLessThan(stored.effectiveAt.toNumber())
  })

  it('shortens a window and leaves everything else as submitted', async () => {
    const { entry, seq } = await submitDeclaration(program, target)
    const before = await program.account.declarationEntry.fetch(entry)
    const narrowed = now() + 2 * 86_400

    await revokeDeclaration(program, target, seq, narrowed)

    const after = await program.account.declarationEntry.fetch(entry)
    expect(after.notAfter?.toNumber()).toBe(narrowed)
    expect(after.notAfter?.toNumber()).toBeLessThan(Number(before.notAfter?.toNumber()))
    // Narrowing is not a resubmission: the entry keeps its identity, its start and
    // the moment it became effective, so nothing it already permitted moves.
    expect(after.notBefore.toNumber()).toBe(before.notBefore.toNumber())
    expect(after.submittedAt.toNumber()).toBe(before.submittedAt.toNumber())
    expect(after.effectiveAt.toNumber()).toBe(before.effectiveAt.toNumber())
    expect(after.revokedAt).toBe(null)
  })

  it('bounds a permanent entry', async () => {
    const { entry, seq } = await submitDeclaration(program, target, {
      notAfter: null,
      movesFunds: false,
    })
    const bounded = now() + 30 * 86_400

    // A permanent entry permits the most there is, so any end at all narrows it.
    await revokeDeclaration(program, target, seq, bounded)

    expect((await program.account.declarationEntry.fetch(entry)).notAfter?.toNumber()).toBe(bounded)
  })

  it('refuses a wider window', async () => {
    const { seq } = await submitDeclaration(program, target, { notAfter: now() + 10 * 86_400 })

    // Widening is what the declaration delay exists to slow down, so it goes through
    // a new entry rather than an edit that lands immediately.
    const error = await revokeDeclaration(program, target, seq, now() + 20 * 86_400).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('DeclarationWindowNotNarrower')
  })

  it('refuses a window pulled back into the past', async () => {
    const { seq } = await submitDeclaration(program, target, { notBefore: now() - 7_200 })

    // Would un-declare operations already performed while the entry was effective —
    // an incident, and a payout, against a protocol that did nothing wrong.
    const error = await revokeDeclaration(program, target, seq, now() - 3_600).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('NarrowedWindowEndsInThePast')
  })

  it('refuses to touch an entry that is already revoked', async () => {
    const { seq } = await submitDeclaration(program, target)
    await revokeDeclaration(program, target, seq)

    const revokedAgain = await revokeDeclaration(program, target, seq).catch(
      (thrown: unknown) => thrown,
    )
    expect(revokedAgain).toBeInstanceOf(AnchorError)
    expect((revokedAgain as AnchorError).error.errorCode.code).toBe('DeclarationRevoked')

    const narrowed = await revokeDeclaration(program, target, seq, now() + 3_600).catch(
      (thrown: unknown) => thrown,
    )
    expect((narrowed as AnchorError).error.errorCode.code).toBe('DeclarationRevoked')
  })

  it('refuses another protocol reaching for this entry', async () => {
    const { seq } = await submitDeclaration(program, target)
    const other = await registerProtocol(program, env)

    // The entry stores no protocol of its own, so this is the check that keeps one
    // protocol's authority away from another's declaration: the seeds are derived
    // from the protocol passed in, and they will not match.
    const error = await program.methods
      .revokeDeclaration(new BN(seq), null)
      .accountsPartial({
        protocol: other.protocol,
        authority: other.authority.publicKey,
        entry: findDeclarationEntry(program.programId, target.protocol, seq),
      })
      .signers([other.authority])
      .rpc()
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('ConstraintSeeds')
  })

  it('refuses anyone but the protocol authority', async () => {
    const { seq } = await submitDeclaration(program, target)
    const stranger = await env.fundedKeypair(1)

    const error = await program.methods
      .revokeDeclaration(new BN(seq), null)
      .accountsPartial({
        protocol: target.protocol,
        authority: stranger.publicKey,
        entry: findDeclarationEntry(program.programId, target.protocol, seq),
      })
      .signers([stranger])
      .rpc()
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('ConstraintHasOne')
  })
})
