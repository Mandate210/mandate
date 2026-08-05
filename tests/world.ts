import { BN, type Program } from '@coral-xyz/anchor'
import {
  type DrainCover,
  PROGRAM_ID,
  findConfig,
  findDeclarationEntry,
  findPolicy,
  findPool,
  findProtocol,
  findVault,
} from '@drain-cover/sdk'
import { Connection, Keypair, type PublicKey, SystemProgram } from '@solana/web3.js'
import { type TestEnv, testRpcUrl } from './harness'

/**
 * Shared starting state for integration files.
 *
 * `Config` is a singleton per program id, so the suites cannot each build their own.
 * Rather than depending on file order — which Vitest does not promise — every file
 * either creates the config or accepts the one already there, and the tests that
 * genuinely need a virgin ledger say so and skip.
 */
export const CONFIG_PARAMS = {
  declarationDelay: 86_400,
  attestWindow: 2 * 3600,
  quorumBps: 6_000,
  openBond: 1_000_000,
} as const

export const configPresent = async (): Promise<boolean> => {
  const connection = new Connection(testRpcUrl(), 'confirmed')
  return (await connection.getAccountInfo(findConfig(PROGRAM_ID))) !== null
}

export const initializeConfig = (
  program: Program<DrainCover>,
  env: TestEnv,
  quorumBps: number = CONFIG_PARAMS.quorumBps,
): Promise<string> =>
  program.methods
    .initialize(
      new BN(CONFIG_PARAMS.declarationDelay),
      new BN(CONFIG_PARAMS.attestWindow),
      quorumBps,
      new BN(CONFIG_PARAMS.openBond),
    )
    .accountsPartial({
      admin: env.payer.publicKey,
      assetMint: env.assetMint,
      systemProgram: SystemProgram.programId,
    })
    .rpc()

/**
 * Creates the config if this validator has none. Safe to call from every file and in
 * any order: the admin and the mint come from constant seeds (`harness.ts`), so a
 * config created by one file leaves the others with the same rights and the same
 * settlement asset. Nothing has to skip, and nothing depends on file order.
 */
export const ensureConfig = async (program: Program<DrainCover>, env: TestEnv): Promise<void> => {
  if (await configPresent()) return
  await initializeConfig(program, env)
}

export interface RegisteredProtocol {
  protocolId: PublicKey
  protocol: PublicKey
  pool: PublicKey
  /** Passed explicitly to every instruction that touches it: `address = pool.vault`
   * is not a seed, so Anchor's client cannot resolve it. */
  vault: PublicKey
  treasury: PublicKey
  /** A keypair, not an address: the authority signs declarations and pays for them,
   * so a test protocol whose authority cannot sign is a protocol that can never
   * declare anything. Funded here for the same reason. */
  authority: Keypair
}

/** A freshly registered protocol with its own pool, unrelated to any other test's. */
export const registerProtocol = async (
  program: Program<DrainCover>,
  env: TestEnv,
  privileged: PublicKey[] = [Keypair.generate().publicKey],
): Promise<RegisteredProtocol> => {
  const protocolId = Keypair.generate().publicKey
  const authority = await env.fundedKeypair(1)
  const treasury = Keypair.generate().publicKey

  await program.methods
    .registerProtocol(protocolId, authority.publicKey, treasury, privileged)
    .accountsPartial({
      admin: env.payer.publicKey,
      assetMint: env.assetMint,
      systemProgram: SystemProgram.programId,
    })
    .rpc()

  const protocol = findProtocol(program.programId, protocolId)
  const pool = findPool(program.programId, protocol)
  return {
    protocolId,
    protocol,
    pool,
    vault: findVault(env.assetMint, pool),
    treasury,
    authority,
  }
}

export interface PolicyTerms {
  limit: bigint
  retention: bigint
  premium: bigint
  startTs?: number
  endTs?: number
  beneficiary?: PublicKey
}

