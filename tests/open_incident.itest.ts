import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import {
  type DrainCover,
  createProgram,
  findConfig,
  findIncident,
  findPolicy,
} from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import { Keypair, SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, setupTestEnv, validatorReachable } from './harness'
import {
  type RegisteredProtocol,
  ensureConfig,
  fundPool,
  issuePolicy,
  openIncident,
  registerProtocol,
  setAttestor,
  triggerSignature,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(500_000)
const RETENTION = asset(50_000)
const PREMIUM = asset(4_000)

// The empty-set refusal is not here: `attestor_count` is global to the deployment and
// other files admit attestors, so a suite that needs it to be zero cannot ask for that
// on a shared ledger. It is covered where it can be replayed — the Rust unit tests on
// `validate_open`.
describe.skipIf(!reachable)('open_incident', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol
  let policySeq: number
  let attestWindow: number

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)
    // An incident cannot be opened against an empty set, so this file needs the
    // deployment to have at least one attestor.
    await setAttestor(program, env, Keypair.generate().publicKey)

    target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
    policySeq = (
      await issuePolicy(program, env, target, {
        limit: LIMIT,
        retention: RETENTION,
        premium: PREMIUM,
      })
    ).seq
    attestWindow = (
      await program.account.config.fetch(findConfig(program.programId))
    ).attestWindow.toNumber()
  })

  const epoch = async (): Promise<number> => (await env.connection.getEpochInfo()).epoch

  it('records the claim, takes the bond and marks the pool as having an incident', async () => {
    const config = await program.account.config.fetch(findConfig(program.programId))
    const poolBefore = await program.account.pool.fetch(target.pool)
    const vaultBefore = await getAccount(env.connection, target.vault)
    const epochBefore = await epoch()

    const { incident, seq, opener, bond, triggerSig } = await openIncident(
      program,
      env,
      target,
      policySeq,
    )
    const epochAfter = await epoch()

    expect(seq).toBe(0)
    const stored = await program.account.incident.fetch(incident)
    expect(stored.policy.equals(findPolicy(program.programId, target.protocol, policySeq))).toBe(
      true,
    )
    // Kept in full so the trail can be replayed straight from an RPC node (SC-007).
    expect([...stored.triggerSig]).toEqual(triggerSig)
    expect(stored.opener.equals(opener.publicKey)).toBe(true)
    expect(BigInt(stored.bond.toString())).toBe(bond)
    expect(stored.status).toEqual({ open: {} })
    expect(stored.votesUnauthorized).toBe(0)
    expect(stored.votesAuthorized).toBe(0)
    expect(stored.payout.toNumber()).toBe(0)
    expect(stored.shortfall.toNumber()).toBe(0)
    expect(stored.deadline.toNumber()).toBe(stored.openedAt.toNumber() + attestWindow)
    // The quorum denominator is frozen here: removing an attestor mid-window must not
    // lower the bar this incident has to clear.
    expect(stored.setSize).toBe(config.attestorCount)
    // FR-008 judges membership against the epoch the incident opened in, so the
    // incident has to carry it. Bounded, not compared for equality: the chain may
    // cross an epoch between the reads around the transaction.
    expect(stored.openedEpoch.toNumber()).toBeGreaterThanOrEqual(epochBefore)
    expect(stored.openedEpoch.toNumber()).toBeLessThanOrEqual(epochAfter)

    const pool = await program.account.pool.fetch(target.pool)
    expect(pool.openIncidents).toBe(poolBefore.openIncidents + 1)
    // The bond sits in the vault but is not pool capital: it may go back to the
    // opener, so it must not read as capacity to underwrite.
    expect(BigInt(pool.totalAssets.toString())).toBe(BigInt(poolBefore.totalAssets.toString()))
    expect((await getAccount(env.connection, target.vault)).amount).toBe(vaultBefore.amount + bond)
    // The opener was credited the bond and nothing else, and it is all gone.
    const openerAsset = await getAccount(env.connection, await env.assetAccount(opener.publicKey))
    expect(openerAsset.amount).toBe(0n)

    expect((await program.account.protocol.fetch(target.protocol)).nextIncidentSeq.toNumber()).toBe(
      1,
    )
  })

  it('gives the next incident its own address and counts it against the pool', async () => {
    const before = (await program.account.pool.fetch(target.pool)).openIncidents

    const { incident, seq } = await openIncident(program, env, target, policySeq, {
      triggerSig: triggerSignature(9),
    })

    expect(seq).toBe(1)
    expect(incident.equals(findIncident(program.programId, target.protocol, 1))).toBe(true)
    expect((await program.account.pool.fetch(target.pool)).openIncidents).toBe(before + 1)
  })

  it('refuses a policy that is not in force', async () => {
    const other = await registerProtocol(program, env)
    await fundPool(program, env, other, asset(100_000))
    const now = Math.floor(Date.now() / 1000)
    const { seq } = await issuePolicy(program, env, other, {
      limit: asset(10_000),
      retention: asset(1_000),
      premium: asset(100),
      startTs: now + 7 * 86_400,
      endTs: now + 30 * 86_400,
    })

    // Nothing could come of it: FR-016 asks whether the policy was in force at the
    // decision, so this incident could only ever close without a payout — after
    // freezing pool capital and costing its opener a bond.
    const error = await openIncident(program, env, other, seq).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('PolicyNotActive')
  })

  it("refuses another protocol's policy", async () => {
    const other = await registerProtocol(program, env)
    await fundPool(program, env, other, asset(100_000))
    const opener = await env.fundedKeypair(2)
    const bondSource = await env.assetAccount(opener.publicKey, asset(1))
    const seq = (await program.account.protocol.fetch(other.protocol)).nextIncidentSeq.toNumber()

    // An incident on someone else's policy would lock capital in a pool that never
    // underwrote it. The policy is bound to the protocol by its seeds.
    const error = await program.methods
      .openIncident(new BN(policySeq), triggerSignature())
      .accountsPartial({
        opener: opener.publicKey,
        protocol: other.protocol,
        pool: other.pool,
        policy: findPolicy(program.programId, target.protocol, policySeq),
        incident: findIncident(program.programId, other.protocol, seq),
        bondSource,
        vault: other.vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([opener])
      .rpc()
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('ConstraintSeeds')
  })
})
