import { AnchorError, type Program } from '@coral-xyz/anchor'
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
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(300_000)
const RETENTION = asset(30_000)
const PREMIUM = asset(2_000)

/**
 * The boundaries of the US1 cycle, from the story's side: what it takes for a payout
 * *not* to happen, and what cannot be done to force one.
 *
 * Two edges named in the task are covered elsewhere and deliberately not repeated
 * here. **Shortfall (FR-013) has no reachable on-chain scenario in P1** — `issue_policy`
 * refuses a limit above free capital and a payout lowers capital and limit by the same
 * amount, so `total_assets >= locked_limit` holds in every state a test can build; the
 * arithmetic is unit-tested on `settle_payout` (docs/PLAN.md → «Виплата і недоплата»).
 * **A policy that lapses mid-incident** is in `close_expired_incident.itest.ts`, where
 * the incident it strands is also ended.
 */
describe.skipIf(!reachable)('US1 — edges', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let attestors: Keypair[]
  let quorumBps: number

  /** A protocol with capital and one policy, unentangled from the others here. */
  const covered = async (): Promise<[RegisteredProtocol, number, PublicKey]> => {
    const target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
    const { seq, policy } = await issuePolicy(program, env, target, {
      limit: LIMIT,
      retention: RETENTION,
      premium: PREMIUM,
    })
    return [target, seq, policy]
  }

  const incidentOn = (target: RegisteredProtocol, seq: number) =>
    findIncident(program.programId, target.protocol, seq)

  const votesNeededFor = async (target: RegisteredProtocol, seq: number): Promise<number> =>
    quorumNeeded((await program.account.incident.fetch(incidentOn(target, seq))).setSize, quorumBps)

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)

    attestors = await admitQuorumSet(program, env)
    quorumBps = (await program.account.config.fetch(findConfig(program.programId))).quorumBps
  })

  afterAll(async () => {
    if (attestors !== undefined) await releaseAttestors(program, env, attestors)
  })

  it('refuses a second incident on cover that has already been spent', async () => {
    const [target, policySeq, policy] = await covered()
    const { seq } = await openIncident(program, env, target, policySeq)
    const needed = await votesNeededFor(target, seq)
    for (const attestor of attestors.slice(0, needed)) {
      await attest(program, target, seq, attestor)
    }
    await resolve(program, env, target, seq)
    expect((await program.account.policy.fetch(policy)).status).toEqual({ exhausted: {} })

    // What is left of the limit is the retention, which is never payable (FR-033), so
    // there is no cover here to claim against any more (FR-016). Refused at opening,
    // before it costs anyone a bond or freezes any capital.
    const error = await openIncident(program, env, target, policySeq).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('PolicyNotActive')
    expect((await program.account.pool.fetch(target.pool)).openIncidents).toBe(0)
  })

  it('lets nobody outside the set make up the vote a quorum is missing', async () => {
    const [target, policySeq] = await covered()
    const { seq } = await openIncident(program, env, target, policySeq)
    const needed = await votesNeededFor(target, seq)
    for (const attestor of attestors.slice(0, needed - 1)) {
      await attest(program, target, seq, attestor)
    }

    // Funded, willing, and holding no membership at all — the attestor account its
    // seeds point at was never created.
    const stranger = await env.fundedKeypair(2)
    await expect(attest(program, target, seq, stranger)).rejects.toThrow()

    const incident = await program.account.incident.fetch(incidentOn(target, seq))
    expect(incident.votesUnauthorized).toBe(needed - 1)
    const error = await resolve(program, env, target, seq).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('QuorumNotReached')
    // Still open and still frozen: an attempt from outside is not an event.
    expect((await program.account.pool.fetch(target.pool)).openIncidents).toBe(1)
  })

  it('counts a member who votes twice once', async () => {
    const [target, policySeq] = await covered()
    const { seq } = await openIncident(program, env, target, policySeq)
    const [first] = attestors
    if (first === undefined) throw new Error('no attestors were admitted')

    await attest(program, target, seq, first)
    // FR-009 without a check in our code: `(incident, attestor)` derives one account,
    // so the second one fails in the runtime. What matters at this level is that the
    // tally is unmoved by trying.
    await expect(attest(program, target, seq, first)).rejects.toThrow()

    expect((await program.account.incident.fetch(incidentOn(target, seq))).votesUnauthorized).toBe(
      1,
    )
  })

  it('pays nothing when the set says the action was authorized', async () => {
    const [target, policySeq] = await covered()
    const beneficiaryToken = await env.assetAccount(target.treasury)
    const beneficiaryBefore = (await getAccount(env.connection, beneficiaryToken)).amount
    const { seq, bond } = await openIncident(program, env, target, policySeq)

    // The protocol declared this operation and the set can see that it did, so every
    // verdict lands on the other side of the question (SPEC → US1, acceptance 4).
    for (const attestor of attestors) {
      await attest(program, target, seq, attestor, 'authorized')
    }

    const incident = await program.account.incident.fetch(incidentOn(target, seq))
    expect(incident.votesAuthorized).toBe(attestors.length)
    expect(incident.votesUnauthorized).toBe(0)

    // Quorum is counted on one classification (FR-010), and unanimity on the other
    // one is not a decision to pay.
    const error = await resolve(program, env, target, seq).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('QuorumNotReached')

    expect((await getAccount(env.connection, beneficiaryToken)).amount).toBe(beneficiaryBefore)
    const pool = await program.account.pool.fetch(target.pool)
    expect(BigInt(pool.totalAssets.toString())).toBe(CAPITAL + PREMIUM)
    expect(BigInt(pool.lockedLimit.toString())).toBe(LIMIT)
    // It ends at its deadline with no payout, and the bond stays with the pool —
    // the closing half of this story is in `close_expired_incident.itest.ts`.
    expect(pool.openIncidents).toBe(1)
    expect((await getAccount(env.connection, target.vault)).amount).toBe(CAPITAL + PREMIUM + bond)
  })
})
