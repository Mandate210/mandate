import type { Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram } from '@mandate/sdk'
import { LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, setupTestEnv, validatorReachable } from './harness'
import {
  type RegisteredProtocol,
  admitQuorumSet,
  attest,
  ensureConfig,
  fundPool,
  issuePolicy,
  openIncident,
  registerProtocol,
  releaseAttestors,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(200_000)
const RETENTION = asset(20_000)
const PREMIUM = asset(1_500)

/** Solana's base fee. Priority fees are measured on devnet instead (T029). */
const LAMPORTS_PER_SIGNATURE = 5_000
/** The price the budget in `docs/PLAN.md` → «Бюджет комісій на інцидент» assumes. */
const SOL_PRICE_USD = 200
/** SC-008: one dollar per incident, from opening to payout. */
const SC008_BUDGET_LAMPORTS = LAMPORTS_PER_SOL / SOL_PRICE_USD
/** The incident `docs/PLAN.md` budgets for: five votes, the last of which settles. */
const REFERENCE_ATTESTORS = 5

// Ceilings, not equalities, and deliberately close to what is measured today:
// 2_220_240 for the incident and 1_009_200 per attestation, both a function of the
// account layouts alone. Adding a field to either account moves them, and this test is
// here so that happens as a decision rather than as a surprise — which is why it sits
// in 2a, before the number of accounts per incident settles (T064).
const INCIDENT_RENT_CEILING = 2_250_000
const ATTESTATION_RENT_CEILING = 1_020_000
/** Incident plus five attestations. Measured today: 7_266_240. */
const REFERENCE_RENT_CEILING = 7_500_000

/**
 * What one incident costs, from opening to payout, in lamports rather than in a model.
 *
 * Two costs, and they are not the same kind of thing. **Fees** are spent and gone, and
 * they are what SC-008 caps. **Rent** is a deposit the accounts hold: recoverable in
 * principle, but nobody recovers it today, because the incident and its attestations
 * stay on chain as the public trail (FR-011). The reference incident locks about 1.45
 * USD of it, which is why closing those accounts is still an open question rather than
 * a decision (`docs/PLAN.md` → «Бюджет комісій на інцидент»).
 */
describe.skipIf(!reachable)('SC-008 — what one incident costs', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  /** Votes cast until the decision — however many the deployment's set demanded. The
   * cost per attestation is what matters here, not how many this ledger needed. */
  let attestorCount: number
  let incident: PublicKey
  let attestations: PublicKey[]
  let transactions: number
  /** Fees actually charged for this incident's transactions. */
  let fees: number
  /** The newest transaction on the incident — the one that settled it. */
  let settledBy: string
  /** The vote that completed the quorum. */
  let decidingVote: string
  let incidentRent: number
  let attestationRent: number

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)

    const attestors = await admitQuorumSet(program, env)

    const target: RegisteredProtocol = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
    const policySeq = (
      await issuePolicy(program, env, target, {
        limit: LIMIT,
        retention: RETENTION,
        premium: PREMIUM,
      })
    ).seq

    incident = (await openIncident(program, env, target, policySeq)).incident
    attestations = []
    decidingVote = ''
    for (const attestor of attestors) {
      const { attestation, signature } = await attest(program, target, incident, attestor)
      attestations.push(attestation)
      if (!('open' in (await program.account.incident.fetch(incident)).status)) {
        decidingVote = signature
        break
      }
    }
    attestorCount = attestations.length
    await releaseAttestors(program, env, attestors)

    // Every transaction that touched this incident, which is exactly its lifetime:
    // the opening and the votes, the last of which settled it (T078). Newest first.
    const signatures = await env.connection.getSignaturesForAddress(incident, { limit: 100 })
    transactions = signatures.length
    fees = 0
    settledBy = signatures[0]?.signature ?? ''
    for (const { signature } of signatures) {
      const transaction = await env.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      const fee = transaction?.meta?.fee ?? 0
      fees += fee
    }

    incidentRent = await env.connection.getBalance(incident)
    const [first] = attestations
    if (first === undefined) throw new Error('no attestations were recorded')
    attestationRent = await env.connection.getBalance(first)
  }, 180_000)

  it('takes one transaction to open and one per vote — the deciding vote settles', async () => {
    expect(transactions).toBe(attestorCount + 1)
    // FR-012 in transactions: the payout is the vote that decided it, so there is no
    // further step, and nobody else's signature, that the money waits on.
    expect(settledBy).toBe(decidingVote)
  })

  it('keeps the fees for the reference incident inside one dollar', async () => {
    // Opening and five votes, the last of them settling: one signature each in
    // production, where each party sends its own transaction.
    const referenceFees = (REFERENCE_ATTESTORS + 1) * LAMPORTS_PER_SIGNATURE
    expect(referenceFees).toBeLessThanOrEqual(SC008_BUDGET_LAMPORTS)

    // And the fees this test really paid are under the cap too, even though every
    // transaction here carries a second signature: the provider wallet pays, so the
    // opener and the attestors sign alongside it rather than instead of it.
    expect(fees).toBeLessThanOrEqual(SC008_BUDGET_LAMPORTS)
    expect(fees).toBeLessThanOrEqual((attestorCount + 1) * 2 * LAMPORTS_PER_SIGNATURE)
  })

  it('locks a known amount of rent per incident and per attestation', async () => {
    expect(incidentRent).toBeLessThanOrEqual(INCIDENT_RENT_CEILING)
    expect(attestationRent).toBeLessThanOrEqual(ATTESTATION_RENT_CEILING)

    // Not a fee — a deposit, and the reason SC-008 holds while about 1.45 USD per
    // incident stays locked up. Nothing releases it today: the trail outlives the
    // incident (FR-011), and whether to close those accounts is still open.
    const referenceRent = incidentRent + REFERENCE_ATTESTORS * attestationRent
    expect(referenceRent).toBeLessThanOrEqual(REFERENCE_RENT_CEILING)
    expect(referenceRent).toBeGreaterThan(SC008_BUDGET_LAMPORTS)
  })
})
