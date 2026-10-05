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

/** The seconds between the quorum and the payout, when there was both. */
export const settlementDelay = (events: IncidentEvent[]): number | null => {
  const quorum = events.find((e) => e.kind === 'attestation' && e.quorumReached)
  const payout = events.find((e) => e.kind === 'payout')
  return quorum === undefined || payout === undefined ? null : payout.at - quorum.at
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
