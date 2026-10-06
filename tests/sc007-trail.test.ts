// SC-007 (T056): a third party reproduces the decision on an incident from the public
// trail alone — the trail for where to look, an RPC for what is there, and the rules in
// `@mandate/shared` for what follows from it. `sc007/replay.ts` is that third party.
//
// Two kinds of trail are held to it: the demo trail the site shows without an API
// (`apps/web/src/lib/fixtures.ts`), over a chain encoded in the program's own layout,
// and real devnet incidents, over RPC answers recorded by `pnpm --filter @mandate/tests
// sc007 <incident> --record`. An empty list of problems would mean nothing if the replay
// could not find one, so each check is also shown failing on a trail or a chain with
// exactly one thing wrong.

import { readFileSync, readdirSync } from 'node:fs'
import { BN } from '@coral-xyz/anchor'
import { findDeclarationEntry } from '@mandate/sdk'
import { incidentDetailResponseSchema } from '@mandate/shared'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { fixtureChain } from './sc007/fixture-chain'
import { type Problem, replayDecision } from './sc007/replay'
import { recordedRpc } from './sc007/rpc'

const codes = (problems: Problem[]): Problem['code'][] => [...new Set(problems.map((p) => p.code))]

describe('SC-007: the demo trail', () => {
  it('replays to the decision it claims', async () => {
    const { trail, rpc } = await fixtureChain()
    const replay = await replayDecision(trail, rpc)

    expect(replay.problems).toEqual([])
    // The trigger runs rotate_oracle_authority while its entry is still in its delay.
    expect(replay.entries.map((entry) => entry.state)).toEqual(['effective', 'expired', 'pending'])
    expect(replay.verdict).toMatchObject({ status: 'undeclared', basis: 'signature' })
    // ceil(7 × 6000 / 10 000): 4.2 rounds up, so one attestor short of five cannot decide.
    expect(replay.quorumNeeded).toBe(5)
    expect(replay.decidedAt).toBe(trail.attestations.at(-1)?.submitted_at)
    expect(replay.owed).toBe(BigInt(trail.incident.payout))
  })

  // One lie each, told by the trail about a chain that is in order.
  const trailLies: [
    string,
    Problem['code'],
    (trail: Awaited<ReturnType<typeof fixtureChain>>['trail']) => void,
  ][] = [
    [
      'an entry in a state it was not in',
      'declaration',
      (t) => {
        const entry = t.verification.declaration_at_trigger.entries.find(
          (e) => e.state === 'pending',
        )
        if (entry) entry.state = 'effective'
      },
    ],
    [
      'an entry left out',
      'declaration',
      (t) => {
        t.verification.declaration_at_trigger.entries.pop()
      },
    ],
    [
      'a smaller quorum',
      'quorum',
      (t) => {
        t.incident.quorum_needed -= 1
      },
    ],
    [
      'a vote turned around',
      'attestation',
      (t) => {
        const vote = t.attestations.find((a) => a.verdict === 'authorized')
        if (vote) vote.verdict = 'unauthorized'
      },
    ],
    [
      'a vote left out',
      'tally',
      (t) => {
        t.attestations.shift()
      },
    ],
    [
      'a larger payout',
      'payout',
      (t) => {
        if (t.payout) t.payout.amount = (BigInt(t.payout.amount) + 1n).toString()
      },
    ],
    [
      'an incident that is not the trigger’s',
      'address',
      (t) => {
        t.verification.accounts.incident = t.verification.accounts.pool
      },
    ],
  ]

  it.each(trailLies)('catches %s', async (_, code, lie) => {
    const { trail, rpc } = await fixtureChain()
    lie(trail)
    const { problems } = await replayDecision(trail, rpc)
    expect(codes(problems)).toContain(code)
  })

  // A chain on which the decision itself was wrong, described faithfully by the trail —
  // so the replay has to catch it from the rules, not from a disagreement with the trail.
  it('catches a payout the declaration did not allow', async () => {
    const world = await fixtureChain()
    const pending = world.trail.verification.declaration_at_trigger.entries.find(
      (e) => e.state === 'pending',
    )
    if (pending === undefined) throw new Error('fixture: no pending entry')
    // Submitted two days early, its window around the trigger: the operation was declared.
    const at = world.trail.verification.declaration_at_trigger.evaluated_at ?? 0
    const window = {
      submitted_at: at - 2 * 86_400,
      effective_at: at - 86_400,
      not_before: at - 3_600,
      not_after: at + 3_600,
    }
    await world.patch(pending.address, 'DeclarationEntry', (fields) => {
      for (const [name, value] of Object.entries(window)) fields[name] = new BN(value)
    })
    Object.assign(pending, window, { state: 'effective' })

    const { verdict, problems } = await replayDecision(world.trail, world.rpc)
    expect(verdict.status).toBe('declared')
    expect(codes(problems)).toEqual(['verdict'])
  })

  it('catches a payout on fewer votes than the quorum', async () => {
    const world = await fixtureChain()
    await world.patch(world.trail.verification.accounts.config, 'Config', (fields) => {
      fields.quorum_bps = 10_000
    })
    world.trail.incident.quorum_needed = world.trail.incident.set_size

    const { problems } = await replayDecision(world.trail, world.rpc)
    expect(codes(problems)).toEqual(['quorum'])
  })

  it('catches a payout on a policy that had run out (FR-016)', async () => {
    const world = await fixtureChain()
    const paidAt = world.trail.payout?.at ?? 0
    await world.patch(world.trail.verification.accounts.policy, 'Policy', (fields) => {
      fields.end_ts = new BN(paidAt)
    })

    const { problems } = await replayDecision(world.trail, world.rpc)
    expect(codes(problems)).toEqual(['policy'])
  })

  it('catches a payout above what the policy owed (FR-013, FR-033)', async () => {
    const world = await fixtureChain()
    await world.patch(world.trail.verification.accounts.policy, 'Policy', (fields) => {
      fields.retention = (fields.retention as BN).add(new BN(1))
    })

    const { problems } = await replayDecision(world.trail, world.rpc)
    expect(codes(problems)).toEqual(['payout'])
  })

  it('leaves out an entry submitted after the trigger, as the rule did', async () => {
    const world = await fixtureChain()
    const { accounts: at, declaration_at_trigger } = world.trail.verification
    const last = declaration_at_trigger.entries.at(-1)
    if (last === undefined) throw new Error('fixture: no entries')
    // The protocol's next entry, submitted a minute after the trigger and covering it
    // retroactively if anyone forgot to ask when it was submitted.
    const next = findDeclarationEntry(
      new PublicKey(world.trail.verification.program_id),
      new PublicKey(at.protocol),
      last.seq + 1,
    ).toBase58()
    const after = (declaration_at_trigger.evaluated_at ?? 0) + 60
    const lastAccount = world.accounts.get(last.address)
    if (lastAccount === undefined) throw new Error('fixture: entry not on chain')
    world.accounts.set(next, lastAccount)
    await world.patch(next, 'DeclarationEntry', (fields) => {
      fields.submitted_at = new BN(after)
      fields.effective_at = new BN(after)
      fields.not_before = new BN(after - 3_600)
    })
    await world.patch(at.protocol, 'Protocol', (fields) => {
      fields.next_declaration_seq = new BN(last.seq + 2)
    })

    const replay = await replayDecision(world.trail, world.rpc)
    expect(replay.problems).toEqual([])
    expect(replay.entries.map((entry) => entry.address)).not.toContain(next)
  })

  it('refuses an account the program does not own', async () => {
    const world = await fixtureChain()
    const policy = world.trail.verification.accounts.policy
    const found = world.accounts.get(policy)
    if (found)
      world.accounts.set(policy, {
        ...found,
        owner: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
      })

    await expect(replayDecision(world.trail, world.rpc)).rejects.toThrow(/owned by/)
  })
})

