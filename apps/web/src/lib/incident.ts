/**
 * An incident as a sequence of what happened on chain (T055) — pure, so the timeline,
 * its replay and the trail all read one order and one clock. Nothing here adds a fact:
 * every event is a transaction or an account the response names, at the time it gives.
 */
import type { AttestationResponse, IncidentDetailResponse } from '@mandate/shared'

export type IncidentEvent =
  | { kind: 'trigger'; t: number; at: number; signature: string; slot: number | null }
  | { kind: 'opened'; t: number; at: number; signature: string | null; opener: string }
  | {
      kind: 'attestation'
      t: number
      at: number
      attestor: string
      verdict: AttestationResponse['verdict']
      signature: string | null
      /** `unauthorized` attestations so far, this one included — what the quorum counts. */
      tally: number
      /** The attestation that took the tally to `quorum_needed`. */
      quorumReached: boolean
    }
  | {
      kind: 'payout'
      t: number
      at: number
      signature: string
      amount: string
      beneficiary: string
    }

/**
 * Where the clock starts: the trigger's block time, which is what the rule evaluates
 * the declaration at. When the RPC no longer returns the trigger, the opening — the
 * page then says it counts from there.
 */
export const clockOf = (detail: IncidentDetailResponse) =>
  detail.trigger.block_time === null
    ? { origin: detail.opened.at, from: 'opening' as const }
    : { origin: detail.trigger.block_time, from: 'trigger' as const }

export const timelineOf = (detail: IncidentDetailResponse): IncidentEvent[] => {
  const { origin } = clockOf(detail)
  const { incident } = detail
  const events: IncidentEvent[] = []

  if (detail.trigger.block_time !== null) {
    events.push({
      kind: 'trigger',
      t: 0,
      at: detail.trigger.block_time,
      signature: detail.trigger.signature,
      slot: detail.trigger.slot,
    })
  }
  events.push({
    kind: 'opened',
    t: detail.opened.at - origin,
    at: detail.opened.at,
    signature: detail.opened.signature,
    opener: incident.opener,
  })

  let tally = 0
  let reached = false
  for (const a of detail.attestations) {
    if (a.verdict === 'unauthorized') tally += 1
    const completes = !reached && a.verdict === 'unauthorized' && tally === incident.quorum_needed
    if (completes) reached = true
    events.push({
      kind: 'attestation',
      t: a.submitted_at - origin,
      at: a.submitted_at,
      attestor: a.attestor,
      verdict: a.verdict,
      signature: a.signature,
      tally,
      quorumReached: completes,
    })
  }

  if (detail.payout !== null) {
    events.push({
      kind: 'payout',
      t: detail.payout.at - origin,
      at: detail.payout.at,
      signature: detail.payout.signature,
      amount: detail.payout.amount,
      beneficiary: detail.payout.beneficiary,
    })
  }

  // Pushed in the order the program allows within a second — trigger, opening,
  // attestations in the API's order, payout — and the sort is stable, so ties keep it.
  return events.sort((a, b) => a.at - b.at)
}

/**
 * Seconds from the clock's origin to where the incident stopped: the payout, or the
 * deadline for one closed without — `close_expired_incident` acts only past it, and the
 * contract carries no closing time. `null` while it is open.
 */
export const endOf = (detail: IncidentDetailResponse): number | null => {
  const { origin } = clockOf(detail)
  if (detail.incident.status === 'open') return null
  if (detail.payout !== null) return detail.payout.at - origin
  return detail.incident.deadline - origin
}

/** How a paid incident's money moved relative to the vote that decided it. */
export type Settlement =
  /** The vote that completed the quorum paid out in the same transaction (FR-012). */
  | { kind: 'deciding-vote' }
  /** A separate `resolve`, `delay` seconds after the quorum — how the program paid
   * until it was upgraded in October 2026 (T078). */
  | { kind: 'separate'; delay: number }

