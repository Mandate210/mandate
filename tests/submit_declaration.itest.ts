import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig, findDeclarationEntry } from '@mandate/sdk'
import { Keypair, SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, setupTestEnv, validatorReachable } from './harness'
import { type RegisteredProtocol, ensureConfig, registerProtocol, submitDeclaration } from './world'

const reachable = await validatorReachable()
const DISCRIMINATOR = [17, 34, 51, 68, 85, 102, 119, 136]

describe.skipIf(!reachable)('submit_declaration', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol
  let declarationDelay: number

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    target = await registerProtocol(program, env)
    // Read rather than assumed: another file may have created the config, and the
    // delay is what every assertion about effectiveness here is measured against.
    declarationDelay = (
      await program.account.config.fetch(findConfig(program.programId))
    ).declarationDelay.toNumber()
  })

  it('records the entry and holds it back by the declaration delay', async () => {
    const declaredProgram = Keypair.generate().publicKey
    const notBefore = Math.floor(Date.now() / 1000) + 7 * 86_400
    const notAfter = notBefore + 3_600

    const { entry, seq } = await submitDeclaration(program, target, {
      declaredProgram,
      ixDiscriminator: DISCRIMINATOR,
      notBefore,
      notAfter,
      movesFunds: true,
    })

    expect(seq).toBe(0)
    const stored = await program.account.declarationEntry.fetch(entry)
    expect(stored.programId.equals(declaredProgram)).toBe(true)
    // Program id and discriminator are machine equality, which is what lets
    // independent attestors reach the same verdict (FR-006, docs/PLAN.md → R-2).
    expect([...stored.ixDiscriminator]).toEqual(DISCRIMINATOR)
    expect(stored.notBefore.toNumber()).toBe(notBefore)
    expect(stored.notAfter?.toNumber()).toBe(notAfter)
    expect(stored.movesFunds).toBe(true)
    expect(stored.revokedAt).toBe(null)

    // FR-031: the entry covers nothing until the delay has passed, and the delay is
    // counted from the chain's clock, not from whatever the submitter claims.
    expect(stored.effectiveAt.toNumber()).toBe(stored.submittedAt.toNumber() + declarationDelay)
    expect(stored.effectiveAt.toNumber()).toBeGreaterThan(stored.submittedAt.toNumber())

    expect(
      (await program.account.protocol.fetch(target.protocol)).nextDeclarationSeq.toNumber(),
    ).toBe(1)
  })

  it('gives the next entry its own address', async () => {
    const { entry, seq } = await submitDeclaration(program, target)

    expect(seq).toBe(1)
    expect(entry.equals(findDeclarationEntry(program.programId, target.protocol, 1))).toBe(true)
    expect(entry.equals(findDeclarationEntry(program.programId, target.protocol, 0))).toBe(false)
  })

  it('accepts a permanent window for an operation that moves no funds', async () => {
    // The case FR-035 exists to allow: an emergency pause cannot be planned into a
    // maintenance window, and it moves nothing.
    const { entry } = await submitDeclaration(program, target, {
      notAfter: null,
      movesFunds: false,
    })

    const stored = await program.account.declarationEntry.fetch(entry)
    expect(stored.notAfter).toBe(null)
    expect(stored.movesFunds).toBe(false)
  })

  it('refuses a permanent window for an operation that moves funds', async () => {
    // A permanent entry is inherited in full by whoever compromises the privileged
    // key, so allowing one here would put fund movement outside FR-006 in advance.
    const error = await submitDeclaration(program, target, {
      notAfter: null,
      movesFunds: true,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('PermanentWindowNotAllowed')
  })

  it('refuses a window that ends before it begins', async () => {
    const notBefore = Math.floor(Date.now() / 1000) + 7 * 86_400

    const error = await submitDeclaration(program, target, {
      notBefore,
      notAfter: notBefore - 1,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('InvalidDeclarationWindow')
  })

  it('refuses a window that closes before the entry takes effect', async () => {
    const now = Math.floor(Date.now() / 1000)

    // Well-formed and in the future, but it expires inside the delay — the protocol
    // would think the operation is declared while every attestor sees it as
    // undeclared. Caught here rather than becoming a false incident later.
    const error = await submitDeclaration(program, target, {
      notBefore: now,
      notAfter: now + declarationDelay - 600,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('DeclarationExpiresBeforeEffective')
  })

  it('refuses anyone but the protocol authority', async () => {
    const stranger = await env.fundedKeypair(1)
    const seq = (
      await program.account.protocol.fetch(target.protocol)
    ).nextDeclarationSeq.toNumber()
    const now = Math.floor(Date.now() / 1000)

    // The admin is not an exception either: a declaration is the protocol's own
    // statement, and the service operations of P1 stop short of it.
    const error = await program.methods
      .submitDeclaration(
        Keypair.generate().publicKey,
        DISCRIMINATOR,
        new BN(now),
        new BN(now + 40 * 86_400),
        true,
      )
      .accountsPartial({
        protocol: target.protocol,
        authority: stranger.publicKey,
        entry: findDeclarationEntry(program.programId, target.protocol, seq),
        systemProgram: SystemProgram.programId,
      })
      .signers([stranger])
      .rpc()
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('ConstraintHasOne')
  })

  it('keeps each protocol on its own sequence', async () => {
    const other = await registerProtocol(program, env)
    const { seq } = await submitDeclaration(program, other)

    // Counters live on Protocol, not in Config: a busy protocol must not push
    // another one's addresses around.
    expect(seq).toBe(0)
    expect(
      (await program.account.protocol.fetch(target.protocol)).nextDeclarationSeq.toNumber(),
    ).toBeGreaterThan(0)
  })
})