// ── Devnet ──────────────────────────────────────────────────────────────────

const RECORDINGS = new URL('./__fixtures__/sc007/', import.meta.url)

const recordings = readdirSync(RECORDINGS)
  .filter((name) => name.endsWith('.json'))
  .map((name) => {
    const raw = JSON.parse(readFileSync(new URL(name, RECORDINGS), 'utf8')) as {
      trail: unknown
      recording: Record<string, unknown>
    }
    return { name, trail: incidentDetailResponseSchema.parse(raw.trail), recording: raw.recording }
  })

/**
 * Why each recorded trigger was undeclared, as the replay has to find it: one entry
 * each, in each of the three states that leave an operation uncovered.
 */
const EXPECTED: Record<string, string[]> = {
  // Revoked before the trigger ran (FR-032).
  CFZmnHfkvJ7XvjTnKia48vvdoz66RH5SiQWRy1JWREvM: ['revoked'],
  // In force, but for a different instruction than the one that ran.
  '5AZjxg35P6EcrcGtzsEh13KdLSFd4XVYcRBPzpwR5RHF': ['effective'],
  // Submitted, still inside its delay when the trigger ran (FR-031).
  '84xuZSh5jgq8DnEHwYDzcv9WNTS6x2Bf2xAdk6gXznb2': ['pending'],
  // In force for a different instruction — and paid after T078, by the vote that
  // completed the quorum rather than by a separate `resolve`.
  '5LEvoeyJattPTqvdPYgSvrurdro7m2sAhowgezZgrdcL': ['effective'],
}

/** The three above were paid by `resolve`; this one by the deciding vote itself. */
const PAID_BY_THE_DECIDING_VOTE = ['5LEvoeyJattPTqvdPYgSvrurdro7m2sAhowgezZgrdcL']

describe('SC-007: devnet incidents', () => {
  it('has every recording it expects, and nothing it does not', () => {
    expect(recordings.map((r) => r.trail.incident.address).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    )
  })

  it.each(recordings)('$name replays to the decision it claims', async ({ trail, recording }) => {
    const replay = await replayDecision(trail, recordedRpc(recording))

    expect(replay.problems).toEqual([])
    expect(replay.verdict.status).toBe('undeclared')
    expect(replay.entries.map((entry) => entry.state)).toEqual(EXPECTED[trail.incident.address])
    expect(trail.incident.status).toBe('paid_out')
    expect(replay.owed).toBe(BigInt(trail.incident.payout) + BigInt(trail.incident.shortfall))
  })

  // FR-012 as the chain recorded it: one transaction for the decision and the money.
  it('has a payout that is the deciding attestation’s own transaction, after T078', () => {
    for (const address of PAID_BY_THE_DECIDING_VOTE) {
      const recorded = recordings.find((r) => r.trail.incident.address === address)
      const payout = recorded?.trail.payout?.signature
      expect(payout).toBeDefined()
      expect(recorded?.trail.attestations.map((a) => a.signature)).toContain(payout)
    }
  })

  it.each(recordings)(
    '$name: a lie about it is caught on real data too',
    async ({ trail, recording }) => {
      const told = structuredClone(trail)
      const entry = told.verification.declaration_at_trigger.entries[0]
      if (entry) entry.state = 'effective' === entry.state ? 'expired' : 'effective'
      told.incident.quorum_needed += 1

      const { problems } = await replayDecision(told, recordedRpc(recording))
      expect(codes(problems).sort()).toEqual(['declaration', 'quorum'])
    },
  )
})
