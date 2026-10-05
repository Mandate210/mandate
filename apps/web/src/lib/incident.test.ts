import type { IncidentDetailResponse } from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { INCIDENT_DETAIL } from './fixtures'
import {
  REPLAY_MAX_SECONDS,
  clockOf,
  endOf,
  replaySpeed,
  settlementDelay,
  timelineOf,
} from './incident'

const TRIGGER = INCIDENT_DETAIL.trigger.block_time ?? 0

/** An incident as devnet records them: three attestors, two needed, `resolve` after. */
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

  it('says how long resolve took after the quorum', () => {
    expect(settlementDelay(timelineOf(devnet()))).toBe(3)
    const open = { ...devnet(), payout: null }
    expect(settlementDelay(timelineOf(open))).toBeNull()
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
