import { AnchorError, type Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig } from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type TestEnv,
  asset,
  setupTestEnv,
  validatorReachable,
  waitPastClusterTime,
} from './harness'
import {
  type RegisteredProtocol,
  admitQuorumSet,
  attest,
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

/**
 * The only suite that waits out a deadline, so it is the only one that cares how long
 * `Config.attest_window` is — and `Config` is a singleton that outlives a test run.
 * Longer than this and the wait below would look like a hang, so say what it is.
 */
const REFUSE_WINDOW_ABOVE = 180

describe.skipIf(!reachable)('close_expired_incident', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let attestors: Keypair[]
  /** No attestations at all: the plain expiry, and the bond is forfeited. */
  let expiring: { target: RegisteredProtocol; incident: PublicKey; bond: bigint }
  /** Votes against the action, one short of the quorum: unconfirmed all the same. */
  let short: { target: RegisteredProtocol; incident: PublicKey; bond: bigint }

  // What used to be here as well — an incident at quorum that nobody settled, on a
  // policy in force or one that had run out — is a state nothing reaches since T078:
  // the vote that completes a quorum settles the incident in the same instruction
  // (`settlement.itest.ts`). The program still refuses to close the first kind
  // (`IncidentPayable`), and the unit tests on `validate_close` hold that rule.

  /** A protocol with capital and one policy, unentangled from the others here. */
  const coveredProtocol = async (): Promise<[RegisteredProtocol, number]> => {
    const target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
    const { seq } = await issuePolicy(program, env, target, {
      limit: LIMIT,
      retention: RETENTION,
      premium: PREMIUM,
    })
    return [target, seq]
  }

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)

    const config = await program.account.config.fetch(findConfig(program.programId))
    const attestWindow = config.attestWindow.toNumber()
    if (attestWindow > REFUSE_WINDOW_ABOVE) {
      throw new Error(
        `Config on this validator has an attestation window of ${attestWindow}s, so an incident here would take that long to expire. Restart solana-test-validator with --reset: the config is a singleton and this one predates the window the tests use.`,
      )
    }

    attestors = await admitQuorumSet(program, env)

    const [expiringTarget, expiringPolicy] = await coveredProtocol()
    const opened = await openIncident(program, env, expiringTarget, expiringPolicy)
    expiring = { target: expiringTarget, incident: opened.incident, bond: opened.bond }

    const [shortTarget, shortPolicy] = await coveredProtocol()
    const shortOpened = await openIncident(program, env, shortTarget, shortPolicy)
    short = { target: shortTarget, incident: shortOpened.incident, bond: shortOpened.bond }
    const { setSize } = await program.account.incident.fetch(short.incident)
    for (const attestor of attestors.slice(0, quorumNeeded(setSize, config.quorumBps) - 1)) {
      await attest(program, short.target, short.incident, attestor)
    }

    // One wait for both: they were opened within seconds of each other, and the clock
    // that matters is the cluster's, not this machine's.
    const deadlines = await Promise.all(
      [expiring, short].map(async ({ incident }) =>
        (await program.account.incident.fetch(incident)).deadline.toNumber(),
      ),
    )
    await waitPastClusterTime(env.connection, Math.max(...deadlines))
  }, 240_000)

  afterAll(async () => {
    if (attestors !== undefined) await releaseAttestors(program, env, attestors)
  })

  it('refuses to close an incident whose window is still open', async () => {
    const [target, policySeq] = await coveredProtocol()
    const { incident } = await openIncident(program, env, target, policySeq)

    const error = await closeExpiredIncident(program, env, target, incident).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('IncidentDeadlineNotReached')
  })

  it('closes an expired incident without paying, and the bond becomes pool capital', async () => {
    const { target, incident: opened, bond } = expiring
    const poolBefore = await program.account.pool.fetch(target.pool)
    const vaultBefore = (await getAccount(env.connection, target.vault)).amount
    const openerToken = await env.assetAccount(
      (await program.account.incident.fetch(opened)).opener,
    )
    const openerBefore = (await getAccount(env.connection, openerToken)).amount

    await closeExpiredIncident(program, env, target, opened)

    const incident = await program.account.incident.fetch(opened)
    expect(incident.status).toEqual({ closedNoPayout: {} })
    expect(incident.payout.toNumber()).toBe(0)
    expect(incident.shortfall.toNumber()).toBe(0)

    const pool = await program.account.pool.fetch(target.pool)
    // The bond changes side of the ledger without moving: it was already in the vault,
    // and now it counts as capital the pool can underwrite with.
    expect(BigInt(pool.totalAssets.toString())).toBe(
      BigInt(poolBefore.totalAssets.toString()) + bond,
    )
    expect((await getAccount(env.connection, target.vault)).amount).toBe(vaultBefore)
    expect((await getAccount(env.connection, openerToken)).amount).toBe(openerBefore)
    // The capital the incident froze is released — and only this releases it (FR-019).
    expect(pool.openIncidents).toBe(poolBefore.openIncidents - 1)
    // Nothing was paid, so the cover stands exactly as it did.
    expect(BigInt(pool.lockedLimit.toString())).toBe(BigInt(poolBefore.lockedLimit.toString()))

    const policy = await program.account.policy.fetch(incident.policy)
    expect(BigInt(policy.remainingLimit.toString())).toBe(LIMIT)
    expect(policy.status).not.toEqual({ exhausted: {} })
  })

  // Votes against the action short of the quorum are not a decision: the claim stays
  // unconfirmed, and its bond is forfeited exactly as if nobody had voted.
  it('closes an incident one vote short of its quorum the same way', async () => {
    const { target, incident: opened, bond } = short
    const poolBefore = await program.account.pool.fetch(target.pool)
    const openerToken = await env.assetAccount(
      (await program.account.incident.fetch(opened)).opener,
    )
    const openerBefore = (await getAccount(env.connection, openerToken)).amount

    await closeExpiredIncident(program, env, target, opened)

    const incident = await program.account.incident.fetch(opened)
    expect(incident.status).toEqual({ closedNoPayout: {} })
    // Short of the bar this incident's own set size demands — zero votes when the set
    // is one attestor, which is how a fresh ledger starts.
    const { quorumBps } = await program.account.config.fetch(findConfig(program.programId))
    expect(incident.votesUnauthorized).toBeLessThan(quorumNeeded(incident.setSize, quorumBps))
    const pool = await program.account.pool.fetch(target.pool)
    expect(BigInt(pool.totalAssets.toString())).toBe(
      BigInt(poolBefore.totalAssets.toString()) + bond,
    )
    expect((await getAccount(env.connection, openerToken)).amount).toBe(openerBefore)
    expect(pool.openIncidents).toBe(poolBefore.openIncidents - 1)
  })

  it('refuses to close the same incident twice', async () => {
    const error = await closeExpiredIncident(
      program,
      env,
      expiring.target,
      expiring.incident,
    ).catch((thrown: unknown) => thrown)

    // Closed is as final as paid out: releasing the same incident twice would credit
    // the pool a bond it holds once and unfreeze capital no incident froze.
    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('IncidentNotOpen')
  })
})
