import { AnchorError, type Program } from '@coral-xyz/anchor'
import {
  type DrainCover,
  createJsonRpc,
  createProgram,
  findConfig,
  readTransaction,
  settlementsIn,
} from '@mandate/sdk'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, type PublicKey } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, setupTestEnv, validatorReachable } from './harness'
import {
  type RegisteredProtocol,
  admitQuorumSet,
  attest,
  attestToQuorum,
  closeExpiredIncident,
  ensureConfig,
  fundPool,
  issuePolicy,
  openIncident,
  quorumNeeded,
  registerProtocol,
  releaseAttestors,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(500_000)
const RETENTION = asset(50_000)
const PREMIUM = asset(4_000)
const PAYABLE = LIMIT - RETENTION

// Settlement in the vote that completes the quorum (FR-012, T078). Until T078 this was
// `resolve`, a separate permissionless instruction; the vote now pays in the same
// instruction, so the payout and the decision are one transaction and nothing can sit
// between them.
//
// **The shortfall branch is not exercised here, and cannot be.** `issue_policy` refuses
// a limit above the pool's free capital, and a payout lowers `total_assets` and
// `locked_limit` by the same amount, so `total_assets >= locked_limit` holds for every
// reachable state and every payout is paid in full. The arithmetic is covered by the
// unit tests on `settle_payout`; the branch stays because US2 withdrawals and US3
// slashing are paths that can break that invariant (docs/PLAN.md → «Недоплата»).
describe.skipIf(!reachable)('settlement on the deciding vote', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol
  let policySeq: number
  let attestors: Keypair[]
  let quorumBps: number
  /** The incident settled by the first test, reused by the one after it. */
  let settled: PublicKey

  /** A protocol of its own per test, so no test inherits another's reservations. */
  const coveredProtocol = async (terms?: { endTs?: number }) => {
    const protocol = await registerProtocol(program, env)
    await fundPool(program, env, protocol, asset(100_000))
    const { seq } = await issuePolicy(program, env, protocol, {
      limit: asset(50_000),
      retention: asset(5_000),
      premium: asset(500),
      ...terms,
    })
    return { protocol, seq }
  }

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

  it('pays the limit less the retention in the vote that completes the quorum, and returns the bond', async () => {
    const poolBefore = await program.account.pool.fetch(target.pool)
    const beneficiaryToken = await env.assetAccount(target.treasury)
    const beneficiaryBefore = (await getAccount(env.connection, beneficiaryToken)).amount

    const { incident: opened, opener } = await openIncident(program, env, target, policySeq)
    settled = opened
    const openerToken = await env.assetAccount(opener.publicKey)
    const openerBefore = (await getAccount(env.connection, openerToken)).amount

    const { signature } = await attestToQuorum(program, target, opened, attestors)

    // SC-006: exactly the limit less the retention, no rounding anywhere on the way —
    // the retention is an absolute amount and there is a single asset, so there is
    // nothing to convert and nothing to round.
    expect((await getAccount(env.connection, beneficiaryToken)).amount).toBe(
      beneficiaryBefore + PAYABLE,
    )

    const incident = await program.account.incident.fetch(opened)
    expect(incident.status).toEqual({ paidOut: {} })
    expect(incident.votesUnauthorized).toBe(quorumNeeded(incident.setSize, quorumBps))
    expect(BigInt(incident.payout.toString())).toBe(PAYABLE)
    expect(incident.shortfall.toNumber()).toBe(0)
    // The bond came back: the quorum confirmed what its opener claimed.
    expect((await getAccount(env.connection, openerToken)).amount).toBe(
      openerBefore + BigInt(incident.bond.toString()),
    )

    // The vote states what it decided, in the transaction itself — which is how the
    // indexer and a third party tell the deciding vote from the ones before it.
    const read = await readTransaction(
      createJsonRpc(env.connection.rpcEndpoint),
      signature,
      'confirmed',
    )
    if (read.kind !== 'ok') throw new Error(`the deciding vote is ${read.kind}`)
    expect(settlementsIn(program.programId, read.transaction)).toEqual([
      {
        incident: opened.toBase58(),
        status: 'paid_out',
        payout: PAYABLE.toString(),
        shortfall: '0',
        via: 'attest',
      },
    ])

    const pool = await program.account.pool.fetch(target.pool)
    // FR-015: cover and capital fall by the same amount.
    expect(BigInt(pool.totalAssets.toString())).toBe(
      BigInt(poolBefore.totalAssets.toString()) - PAYABLE,
    )
    expect(pool.openIncidents).toBe(poolBefore.openIncidents)

    const policy = await program.account.policy.fetch(incident.policy)
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

  it('leaves nothing to undo the decision', async () => {
    const error = await closeExpiredIncident(program, env, target, settled).catch(
      (thrown: unknown) => thrown,
    )

    // FR-012: the decision is final, and nothing moves an incident out of it.
    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('IncidentNotOpen')
  })

  it('settles nothing below the quorum', async () => {
    const { protocol: other, seq } = await coveredProtocol()
    const { incident: opened } = await openIncident(program, env, other, seq)
    const incident = await program.account.incident.fetch(opened)
    // One short of what this incident's own set size demands.
    const short = quorumNeeded(incident.setSize, quorumBps) - 1
    for (const attestor of attestors.slice(0, short)) {
      await attest(program, other, opened, attestor)
    }

    // Still open, still counted against the pool: nothing was decided.
    expect((await program.account.incident.fetch(opened)).status).toEqual({ open: {} })
    expect((await program.account.pool.fetch(other.pool)).openIncidents).toBe(1)
    expect(
      BigInt((await program.account.policy.fetch(incident.policy)).remainingLimit.toString()),
    ).toBe(asset(50_000))
  })

  // A token account is a precondition of a transfer, and a payout inside the vote would
  // otherwise fail the vote itself — the quorum unreached and an honest opener's bond
  // forfeited because the beneficiary never opened an account.
  it('opens the beneficiary’s account when it has none, rather than failing the vote', async () => {
    const { protocol: bare, seq } = await coveredProtocol()
    const { assetMint } = await program.account.config.fetch(findConfig(program.programId))
    const beneficiaryToken = getAssociatedTokenAddressSync(assetMint, bare.treasury, true)
    expect(await env.connection.getAccountInfo(beneficiaryToken)).toBeNull()

    const { incident: opened } = await openIncident(program, env, bare, seq)
    await attestToQuorum(program, bare, opened, attestors)

    expect((await program.account.incident.fetch(opened)).status).toEqual({ paidOut: {} })
    expect((await getAccount(env.connection, beneficiaryToken)).amount).toBe(
      asset(50_000) - asset(5_000),
    )
  })

  it('refuses to send the payout anywhere but the beneficiary’s own account', async () => {
    const { protocol: third, seq } = await coveredProtocol()
    const { incident: opened } = await openIncident(program, env, third, seq)
    const incident = await program.account.incident.fetch(opened)
    const needed = quorumNeeded(incident.setSize, quorumBps)
    for (const attestor of attestors.slice(0, needed - 1)) {
      await attest(program, third, opened, attestor)
    }

    // The beneficiary is fixed at issuance (FR-004), and the account is its associated
    // one: presenting anything else fails on the address, before any arithmetic.
    const thief = Keypair.generate()
    const error = await attest(
      program,
      third,
      opened,
      attestors[needed - 1] as Keypair,
      'unauthorized',
      {
        beneficiaryToken: await env.assetAccount(thief.publicKey),
      },
    ).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('ConstraintAddress')
    // The vote did not land, so neither did the decision.
    expect((await program.account.incident.fetch(opened)).status).toEqual({ open: {} })
  })

  // FR-016 asks about the moment of the decision. A policy that ran out between the
  // opening and the deciding vote pays nothing — and the incident closes there and
  // then, bond back to the opener, rather than freezing the pool until its deadline.
  it('closes unpaid on a policy that ran out before the deciding vote', async () => {
    const endTs = Math.floor(Date.now() / 1000) + 20
    const { protocol: lapsing, seq } = await coveredProtocol({ endTs })
    const { incident: opened, opener } = await openIncident(program, env, lapsing, seq)
    const openerToken = await env.assetAccount(opener.publicKey)
    const openerBefore = (await getAccount(env.connection, openerToken)).amount
    const incident = await program.account.incident.fetch(opened)
    const needed = quorumNeeded(incident.setSize, quorumBps)
    for (const attestor of attestors.slice(0, needed - 1)) {
      await attest(program, lapsing, opened, attestor)
    }

    // Past `end_ts` by the cluster's clock, which is the one the program reads.
    const clusterTime = async () =>
      (await env.connection.getBlockTime(await env.connection.getSlot())) ?? 0
    while ((await clusterTime()) < endTs) {
      await new Promise((settle) => setTimeout(settle, 1_000))
    }
    const { signature } = await attest(program, lapsing, opened, attestors[needed - 1] as Keypair)

    const after = await program.account.incident.fetch(opened)
    expect(after.status).toEqual({ closedNoPayout: {} })
    expect(after.payout.toNumber()).toBe(0)
    expect((await getAccount(env.connection, openerToken)).amount).toBe(
      openerBefore + BigInt(after.bond.toString()),
    )
    expect((await program.account.pool.fetch(lapsing.pool)).openIncidents).toBe(0)
    // The cover is untouched: nothing was paid against it.
    expect(
      BigInt((await program.account.policy.fetch(after.policy)).remainingLimit.toString()),
    ).toBe(asset(50_000))

    const read = await readTransaction(
      createJsonRpc(env.connection.rpcEndpoint),
      signature,
      'confirmed',
    )
    if (read.kind !== 'ok') throw new Error(`the deciding vote is ${read.kind}`)
    expect(settlementsIn(program.programId, read.transaction)).toMatchObject([
      { incident: opened.toBase58(), status: 'closed_no_payout', payout: '0' },
    ])
  })
})
