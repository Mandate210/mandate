import { randomBytes } from 'node:crypto'
import { BN, type Program } from '@coral-xyz/anchor'
import {
  type DrainCover,
  PROGRAM_ID,
  findAttestation,
  findAttestor,
  findConfig,
  findDeclarationEntry,
  findIncident,
  findPolicy,
  findPool,
  findPosition,
  findProtocol,
  findVault,
} from '@mandate/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, Keypair, type PublicKey, SystemProgram } from '@solana/web3.js'
import { type TestEnv, testRpcUrl, waitForNextEpoch } from './harness'

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
  /**
   * Ninety seconds, where the product parameter is hours.
   *
   * `close_expired_incident` only acts once a deadline has passed, and the deadline
   * comes from this window — there is no way to fast-forward the cluster clock, so a
   * realistic window would put that path out of reach of any test. Squeezed from the
   * other side by every suite that opens an incident and attests on it: those
   * sequences cross an epoch boundary (~13s) and run several transactions, so the
   * window has to stay several times longer than that.
   */
  attestWindow: 90,
  quorumBps: 6_000,
  openBond: 1_000_000,
  /**
   * Twenty seconds, where the recommended product value is seven days — for the same
   * reason as `attestWindow`: completing a withdrawal (T033) waits for `unlock_ts` on
   * the real cluster clock. Longer than one epoch crossing, so a test can still tell a
   * request that is waiting from one that has matured.
   */
  withdrawDelay: 20,
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
      new BN(CONFIG_PARAMS.withdrawDelay),
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

/**
 * Admits an attestor to the permissive set, or removes one (FR-008). Returns the
 * account so a caller can read back when membership starts.
 */
export const setAttestor = async (
  program: Program<DrainCover>,
  env: TestEnv,
  attestorAuthority: PublicKey,
  inSet = true,
): Promise<PublicKey> => {
  await program.methods
    .setAttestor(attestorAuthority, inSet)
    .accountsPartial({
      admin: env.payer.publicKey,
      attestor: findAttestor(program.programId, attestorAuthority),
      systemProgram: SystemProgram.programId,
    })
    .rpc()

  return findAttestor(program.programId, attestorAuthority)
}

/**
 * A funded attestor that can vote on incidents opened from the next epoch on.
 *
 * The wait is not incidental: membership starts with the following epoch (FR-008),
 * so an attestor admitted and used in the same epoch would be refused by the program.
 * Admit everyone first and cross the boundary once — the wait is per epoch, not per
 * attestor.
 */
export const admitAttestor = async (
  program: Program<DrainCover>,
  env: TestEnv,
  sol = 2,
): Promise<Keypair> => {
  const keypair = await env.fundedKeypair(sol)
  await setAttestor(program, env, keypair.publicKey)
  return keypair
}

/**
 * Attestations an incident of this set size needs, mirroring `quorum_threshold` in
 * `settlement.rs`. Rounded up in both places — a test that rounded the
 * other way would agree with itself and disagree with the program.
 */
export const quorumNeeded = (setSize: number, quorumBps: number): number =>
  Math.ceil((setSize * quorumBps) / 10_000)

/**
 * Admits as many attestors as it takes for this file's own votes to carry a quorum,
 * and crosses the epoch boundary once so they can all vote.
 *
 * The set is global to the deployment and other files admit into it, so a suite
 * cannot assume it starts from nothing: the quorum denominator is whatever the count
 * happens to be when the incident opens. Hence the smallest `k` with
 * `quorumNeeded(existing + k) <= k`, computed rather than guessed.
 */
export const admitQuorumSet = async (
  program: Program<DrainCover>,
  env: TestEnv,
): Promise<Keypair[]> => {
  const config = await program.account.config.fetch(findConfig(program.programId))
  const existing = config.attestorCount

  let needed = 1
  while (quorumNeeded(existing + needed, config.quorumBps) > needed) needed += 1

  const attestors = await Promise.all(Array.from({ length: needed }, () => env.fundedKeypair(1)))
  for (const attestor of attestors) {
    await setAttestor(program, env, attestor.publicKey)
  }
  await waitForNextEpoch(env.connection)

  return attestors
}