/**
 * Read from the signatures, not assumed: devnet holds incidents paid both ways, and the
 * page has to say which one it is looking at. `null` without a payout, or while the
 * deciding attestation's signature is not indexed yet — the two cannot be compared.
 */
export const settlementOf = (events: IncidentEvent[]): Settlement | null => {
  const quorum = events.find((e) => e.kind === 'attestation' && e.quorumReached)
  const payout = events.find((e) => e.kind === 'payout')
  if (quorum?.kind !== 'attestation' || payout?.kind !== 'payout') return null
  if (quorum.signature === null) return null
  return quorum.signature === payout.signature
    ? { kind: 'deciding-vote' }
    : { kind: 'separate', delay: payout.at - quorum.at }
}

/** The longest a replay runs. A real incident fits it many times over (~10 s on devnet). */
export const REPLAY_MAX_SECONDS = 60

/**
 * Real time, unless the incident took longer than a replay is worth watching — one that
 * closed on a 24-hour deadline plays at whatever speed brings it into a minute, and the
 * page says how much faster.
 */
export const replaySpeed = (duration: number): number =>
  duration <= REPLAY_MAX_SECONDS ? 1 : duration / REPLAY_MAX_SECONDS

/** A named point on the phase strip above the timeline (T058). */
export type Milestone = {
  kind: 'trigger' | 'opened' | 'quorum' | 'paid' | 'decided' | 'closed'
  t: number
}

/**
 * The few moments worth naming at a glance, out of the full record: the trigger, the
 * opening, the vote that completed the quorum and the payout — one mark when the
 * deciding vote paid in its own transaction, so the strip does not draw two at the same
 * second claiming two transactions. An incident closed without a payout ends at its
 * deadline, which is the end `endOf` gives it.
 */
export const milestonesOf = (
  events: IncidentEvent[],
  detail: IncidentDetailResponse,
): Milestone[] => {
  const settlement = settlementOf(events)
  const marks: Milestone[] = []
  for (const e of events) {
    if (e.kind === 'trigger') marks.push({ kind: 'trigger', t: e.t })
    else if (e.kind === 'opened') marks.push({ kind: 'opened', t: e.t })
    else if (e.kind === 'attestation' && e.quorumReached)
      marks.push({ kind: settlement?.kind === 'deciding-vote' ? 'decided' : 'quorum', t: e.t })
    else if (e.kind === 'payout' && settlement?.kind !== 'deciding-vote')
      marks.push({ kind: 'paid', t: e.t })
  }
  const end = endOf(detail)
  if (detail.incident.status === 'closed_no_payout' && end !== null)
    marks.push({ kind: 'closed', t: end })
  return marks
}

/** `T+22 s`, `T+14 min`, `T+24 h` — seconds while they read as seconds. */
export const sinceLabel = (t: number): string => {
  const s = Math.max(0, Math.round(t))
  if (s < 120) return `T+${s} s`
  if (s < 7200) return `T+${Math.round(s / 60)} min`
  const h = s / 3600
  return `T+${h < 10 ? Number(h.toFixed(1)) : Math.round(h)} h`
}

export type LabelSlot = { row: number; align: 'start' | 'end' }

/**
 * Where each mark's label goes on a strip `width` pixels wide: hanging right of its
 * mark, or left of it when it would run off the end, and on the first row where it
 * overlaps no label already placed — so marks a second apart stay legible on a strip
 * that spans a day. `xs` in pixels, in the order the marks are drawn.
 */
export const labelSlots = (xs: number[], width: number, labelWidth: number): LabelSlot[] => {
  const rows: Array<Array<[number, number]>> = []
  return xs.map((x) => {
    const align = x + labelWidth <= width ? 'start' : 'end'
    const from = align === 'start' ? x : x - labelWidth
    const to = from + labelWidth
    let row = rows.findIndex((taken) => taken.every(([a, b]) => to <= a || from >= b))
    if (row === -1) row = rows.push([]) - 1
    rows[row]?.push([from, to])
    return { row, align }
  })
}
