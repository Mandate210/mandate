import type { IncidentDetailResponse } from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { INCIDENT_DETAIL } from './fixtures'
import {
  REPLAY_MAX_SECONDS,
  clockOf,
  endOf,
  labelSlots,
  milestonesOf,
  replaySpeed,
  settlementOf,
  sinceLabel,
  timelineOf,
} from './incident'

const TRIGGER = INCIDENT_DETAIL.trigger.block_time ?? 0

/** An incident as devnet recorded them before T078: three attestors, two needed, a separate `resolve` after. */
const devnet = (): IncidentDetailResponse => {
  const at = (t: number) => TRIGGER + t
  const [a, b, c] = INCIDENT_DETAIL.attestations
  if (a === undefined || b === undefined || c === undefined) throw new Error('fixture')
  return {
    ...INCIDENT_DETAIL,
    incident: { ...INCIDENT_DETAIL.incident, set_size: 3, quorum_needed: 2 },
    opened: { ...INCIDENT_DETAIL.opened, at: at(5) },
    attestations: [
      { ...a, verdict: 'unauthorized', submitted_at: at(7) },
      { ...b, verdict: 'unauthorized', submitted_at: at(7) },
      { ...c, verdict: 'unauthorized', submitted_at: at(8) },
    ],
    payout: INCIDENT_DETAIL.payout === null ? null : { ...INCIDENT_DETAIL.payout, at: at(10) },
  }
}

describe('an incident’s timeline', () => {
  it('starts at the trigger and runs in the order the chain recorded it', () => {
    const events = timelineOf(devnet())
    expect(events.map((e) => [e.kind, e.t])).toEqual([
      ['trigger', 0],
      ['opened', 5],
      ['attestation', 7],
      ['attestation', 7],
      ['attestation', 8],
      ['payout', 10],
    ])
  })

  it('marks the attestation that completed the quorum, and only that one', () => {
    const attestations = timelineOf(devnet()).flatMap((e) => (e.kind === 'attestation' ? [e] : []))
    expect(attestations.map((a) => [a.tally, a.quorumReached])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ])
  })

  it('counts only unauthorized verdicts toward the quorum', () => {
    // The fixture's votes: U, U, A, U, U, U — the authorized one moves nothing.
    const attestations = timelineOf(INCIDENT_DETAIL).flatMap((e) =>
      e.kind === 'attestation' ? [e] : [],
    )
    expect(attestations.map((a) => a.verdict === 'authorized')).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ])
    expect(attestations.map((a) => a.tally)).toEqual([1, 2, 2, 3, 4, 5])
    expect(attestations.map((a) => a.quorumReached)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ])
    expect(INCIDENT_DETAIL.incident.quorum_needed).toBe(5)
  })

  it('puts a payout in the same second as an attestation after it', () => {
    const detail = devnet()
    const payout = detail.payout
    if (payout === null) throw new Error('fixture')
    const same = { ...detail, payout: { ...payout, at: TRIGGER + 8 } }
    expect(timelineOf(same).at(-1)?.kind).toBe('payout')
  })

  it('says how long a separate resolve took after the quorum', () => {
    expect(settlementOf(timelineOf(devnet()))).toEqual({ kind: 'separate', delay: 3 })
    const open = { ...devnet(), payout: null }
    expect(settlementOf(timelineOf(open))).toBeNull()
  })

  // Since T078 the vote that completes the quorum pays: one signature for both.
  it('recognises a payout made by the deciding vote itself', () => {
    const detail = devnet()
    const deciding = detail.attestations[1]
    if (deciding === undefined || detail.payout === null) throw new Error('fixture')
    const paid = {
      ...detail,
      payout: { ...detail.payout, signature: deciding.signature ?? '', at: deciding.submitted_at },
    }
    expect(settlementOf(timelineOf(paid))).toEqual({ kind: 'deciding-vote' })
  })

  // An attestation the index has not matched to its transaction yet cannot be compared.
  it('claims neither while the deciding signature is unknown', () => {
    const detail = devnet()
    const attestations = detail.attestations.map((a) => ({ ...a, signature: null }))
    expect(settlementOf(timelineOf({ ...detail, attestations }))).toBeNull()
  })

  it('counts from the opening when the RPC no longer returns the trigger', () => {
    const detail = { ...devnet(), trigger: { ...devnet().trigger, slot: null, block_time: null } }
    expect(clockOf(detail)).toEqual({ origin: detail.opened.at, from: 'opening' })
    const events = timelineOf(detail)
    expect(events[0]).toMatchObject({ kind: 'opened', t: 0 })
    expect(events.some((e) => e.kind === 'trigger')).toBe(false)
  })
})