/** Issues a policy on `target`, taking the premium from the admin's asset account. */
export const issuePolicy = async (
  program: Program<DrainCover>,
  env: TestEnv,
  target: RegisteredProtocol,
  terms: PolicyTerms,
): Promise<{ policy: PublicKey; seq: number; beneficiary: PublicKey }> => {
  const now = Math.floor(Date.now() / 1000)
  const startTs = terms.startTs ?? now - 60
  const endTs = terms.endTs ?? now + 30 * 86_400
  const beneficiary = terms.beneficiary ?? target.treasury
  const premiumSource = await env.assetAccount(env.payer.publicKey, terms.premium)

  const seq = (await program.account.protocol.fetch(target.protocol)).nextPolicySeq.toNumber()

  await program.methods
    .issuePolicy(
      new BN(terms.limit.toString()),
      new BN(terms.retention.toString()),
      new BN(startTs),
      new BN(endTs),
      beneficiary,
      new BN(terms.premium.toString()),
    )
    .accountsPartial({
      admin: env.payer.publicKey,
      protocol: target.protocol,
      pool: target.pool,
      policy: findPolicy(program.programId, target.protocol, seq),
      vault: target.vault,
      premiumSource,
      systemProgram: SystemProgram.programId,
    })
    .rpc()

  return { policy: findPolicy(program.programId, target.protocol, seq), seq, beneficiary }
}

export interface DeclarationTerms {
  /** Program the declared instruction belongs to. */
  declaredProgram?: PublicKey
  /** Eight bytes, as on chain. Defaults to a marker that no real instruction has. */
  ixDiscriminator?: number[]
  notBefore?: number
  /** `null` is a permanent entry — only legal when `movesFunds` is false (FR-035). */
  notAfter?: number | null
  movesFunds?: boolean
}

/** Declares one permitted privileged operation, signed and paid for by the protocol. */
export const submitDeclaration = async (
  program: Program<DrainCover>,
  target: RegisteredProtocol,
  terms: DeclarationTerms = {},
): Promise<{ entry: PublicKey; seq: number }> => {
  const now = Math.floor(Date.now() / 1000)
  const notAfter = terms.notAfter === undefined ? now + 40 * 86_400 : terms.notAfter
  const seq = (await program.account.protocol.fetch(target.protocol)).nextDeclarationSeq.toNumber()
  const entry = findDeclarationEntry(program.programId, target.protocol, seq)

  await program.methods
    .submitDeclaration(
      terms.declaredProgram ?? Keypair.generate().publicKey,
      terms.ixDiscriminator ?? [1, 2, 3, 4, 5, 6, 7, 8],
      new BN(terms.notBefore ?? now),
      notAfter === null ? null : new BN(notAfter),
      terms.movesFunds ?? true,
    )
    .accountsPartial({
      protocol: target.protocol,
      authority: target.authority.publicKey,
      entry,
      systemProgram: SystemProgram.programId,
    })
    .signers([target.authority])
    .rpc()

  return { entry, seq }
}

/**
 * Withdraws what an entry permits, effective at once (FR-032). `narrowTo` omitted
 * revokes it outright; a timestamp shortens its window to end there.
 */
export const revokeDeclaration = async (
  program: Program<DrainCover>,
  target: RegisteredProtocol,
  seq: number,
  narrowTo?: number,
): Promise<void> => {
  await program.methods
    .revokeDeclaration(new BN(seq), narrowTo === undefined ? null : new BN(narrowTo))
    .accountsPartial({
      protocol: target.protocol,
      authority: target.authority.publicKey,
      entry: findDeclarationEntry(program.programId, target.protocol, seq),
    })
    .signers([target.authority])
    .rpc()
}

/** Capital in the pool without shares — the temporary service path (T014, gone in T036). */
export const fundPool = async (
  program: Program<DrainCover>,
  env: TestEnv,
  target: RegisteredProtocol,
  amount: bigint,
): Promise<void> => {
  const source = await env.assetAccount(env.payer.publicKey, amount)

  await program.methods
    .serviceFundPool(new BN(amount.toString()))
    .accountsPartial({
      admin: env.payer.publicKey,
      protocol: target.protocol,
      pool: target.pool,
      vault: target.vault,
      source,
    })
    .rpc()
}
