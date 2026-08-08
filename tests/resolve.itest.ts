import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig, findIncident } from '@drain-cover/sdk'
import { getAccount } from '@solana/spl-token'
import type { Keypair } from '@solana/web3.js'
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
const LIMIT = asset(500_000)
const RETENTION = asset(50_000)
const PREMIUM = asset(4_000)
const PAYABLE = LIMIT - RETENTION

// **The shortfall branch is not exercised here, and cannot be.** `issue_policy` refuses
// a limit above the pool's free capital, and a payout lowers `total_assets` and
// `locked_limit` by the same amount, so `total_assets >= locked_limit` holds for every
// reachable state and every payout is paid in full. The arithmetic is covered by the
// unit tests on `settle_payout`; the branch stays because US2 withdrawals and US3
// slashing are paths that can break that invariant (docs/PLAN.md → «Недоплата»).
describe.skipIf(!reachable)('resolve', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol
  let policySeq: number
  let attestors: Keypair[]
  let quorumBps: number
  /** The incident settled by the first test, reused by the one after it. */
  let settled: number

  const incidentAt = (seq: number) => findIncident(program.programId, target.protocol, seq)

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)

    attestors = await admitQuorumSet(program, env)
    quorumBps = (await program.account.config.fetch(findConfig(program.programId))).quorumBps

    target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
    policySeq = (
      await issuePolicy(program, env, target, {
        limit: LIMIT,
        retention: RETENTION,
        premium: PREMIUM,
      })
    ).seq
  })

  afterAll(async () => {
    if (attestors !== undefined) await releaseAttestors(program, env, attestors)
  })

  it('pays the beneficiary the limit less the retention, and returns the bond', async () => {
    const poolBefore = await program.account.pool.fetch(target.pool)
    const beneficiaryToken = await env.assetAccount(target.treasury)
    const beneficiaryBefore = (await getAccount(env.connection, beneficiaryToken)).amount

    const { seq } = await openIncident(program, env, target, policySeq)
    settled = seq
    for (const attestor of attestors) {
      await attest(program, target, seq, attestor)
    }
    const openerToken = await env.assetAccount(
      (await program.account.incident.fetch(incidentAt(seq))).opener,
    )
    const openerBefore = (await getAccount(env.connection, openerToken)).amount

    await resolve(program, env, target, seq)

    // SC-006: exactly the limit less the retention, no rounding anywhere on the way —
    // the retention is an absolute amount and there is a single asset, so there is
    // nothing to convert and nothing to round.
    expect((await getAccount(env.connection, beneficiaryToken)).amount).toBe(
      beneficiaryBefore + PAYABLE,
    )

    const incident = await program.account.incident.fetch(incidentAt(seq))
    expect(incident.status).toEqual({ paidOut: {} })
    expect(BigInt(incident.payout.toString())).toBe(PAYABLE)
    expect(incident.shortfall.toNumber()).toBe(0)
    // The bond came back: the quorum confirmed what its opener claimed.
    expect((await getAccount(env.connection, openerToken)).amount).toBe(
      openerBefore + BigInt(incident.bond.toString()),
    )

    const pool = await program.account.pool.fetch(target.pool)
    // FR-015: cover and capital fall by the same amount.
    expect(BigInt(pool.totalAssets.toString())).toBe(
      BigInt(poolBefore.totalAssets.toString()) - PAYABLE,
    )
    expect(pool.openIncidents).toBe(poolBefore.openIncidents)

    const policy = await program.account.policy.fetch(
      (await program.account.incident.fetch(incidentAt(seq))).policy,
    )
    expect(BigInt(policy.remainingLimit.toString())).toBe(LIMIT - PAYABLE)
    // What is left is the retention, which is never payable — so the policy is spent
    // and the pool stops reserving anything for it.
    expect(policy.status).toEqual({ exhausted: {} })
    expect(BigInt(pool.lockedLimit.toString())).toBe(
      BigInt(poolBefore.lockedLimit.toString()) - LIMIT,
    )

    // The vault holds the pool's capital and nothing else: payout gone, bond gone.
    expect((await getAccount(env.connection, target.vault)).amount).toBe(
      BigInt(pool.totalAssets.toString()),
    )
  })

  it('refuses to settle an incident twice', async () => {
    const error = await resolve(program, env, target, settled).catch((thrown: unknown) => thrown)

    // FR-012: the decision is final, and nothing moves an incident out of it.
    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('IncidentNotOpen')
  })

  it('refuses to pay before the quorum is reached', async () => {
    const other = await registerProtocol(program, env)
    await fundPool(program, env, other, asset(100_000))
    const { seq: otherPolicy } = await issuePolicy(program, env, other, {
      limit: asset(50_000),
      retention: asset(5_000),
      premium: asset(500),
    })

    const { seq } = await openIncident(program, env, other, otherPolicy)
    const incident = await program.account.incident.fetch(
      findIncident(program.programId, other.protocol, seq),
    )
    // One short of what this incident's own set size demands.
    const short = quorumNeeded(incident.setSize, quorumBps) - 1
    for (const attestor of attestors.slice(0, short)) {
      await attest(program, other, seq, attestor)
    }

    const error = await resolve(program, env, other, seq).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('QuorumNotReached')
    // Still open, still counted against the pool: nothing was decided.
    expect(
      (await program.account.incident.fetch(findIncident(program.programId, other.protocol, seq)))
        .status,
    ).toEqual({ open: {} })
    expect((await program.account.pool.fetch(other.pool)).openIncidents).toBe(1)
  })

  it('refuses to send the payout anywhere but the beneficiary', async () => {
    const third = await registerProtocol(program, env)
    await fundPool(program, env, third, asset(100_000))
    const { seq: thirdPolicy } = await issuePolicy(program, env, third, {
      limit: asset(50_000),
      retention: asset(5_000),
      premium: asset(500),
    })
    const seq = (await openIncident(program, env, third, thirdPolicy)).seq
    for (const attestor of attestors) {
      await attest(program, third, seq, attestor)
    }

    const incident = await program.account.incident.fetch(
      findIncident(program.programId, third.protocol, seq),
    )
    const thief = await env.fundedKeypair(1)

    // The beneficiary is fixed at issuance (FR-004). Presenting a different account
    // here fails on the token owner constraint, not on our arithmetic.
    const error = await program.methods
      .resolve(new BN(seq))
      .accountsPartial({
        protocol: third.protocol,
        pool: third.pool,
        policy: incident.policy,
        incident: findIncident(program.programId, third.protocol, seq),
        vault: third.vault,
        beneficiaryToken: await env.assetAccount(thief.publicKey),
        openerToken: await env.assetAccount(incident.opener),
      })
      .rpc()
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('ConstraintTokenOwner')
  })
})