describe('where an incident stopped', () => {
  it('is the payout for one paid out', () => {
    expect(endOf(devnet())).toBe(10)
  })

  it('is the deadline for one closed without a payout', () => {
    const detail = devnet()
    const closed = {
      ...detail,
      incident: { ...detail.incident, status: 'closed_no_payout' as const },
      payout: null,
    }
    expect(endOf(closed)).toBe(detail.incident.deadline - TRIGGER)
  })

  it('is nowhere yet for one still open', () => {
    const detail = devnet()
    expect(
      endOf({ ...detail, incident: { ...detail.incident, status: 'open' }, payout: null }),
    ).toBeNull()
  })
})

describe('a replay', () => {
  it('runs in real time up to a minute, and compresses anything longer into one', () => {
    expect(replaySpeed(10)).toBe(1)
    expect(replaySpeed(REPLAY_MAX_SECONDS)).toBe(1)
    expect(replaySpeed(86_400) * REPLAY_MAX_SECONDS).toBe(86_400)
  })
})

describe('the phase strip', () => {
  const marks = (detail: IncidentDetailResponse) =>
    milestonesOf(timelineOf(detail), detail).map((m) => [m.kind, m.t])

  it('names the trigger, the opening, the quorum and a separate payout', () => {
    expect(marks(devnet())).toEqual([
      ['trigger', 0],
      ['opened', 5],
      ['quorum', 7],
      ['paid', 10],
    ])
  })

  it('draws one mark when the deciding vote paid in its own transaction', () => {
    const detail = devnet()
    const deciding = detail.attestations[1]
    if (deciding === undefined || detail.payout === null) throw new Error('fixture')
    const paid = {
      ...detail,
      payout: { ...detail.payout, signature: deciding.signature ?? '', at: deciding.submitted_at },
    }
    expect(marks(paid)).toEqual([
      ['trigger', 0],
      ['opened', 5],
      ['decided', 7],
    ])
  })

  it('ends an incident closed without a payout at its deadline', () => {
    const detail = devnet()
    const closed = {
      ...detail,
      incident: { ...detail.incident, status: 'closed_no_payout' as const },
      attestations: detail.attestations.slice(0, 1),
      payout: null,
    }
    expect(marks(closed)).toEqual([
      ['trigger', 0],
      ['opened', 5],
      ['closed', detail.incident.deadline - TRIGGER],
    ])
  })

  it('names nothing past the quorum while the incident is open', () => {
    const detail = devnet()
    const open = {
      ...detail,
      incident: { ...detail.incident, status: 'open' as const },
      attestations: detail.attestations.slice(0, 1),
      payout: null,
    }
    expect(marks(open)).toEqual([
      ['trigger', 0],
      ['opened', 5],
    ])
  })

  it('reads in seconds up to two minutes, then minutes, then hours', () => {
    expect([0, 22, 119.4, 120, 7199, 7200, 86_400].map(sinceLabel)).toEqual([
      'T+0 s',
      'T+22 s',
      'T+119 s',
      'T+2 min',
      'T+120 min',
      'T+2 h',
      'T+24 h',
    ])
  })

  it('stacks labels that would overlap and keeps the rest on the first row', () => {
    // A 24-hour window: trigger, opening and quorum within seconds, the close at the end.
    expect(labelSlots([0, 1, 2, 600], 600, 100)).toEqual([
      { row: 0, align: 'start' },
      { row: 1, align: 'start' },
      { row: 2, align: 'start' },
      { row: 0, align: 'end' },
    ])
    expect(labelSlots([0, 100, 250, 400], 600, 100).map((s) => s.row)).toEqual([0, 0, 0, 0])
  })

  it('turns a label left of its mark rather than past the end of the strip', () => {
    expect(labelSlots([0, 550], 600, 100)).toEqual([
      { row: 0, align: 'start' },
      { row: 0, align: 'end' },
    ])
    // Ending exactly at the edge still fits.
    expect(labelSlots([500], 600, 100)).toEqual([{ row: 0, align: 'start' }])
    // Turned left, it can collide with a label that would have cleared it hanging right.
    expect(labelSlots([440, 550], 600, 100).map((s) => s.row)).toEqual([0, 1])
  })
})