/** Takes a file's attestors back out of the set, so the next file starts smaller. */
export const releaseAttestors = async (
  program: Program<DrainCover>,
  env: TestEnv,
  attestors: Keypair[],
): Promise<void> => {
  for (const attestor of attestors) {
    await setAttestor(program, env, attestor.publicKey, false)
  }
}

/**
 * Sixty-four bytes standing in for a transaction signature.
 *
 * Random by default, because the signature is now the incident's address: two
 * incidents on one protocol with the same bytes are one incident, and a suite that
 * reused a constant would trip over its own earlier tests on a shared ledger. A
 * `fill` pins the bytes where a test wants to recognise them afterwards.
 */
export const triggerSignature = (fill?: number): number[] =>
  fill === undefined ? [...randomBytes(64)] : Array.from({ length: 64 }, () => fill)

export interface OpenedIncident {
  /** Derived from the protocol and the trigger signature (T070). */
  incident: PublicKey
  /** Funded, holds no more asset than the bond it just paid. */
  opener: Keypair
  bond: bigint
  triggerSig: number[]
}

/** Opens an incident against `policySeq` of `target`, paying the bond from a fresh opener. */
export const openIncident = async (
  program: Program<DrainCover>,
  env: TestEnv,
  target: RegisteredProtocol,
  policySeq: number,
  options: { opener?: Keypair; triggerSig?: number[] } = {},
): Promise<OpenedIncident> => {
  const config = await program.account.config.fetch(findConfig(program.programId))
  const bond = BigInt(config.openBond.toString())
  const opener = options.opener ?? (await env.fundedKeypair(2))
  const triggerSig = options.triggerSig ?? triggerSignature()
  const bondSource = await env.assetAccount(opener.publicKey, bond)

  const incident = findIncident(program.programId, target.protocol, triggerSig)

  await program.methods
    .openIncident(new BN(policySeq), triggerSig)
    .accountsPartial({
      opener: opener.publicKey,
      protocol: target.protocol,
      pool: target.pool,
      policy: findPolicy(program.programId, target.protocol, policySeq),
      incident,
      bondSource,
      vault: target.vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([opener])
    .rpc()

  return { incident, opener, bond, triggerSig }
}

export interface Attested {
  attestation: PublicKey
  /** The transaction — the payout too, when this vote completed the quorum (T078). */
  signature: string
}

/**
 * One attestor's verdict on an open incident (FR-007). The incident is named by its
 * address and nothing else: the program verifies it against the signature the account
 * stores, so there is no sequence number to pass.
 *
 * Every vote carries what the deciding one settles with — the program takes the same
 * accounts whatever the tally (`attest.rs`). The token accounts are the associated ones,
 * derived, never created here: the deciding vote opens them if they are missing.
 * `beneficiaryToken` is overridable only to show that nothing else is accepted.
 */
export const attest = async (
  program: Program<DrainCover>,
  target: RegisteredProtocol,
  incident: PublicKey,
  attestor: Keypair,
  verdict: 'unauthorized' | 'authorized' = 'unauthorized',
  overrides: { beneficiaryToken?: PublicKey } = {},
): Promise<Attested> => {
  const attestation = findAttestation(program.programId, incident, attestor.publicKey)
  const stored = await program.account.incident.fetch(incident)
  const [policy, { assetMint }] = await Promise.all([
    program.account.policy.fetch(stored.policy),
    program.account.config.fetch(findConfig(program.programId)),
  ])

  const signature = await program.methods
    .attest(verdict === 'unauthorized' ? { unauthorized: {} } : { authorized: {} })
    .accountsPartial({
      protocol: target.protocol,
      incident,
      attestorAuthority: attestor.publicKey,
      attestor: findAttestor(program.programId, attestor.publicKey),
      attestation,
      pool: target.pool,
      policy: stored.policy,
      vault: target.vault,
      assetMint,
      beneficiary: policy.beneficiary,
      beneficiaryToken:
        overrides.beneficiaryToken ??
        getAssociatedTokenAddressSync(assetMint, policy.beneficiary, true),
      opener: stored.opener,
      openerToken: getAssociatedTokenAddressSync(assetMint, stored.opener, true),
      systemProgram: SystemProgram.programId,
    })
    .signers([attestor])
    .rpc()

  return { attestation, signature }
}

/**
 * Votes `unauthorized` with each attestor in turn until the incident is settled, and
 * returns the vote that settled it — the payout's transaction (FR-012). Throws if the
 * attestors run out first: a caller that expected a quorum and did not get one has a
 * broken premise, not a result.
 */
export const attestToQuorum = async (
  program: Program<DrainCover>,
  target: RegisteredProtocol,
  incident: PublicKey,
  attestors: Keypair[],
): Promise<Attested & { attestor: Keypair }> => {
  for (const attestor of attestors) {
    const attested = await attest(program, target, incident, attestor)
    const { status } = await program.account.incident.fetch(incident)
    if (!('open' in status)) return { ...attested, attestor }
  }
  throw new Error(`incident ${incident.toBase58()} still open after ${attestors.length} votes`)
}

/**
 * Closes an incident whose window ran out without a quorum (FR-011). Permissionless,
 * so the caller is only paying the fee.
 */
export const closeExpiredIncident = async (
  program: Program<DrainCover>,
  env: TestEnv,
  target: RegisteredProtocol,
  incident: PublicKey,
): Promise<void> => {
  const stored = await program.account.incident.fetch(incident)

  await program.methods
    .closeExpiredIncident()
    .accountsPartial({
      protocol: target.protocol,
      pool: target.pool,
      policy: stored.policy,
      incident,
      vault: target.vault,
      openerToken: await env.assetAccount(stored.opener),
    })
    .rpc()
}

/**
 * Gives back the reservation of a policy whose period has ended (FR-020, T067).
 * Permissionless: the caller only pays the fee.
 */
export const releaseExpiredPolicy = async (
  program: Program<DrainCover>,
  target: RegisteredProtocol,
  seq: number,
): Promise<void> => {
  await program.methods
    .releaseExpiredPolicy(new BN(seq))
    .accountsPartial({
      protocol: target.protocol,
      pool: target.pool,
      policy: findPolicy(program.programId, target.protocol, seq),
    })
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

export interface DepositResult {
  underwriter: Keypair
  position: PublicKey
}

/**
 * Capital into a pool from an address with no standing in the system (FR-017) — no
 * admin, no allow-list, nothing but a signature and the asset.
 *
 * A fresh underwriter per call unless one is passed: a position belongs to an
 * address, so reusing one turns the next deposit into the add-to-an-existing-position
 * path, which is a different test.
 */
export const deposit = async (
  program: Program<DrainCover>,
  env: TestEnv,
  target: RegisteredProtocol,
  amount: bigint,
  underwriter?: Keypair,
): Promise<DepositResult> => {
  const owner = underwriter ?? (await env.fundedKeypair(2))
  const source = await env.assetAccount(owner.publicKey, amount)
  const position = findPosition(program.programId, target.pool, owner.publicKey)

  await program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial({
      underwriter: owner.publicKey,
      protocol: target.protocol,
      pool: target.pool,
      position,
      vault: target.vault,
      source,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner])
    .rpc()

  return { underwriter: owner, position }
}

/**
 * Starts the wait on withdrawing `shares` of `underwriter`'s position (FR-019, T032).
 * `position` is passed rather than derived so that a test can offer somebody else's.
 */
export const requestWithdraw = async (
  program: Program<DrainCover>,
  target: RegisteredProtocol,
  underwriter: Keypair,
  shares: bigint,
  position: PublicKey = findPosition(program.programId, target.pool, underwriter.publicKey),
): Promise<void> => {
  await program.methods
    .requestWithdraw(new BN(shares.toString()))
    .accountsPartial({
      underwriter: underwriter.publicKey,
      pool: target.pool,
      position,
    })
    .signers([underwriter])
    .rpc()
}
