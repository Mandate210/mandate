import { AnchorError, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findPool, findProtocol } from '@drain-cover/sdk'
import { getAccount } from '@solana/spl-token'
import { Keypair, type PublicKey, SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, setupTestEnv, validatorReachable } from './harness'
import { ensureConfig } from './world'

const reachable = await validatorReachable()

describe.skipIf(!reachable)('register_protocol', () => {
  let env: TestEnv
  let program: Program<DrainCover>

  const register = (
    protocolId: PublicKey,
    privileged: PublicKey[],
    admin = env.payer,
  ): Promise<string> =>
    program.methods
      .registerProtocol(
        protocolId,
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        privileged,
      )
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
    await ensureConfig(program, env)
  })

  it('creates the protocol, its pool and a vault the pool owns', async () => {
    const protocolId = Keypair.generate().publicKey
    const privileged = [
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ]

    await register(protocolId, privileged)

    const protocolPda = findProtocol(program.programId, protocolId)
    const poolPda = findPool(program.programId, protocolPda)

    const protocol = await program.account.protocol.fetch(protocolPda)
    expect(protocol.privileged.map((key) => key.toBase58())).toEqual(
      privileged.map((key) => key.toBase58()),
    )
    expect(protocol.pool.equals(poolPda)).toBe(true)
    expect(protocol.newPoliciesPaused).toBe(false)
    // Sequences start at zero; policies, declarations and incidents are addressed
    // off these counters.
    expect(protocol.nextPolicySeq.toNumber()).toBe(0)
    expect(protocol.nextDeclarationSeq.toNumber()).toBe(0)
    expect(protocol.nextIncidentSeq.toNumber()).toBe(0)

    const pool = await program.account.pool.fetch(poolPda)
    expect(pool.totalAssets.toNumber()).toBe(0)
    expect(pool.totalShares.toNumber()).toBe(0)
    expect(pool.lockedLimit.toNumber()).toBe(0)
    expect(pool.openIncidents).toBe(0)
    expect(pool.accPremiumPerShare.toNumber()).toBe(0)

    // The pool owns its vault, so capital can only leave when the program signs for
    // it — and the vault holds the settlement asset, not some other token (FR-002,
    // FR-014).
    const vault = await getAccount(env.connection, pool.vault)
    expect(vault.owner.equals(poolPda)).toBe(true)
    expect(vault.mint.equals(env.assetMint)).toBe(true)
    expect(vault.amount).toBe(0n)
  })

  it('gives each protocol its own pool and vault', async () => {
    const first = Keypair.generate().publicKey
    const second = Keypair.generate().publicKey

    await register(first, [Keypair.generate().publicKey])
    await register(second, [Keypair.generate().publicKey])

    const firstPool = await program.account.pool.fetch(
      findPool(program.programId, findProtocol(program.programId, first)),
    )
    const secondPool = await program.account.pool.fetch(
      findPool(program.programId, findProtocol(program.programId, second)),
    )

    // Isolation is structural: there is no shared store to draw from by mistake.
    expect(firstPool.vault.equals(secondPool.vault)).toBe(false)
  })

  it('rejects a repeated privileged address', async () => {
    const repeated = Keypair.generate().publicKey
    const error = await register(Keypair.generate().publicKey, [
      repeated,
      Keypair.generate().publicKey,
      repeated,
    ]).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('DuplicatePrivilegedAddress')
  })

  it('rejects an empty privileged list', async () => {
    const error = await register(Keypair.generate().publicKey, []).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('NoPrivilegedAddresses')
  })

  it('refuses anyone but the admin', async () => {
    const stranger = await env.fundedKeypair(5)
    await expect(
      register(Keypair.generate().publicKey, [Keypair.generate().publicKey], stranger),
    ).rejects.toThrow()
  })
})
