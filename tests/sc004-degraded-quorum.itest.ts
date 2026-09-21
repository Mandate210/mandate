import type { Program } from '@coral-xyz/anchor'
import { type DrainCover, createProgram, findConfig } from '@mandate/sdk'
import { getAccount } from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type TestEnv,
  asset,
  clusterTimestamp,
  setupTestEnv,
  validatorReachable,
  waitForNextEpoch,
} from './harness'
import {
  type RegisteredProtocol,
  attest,
  ensureConfig,
  fundPool,
  issuePolicy,
  openIncident,
  quorumNeeded,
  registerProtocol,
  releaseAttestors,
  resolve,
  setAttestor,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)
const LIMIT = asset(200_000)
const RETENTION = asset(20_000)
const PREMIUM = asset(1_500)
const PAYABLE = LIMIT - RETENTION
/** SC-004: the share of the active set that may be unreachable. */
const UNAVAILABLE_BPS = 4_000
const BPS = 10_000

/**
 * SC-004 — a decision is still reached with up to 40% of the active set unavailable.
 *
 * «Unavailable» is not a state the program has: an attestor that cannot be reached is
 * simply one that does not vote, and it stays in the set, so it stays in the quorum's
 * denominator. That is the whole point of the scenario — the bar is *not* lowered to
 * match who showed up, and the incident still has to clear it.
 */
describe.skipIf(!reachable)('SC-004 — quorum with 40% of the set unavailable', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let quorumBps: number
  /** Ours, and the only ones that can vote here. */
  let voters: Keypair[]
  let setSize: number
  let needed: number

  let target: RegisteredProtocol
  let policySeq: number
  let beneficiaryToken: PublicKey

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)

    const config = await program.account.config.fetch(findConfig(program.programId))
    quorumBps = config.quorumBps
    // Whoever the earlier files left in the set: real members, admitted epochs ago,
    // whose keys this file does not hold. They are the unavailable share, and no
    // arrangement is needed to make them silent.
    const unreachable = config.attestorCount

    // The smallest set that is a whole number of fifths — so that 60% of it is exact —
    // and still has room for every unreachable member inside the 40%.
    setSize = 5
    while (setSize - quorumNeeded(setSize, quorumBps) < unreachable) setSize += 5
    needed = quorumNeeded(setSize, quorumBps)

    voters = await Promise.all(
      Array.from({ length: setSize - unreachable }, () => env.fundedKeypair(1)),
    )
    for (const voter of voters) {
      await setAttestor(program, env, voter.publicKey)
    }
    // Membership starts with the following epoch (FR-008), so the set has to be
    // complete before the incident exists — one boundary for all of them.
    await waitForNextEpoch(env.connection)

    target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
    const issued = await issuePolicy(program, env, target, {
      limit: LIMIT,
      retention: RETENTION,
      premium: PREMIUM,
    })
    policySeq = issued.seq
    beneficiaryToken = await env.assetAccount(issued.beneficiary)
  }, 120_000)

  afterAll(async () => {
    if (voters !== undefined) await releaseAttestors(program, env, voters)
  })

  it('reaches a decision and pays, with 40% of the set never answering', async () => {
    const beneficiaryBefore = (await getAccount(env.connection, beneficiaryToken)).amount
    const { incident: incidentAccount } = await openIncident(program, env, target, policySeq)

    const opened = await program.account.incident.fetch(incidentAccount)
    // The denominator is the whole set, unavailability included — that is what makes
    // this scenario a test and not an arrangement.
    expect(opened.setSize).toBe(setSize)
    const silent = setSize - needed
    expect((silent * BPS) / setSize).toBeGreaterThanOrEqual(UNAVAILABLE_BPS)

    for (const voter of voters.slice(0, needed)) {
      await attest(program, target, incidentAccount, voter)
    }

    const attested = await program.account.incident.fetch(incidentAccount)
    expect(attested.votesUnauthorized).toBe(needed)
    // Nobody spoke for the missing share, in either direction.
    expect(attested.votesAuthorized).toBe(0)
    expect(attested.votesUnauthorized + attested.votesAuthorized).toBe(setSize - silent)

    // The deadline never comes into it: the decision is taken inside the window, so
    // what ends this incident is the payout and not the expiry (FR-011 is the other
    // path, and it is not this one).
    const decidedAt = await clusterTimestamp(env.connection)
    expect(decidedAt).toBeLessThan(attested.deadline.toNumber())

    await resolve(program, env, target, incidentAccount)

    const settled = await program.account.incident.fetch(incidentAccount)
    expect(settled.status).toEqual({ paidOut: {} })
    expect(BigInt(settled.payout.toString())).toBe(PAYABLE)
    expect((await getAccount(env.connection, beneficiaryToken)).amount).toBe(
      beneficiaryBefore + PAYABLE,
    )
    expect((await program.account.pool.fetch(target.pool)).openIncidents).toBe(0)
  })

  it('does not lower the bar when the missing share is larger than 40%', async () => {
    // Its own cover: the policy above was spent by the payout it just made.
    const other = await registerProtocol(program, env)
    await fundPool(program, env, other, CAPITAL)
    const { seq: otherPolicy } = await issuePolicy(program, env, other, {
      limit: LIMIT,
      retention: RETENTION,
      premium: PREMIUM,
    })
    const { incident: opened } = await openIncident(program, env, other, otherPolicy)

    // One vote short of the same bar — an incident where 40% plus one member is
    // unreachable. SC-004 promises a decision up to 40%, and above it the quorum is
    // simply not met: the program has no notion of a reduced set to fall back on.
    for (const voter of voters.slice(0, needed - 1)) {
      await attest(program, other, opened, voter)
    }

    const incident = await program.account.incident.fetch(opened)
    expect(incident.setSize).toBe(setSize)
    expect(incident.votesUnauthorized).toBe(needed - 1)
    await expect(resolve(program, env, other, opened)).rejects.toThrow()
  })
})
