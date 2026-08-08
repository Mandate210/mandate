import type { Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig, findIncident } from '@drain-cover/sdk'
import { getAccount } from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, setupTestEnv, validatorReachable } from './harness'
import {
  type RegisteredProtocol,
  admitQuorumSet,
  attest,
  ensureConfig,
  fundPool,
  issuePolicy,
  openIncident,
  quorumNeeded,
  registerProtocol,
  releaseAttestors,
  resolve,
  triggerSignature,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(400_000)
const RETENTION = asset(40_000)
const PREMIUM = asset(3_000)
/** What SC-006 says the beneficiary gets, computed the way the spec words it. */
const PAYABLE = LIMIT - RETENTION

/**
 * US1 end to end, in the order the story happens: capital, cover, a privileged
 * transaction nobody declared, independent verdicts, money in the treasury.
 *
 * The instruction suites next to this one each prove one step in isolation. This one
 * exists for what only shows up across steps — that the accounting adds up from an
 * empty pool to a settled incident, and that the amount at the end is the one SC-006
 * promises, to the base unit. The stages run in order and share state on purpose: it
 * is one run through the product, not six independent checks.
 *
 * The trigger transaction is still a claim made by hand here. Deciding *when* to make
 * that claim — matching a privileged transaction against the declarations — is the
 * attestor's job and arrives with 2b (T024, T027).
 */
describe.skipIf(!reachable)('US1 — the full cycle to a payout', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let attestors: Keypair[]
  let quorumBps: number

  let target: RegisteredProtocol
  let policySeq: number
  let policy: PublicKey
  let beneficiaryToken: PublicKey

  let incidentSeq: number
  let opener: Keypair
  let bond: bigint
  let triggerSig: number[]
  /** One per attestor that voted, in the order they voted. */
  const attestations: PublicKey[] = []
  let needed: number

  const incidentAccount = () => findIncident(program.programId, target.protocol, incidentSeq)

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)

    // The set has to be complete an epoch before the incident exists (FR-008), so it
    // is the one thing that cannot be part of the story below.
    attestors = await admitQuorumSet(program, env)
    quorumBps = (await program.account.config.fetch(findConfig(program.programId))).quorumBps
  })

  afterAll(async () => {
    if (attestors !== undefined) await releaseAttestors(program, env, attestors)
  })

  it('opens with capital in the pool and cover the premium paid for', async () => {
    target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)

    const issued = await issuePolicy(program, env, target, {
      limit: LIMIT,
      retention: RETENTION,
      premium: PREMIUM,
    })
    policySeq = issued.seq
    policy = issued.policy
    beneficiaryToken = await env.assetAccount(issued.beneficiary)

    const pool = await program.account.pool.fetch(target.pool)
    // The premium is capital like any other from the moment it lands (FR-018 splits it
    // between underwriters later; there are no shares to split it between yet).
    expect(BigInt(pool.totalAssets.toString())).toBe(CAPITAL + PREMIUM)
    expect(BigInt(pool.lockedLimit.toString())).toBe(LIMIT)
    expect(pool.openIncidents).toBe(0)
    expect((await getAccount(env.connection, target.vault)).amount).toBe(CAPITAL + PREMIUM)

    const stored = await program.account.policy.fetch(policy)
    // FR-005: paid for, and therefore in force.
    expect(BigInt(stored.premiumPaid.toString())).toBe(PREMIUM)
    expect(stored.status).toEqual({ active: {} })
    expect(BigInt(stored.remainingLimit.toString())).toBe(LIMIT)
  })

  it('records the privileged transaction as a claim, backed by a bond', async () => {
    triggerSig = triggerSignature(3)
    const opened = await openIncident(program, env, target, policySeq, { triggerSig })
    incidentSeq = opened.seq
    opener = opened.opener
    bond = opened.bond

    const incident = await program.account.incident.fetch(incidentAccount())
    expect(incident.status).toEqual({ open: {} })
    expect([...incident.triggerSig]).toEqual(triggerSig)
    expect(incident.policy.equals(policy)).toBe(true)

    const pool = await program.account.pool.fetch(target.pool)
    expect(pool.openIncidents).toBe(1)
    // Nothing about the cover changed by claiming: the capital is frozen against
    // withdrawal, not spent, and the bond is not the pool's until the incident ends.
    expect(BigInt(pool.totalAssets.toString())).toBe(CAPITAL + PREMIUM)
    expect(BigInt(pool.lockedLimit.toString())).toBe(LIMIT)
    expect((await getAccount(env.connection, target.vault)).amount).toBe(CAPITAL + PREMIUM + bond)
  })

  it('moves no money while the attestations are short of the quorum', async () => {
    const incident = await program.account.incident.fetch(incidentAccount())
    needed = quorumNeeded(incident.setSize, quorumBps)
    const beneficiaryBefore = (await getAccount(env.connection, beneficiaryToken)).amount

    for (const attestor of attestors.slice(0, needed - 1)) {
      attestations.push(await attest(program, target, incidentSeq, attestor))
    }

    const tallied = await program.account.incident.fetch(incidentAccount())
    expect(tallied.votesUnauthorized).toBe(needed - 1)
    expect(tallied.status).toEqual({ open: {} })
    // A verdict is not a decision: nothing has been paid, and the treasury has not
    // been credited a unit.
    expect((await getAccount(env.connection, beneficiaryToken)).amount).toBe(beneficiaryBefore)
    expect((await getAccount(env.connection, target.vault)).amount).toBe(CAPITAL + PREMIUM + bond)
  })

  it('pays the beneficiary exactly the limit less the retention (SC-006)', async () => {
    // `admitQuorumSet` admits enough for its own votes to carry the quorum, so this is
    // an invariant of the harness rather than a case to handle.
    const decisive = attestors[needed - 1]
    if (decisive === undefined) {
      throw new Error(`${attestors.length} attestors admitted for a quorum of ${needed}`)
    }

    attestations.push(await attest(program, target, incidentSeq, decisive))
    expect((await program.account.incident.fetch(incidentAccount())).votesUnauthorized).toBe(needed)

    const beneficiaryBefore = (await getAccount(env.connection, beneficiaryToken)).amount
    const openerToken = await env.assetAccount(opener.publicKey)
    const openerBefore = (await getAccount(env.connection, openerToken)).amount

    // Nobody signs for this, and nothing about it is discretionary (FR-012).
    await resolve(program, env, target, incidentSeq)

    // SC-006 with zero discrepancy: one dollar-denominated asset, an absolute
    // retention and no conversion anywhere, so there is nothing to round.
    expect((await getAccount(env.connection, beneficiaryToken)).amount).toBe(
      beneficiaryBefore + PAYABLE,
    )

    const incident = await program.account.incident.fetch(incidentAccount())
    expect(incident.status).toEqual({ paidOut: {} })
    expect(BigInt(incident.payout.toString())).toBe(PAYABLE)
    // The pool had far more than it owed, so nothing was left unpaid (FR-013).
    expect(incident.shortfall.toNumber()).toBe(0)
    // The claim held, so the bond goes back to the one who staked it.
    expect((await getAccount(env.connection, openerToken)).amount).toBe(openerBefore + bond)

    const pool = await program.account.pool.fetch(target.pool)
    expect(pool.openIncidents).toBe(0)
    // FR-015: cover and capital fall by the same amount…
    expect(BigInt(pool.totalAssets.toString())).toBe(CAPITAL + PREMIUM - PAYABLE)
    const spent = await program.account.policy.fetch(policy)
    expect(BigInt(spent.remainingLimit.toString())).toBe(LIMIT - PAYABLE)
    // …and what is left of the limit is the retention, which is never payable, so the
    // policy is spent and the pool reserves nothing for it any more.
    expect(spent.status).toEqual({ exhausted: {} })
    expect(BigInt(pool.lockedLimit.toString())).toBe(0n)
  })

  it('leaves the decision reconstructible from chain state alone', async () => {
    const incident = await program.account.incident.fetch(incidentAccount())

    // The trigger transaction, the verdicts that carried it and the amount are all on
    // chain and readable without our indexer (FR-011; SC-007 goes further in T056).
    expect([...incident.triggerSig]).toEqual(triggerSig)
    expect(incident.votesUnauthorized).toBe(needed)
    expect(incident.votesAuthorized).toBe(0)
    expect(attestations).toHaveLength(needed)

    for (const address of attestations) {
      const attestation = await program.account.attestation.fetch(address)
      expect(attestation.verdict).toEqual({ unauthorized: {} })
      expect(attestation.submittedAt.toNumber()).toBeGreaterThan(0)
      expect(attestation.submittedAt.toNumber()).toBeLessThanOrEqual(incident.deadline.toNumber())
    }
  })

  it('accounts for every unit that passed through the vault', async () => {
    const pool = await program.account.pool.fetch(target.pool)
    const vault = (await getAccount(env.connection, target.vault)).amount

    // In: capital, premium, bond. Out: payout, bond. What stays is what the pool says
    // it has — the bond never belonged to it, and nothing else was created or lost.
    expect(vault).toBe(CAPITAL + PREMIUM + bond - PAYABLE - bond)
    expect(vault).toBe(BigInt(pool.totalAssets.toString()))
  })
})
