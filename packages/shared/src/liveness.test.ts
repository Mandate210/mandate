import { describe, expect, it } from 'vitest'
import {
  type AttestorReport,
  attestorReportSchema,
  healthResponseSchema,
  judgeAttestor,
  maxLagSlots,
  streamLive,
} from './liveness'

const NOW = 1_800_000_000
const policy = { stall_seconds: 30, poll_seconds: 60, reconcile_seconds: 600 }

/** A healthy attestor: stream ticking, a sweep a minute ago, nothing stuck. */
const report = (overrides: Partial<AttestorReport> = {}): AttestorReport => ({
  attestor: 'Attestor1111111111111111111111111111111111',
  now: NOW,
  examined_slot: 1_000,
  stream: { slot: 1_000, at: NOW - 1 },
  last_complete_sweep: { slot: 900, at: NOW - 60 },
  pending: 0,
  policy,
  ok: true,
  reason: null,
  ...overrides,
})

describe('maxLagSlots', () => {
  it('allows two fallback polls of slots', () => {
    expect(maxLagSlots(policy)).toBe(300)
    expect(maxLagSlots({ ...policy, poll_seconds: 30 })).toBe(150)
  })
})

describe('streamLive', () => {
  it('holds up to the stall threshold and not a second past it', () => {
    expect(streamLive(report({ stream: { slot: 1, at: NOW - 30 } }))).toBe(true)
    expect(streamLive(report({ stream: { slot: 1, at: NOW - 31 } }))).toBe(false)
  })

  it('is down before the first slot notification', () => {
    expect(streamLive(report({ stream: { slot: null, at: null } }))).toBe(false)
  })
})

describe('judgeAttestor', () => {
  it('passes a healthy attestor, with its lag against the tip', () => {
    expect(judgeAttestor(report(), 1_004)).toEqual({ ok: true, reason: null, lag_slots: 4 })
  })

  it('without a tip judges by time alone', () => {
    expect(judgeAttestor(report())).toEqual({ ok: true, reason: null, lag_slots: null })
  })

  it('vouches for nothing before the first complete sweep', () => {
    const starting = report({ last_complete_sweep: null, examined_slot: null })
    expect(judgeAttestor(starting, 1_000)).toEqual({
      ok: false,
      reason: 'starting',
      lag_slots: null,
    })
  })

  // While the stream is up the sweep is the reconcile safety net: two of its intervals.
  it('with the stream up, allows two reconcile intervals between complete sweeps', () => {
    const at = (age: number) => report({ last_complete_sweep: { slot: 1, at: NOW - age } })
    expect(judgeAttestor(at(1_200)).ok).toBe(true)
    expect(judgeAttestor(at(1_201))).toMatchObject({ ok: false, reason: 'sweep_overdue' })
  })

  // While it is down the sweep is all there is, so the bound is the poll's.
  it('with the stream down, allows two polls between complete sweeps', () => {
    const down = { slot: 1_000, at: NOW - 31 }
    const at = (age: number) =>
      report({ stream: down, last_complete_sweep: { slot: 1, at: NOW - age } })
    expect(judgeAttestor(at(120)).ok).toBe(true)
    expect(judgeAttestor(at(121))).toMatchObject({ ok: false, reason: 'sweep_overdue' })
  })

  it('goes red once the lag passes two polls of slots', () => {
    expect(judgeAttestor(report(), 1_300)).toEqual({ ok: true, reason: null, lag_slots: 300 })
    expect(judgeAttestor(report(), 1_301)).toEqual({
      ok: false,
      reason: 'behind_tip',
      lag_slots: 301,
    })
  })

  it('does not read a slot notified ahead of the confirmed tip as a lead', () => {
    expect(judgeAttestor(report({ examined_slot: 1_010 }), 1_000).lag_slots).toBe(0)
  })

  // The report's own clock, not the judge's: a judge whose clock runs an hour fast would
  // otherwise call every attestor overdue.
  it('measures ages against the clock in the report', () => {
    const later = report({ now: NOW + 3_600, last_complete_sweep: { slot: 1, at: NOW + 3_540 } })
    expect(judgeAttestor({ ...later, stream: { slot: 1, at: NOW + 3_599 } }).ok).toBe(true)
  })
})

describe('schemas', () => {
  it('accept the report an attestor serves', () => {
    expect(attestorReportSchema.parse(report())).toEqual(report())
  })

  it('refuse a report with a reason no attestor gives', () => {
    expect(attestorReportSchema.safeParse({ ...report(), reason: 'fine' }).success).toBe(false)
  })

  it('accept a health body with an attestor that did not answer', () => {
    const body = {
      ok: false,
      slot: 10,
      lag_slots: 0,
      attestors: [
        {
          attestor: null,
          ok: false,
          reason: 'unreachable',
          examined_slot: null,
          lag_slots: null,
          last_complete_sweep_at: null,
        },
      ],
      quorum_needed: 2,
      quorum_alive: false,
    }
    expect(healthResponseSchema.parse(body)).toEqual(body)
  })

  // `web` ships to Pages before the VM runs the `api` that sends `protocols` (T079).
  it('still reads a /health from an api that predates the protocol count', () => {
    const body = {
      ok: true,
      slot: 509_194_334,
      lag_slots: 323,
      attestors: [
        {
          attestor: 'BpZLNoQs88L4gfKx8samxUdHaZpNuRBgApcr43irUPES',
          ok: true,
          reason: null,
          examined_slot: 509_194_659,
          lag_slots: 0,
          last_complete_sweep_at: 1_791_552_673,
        },
      ],
      quorum_needed: 2,
      quorum_alive: true,
    }
    expect(healthResponseSchema.parse(body)).toEqual(body)
    expect(attestorReportSchema.shape.protocols.safeParse(undefined).success).toBe(true)
  })
})
