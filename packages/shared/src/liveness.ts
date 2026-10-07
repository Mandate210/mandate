import { z } from 'zod'
import { pubkeySchema, unixTsSchema } from './api'

/**
 * Attestor liveness (T069): what an attestor says about itself, and the one rule that
 * reads it.
 *
 * A silent attestor looks exactly like nothing happening — no incident opens, nobody
 * finds out, and SC-001 is broken without a trace. So every attestor serves a report of
 * how far it has looked, and this rule decides whether that is far enough.
 *
 * Decided 2026-10-06 (`docs/PLAN.md` → «Живість атестатора (T069)»):
 *
 * - **The attestor reports facts, not a verdict to trust.** Its own `ok` is a
 *   convenience for whoever watches it directly; `api` judges the facts again with the
 *   cluster tip, which the attestor does not read per request — a public endpoint that
 *   spent an RPC call on every hit would hand anyone the attestor's credit budget.
 * - **Ages come from the attestor's own clock.** The report carries its `now`, so two
 *   parties whose clocks disagree still agree on how stale a sweep is.
 * - **Thresholds come from the attestor's own policy.** An operator who polls more
 *   slowly is judged against what they configured, not against our defaults.
 */

const countSchema = z.number().int().nonnegative()

/** Solana's target slot time; slots that run slower only loosen the bound. */
const SLOT_SECONDS = 0.4

export const livenessReasonSchema = z.enum([
  /** No complete sweep yet: the process has not vouched for anything. */
  'starting',
  /** The last complete sweep is older than the policy allows — the safety net is down. */
  'sweep_overdue',
  /** Further behind the cluster tip than one missed fallback poll explains. */
  'behind_tip',
  /** No answer from the attestor's `/health` in time. Only `api` can say this. */
  'unreachable',
  /** An answer that is not a report. Only `api` can say this. */
  'invalid_report',
])

/** `GET /health` of one attestor. */
export const attestorReportSchema = z.object({
  attestor: pubkeySchema,
  /** The attestor's clock when it wrote this report, Unix seconds. */
  now: unixTsSchema,
  /**
   * Every privileged transaction at or below this slot has been handed to the decision
   * and handled. Null until the first complete sweep — before that nothing is vouched for.
   */
  examined_slot: countSchema.nullable(),
  /** The last slot notification, and when it arrived. The stream's own heartbeat. */
  stream: z.object({ slot: countSchema.nullable(), at: unixTsSchema.nullable() }),
  /**
   * The last sweep that read every watched address to its end without an error, and
   * the confirmed tip when it started — what that sweep can vouch for.
   */
  last_complete_sweep: z.object({ slot: countSchema, at: unixTsSchema }).nullable(),
  /** Transactions the decision failed on, waiting for another attempt (T077). */
  pending: countSchema,
  policy: z.object({
    stall_seconds: z.number().positive(),
    poll_seconds: z.number().positive(),
    reconcile_seconds: z.number().positive(),
  }),
  ok: z.boolean(),
  reason: livenessReasonSchema.nullable(),
})

/** One attestor as `api`'s `/health` reports it. */
export const attestorStatusSchema = z.object({
  /** Null when the attestor did not answer, so its key is not known. */
  attestor: pubkeySchema.nullable(),
  ok: z.boolean(),
  reason: livenessReasonSchema.nullable(),
  examined_slot: countSchema.nullable(),
  /** Cluster tip less `examined_slot`; null when either is unknown. */
  lag_slots: countSchema.nullable(),
  last_complete_sweep_at: unixTsSchema.nullable(),
})

/**
 * `GET /health` of `api`. `slot` and `lag_slots` are the indexer's; `attestors` are the
 * ones this deployment watches, and `ok` is false if any of them is not — every one of
 * them is ours on M2, so one falling silent is already an incident, even while the
 * quorum survives it. `quorum_alive` tells degradation from failure.
 */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  slot: countSchema,
  lag_slots: countSchema,
  attestors: z.array(attestorStatusSchema),
  /** Attestations an incident opened now would need; null before the first census. */
  quorum_needed: countSchema.nullable(),
  /** Whether the live attestors among `attestors` can still carry a quorum on their own. */
  quorum_alive: z.boolean(),
})

export type AttestorReport = z.infer<typeof attestorReportSchema>
export type AttestorStatus = z.infer<typeof attestorStatusSchema>
export type HealthResponse = z.infer<typeof healthResponseSchema>
export type LivenessReason = z.infer<typeof livenessReasonSchema>

/**
 * How far behind the tip an attestor may be: two fallback polls. With the stream up the
 * lag is a few slots; with it down, `examined_slot` moves once per poll, so one poll's
 * worth of lag is the design working and a second one is a poll that did not happen.
 */
export const maxLagSlots = (policy: AttestorReport['policy']): number =>
  Math.ceil((2 * policy.poll_seconds) / SLOT_SECONDS)

/**
 * Whether the stream counts as alive at the moment of the report — the same test the
 * watcher's own `sweepDue` applies, from the same policy.
 */
export const streamLive = (report: Pick<AttestorReport, 'now' | 'stream' | 'policy'>): boolean =>
  report.stream.at !== null && report.now - report.stream.at <= report.policy.stall_seconds

/**
 * The liveness rule. `tip` is the cluster's confirmed slot when the judge has one; an
 * attestor judging itself passes none and skips the one check that needs it.
 *
 * The sweep is overdue past **two** of its intervals, for the same reason the lag bound
 * is two polls: one late sweep is a slow RPC, a second is a broken one. Which interval
 * depends on the stream — while it is up the sweep is the reconcile safety net, while it
 * is down the sweep is the only eyes the attestor has.
 */
export const judgeAttestor = (
  report: Omit<AttestorReport, 'ok' | 'reason'>,
  tip?: number,
): { ok: boolean; reason: LivenessReason | null; lag_slots: number | null } => {
  const lag =
    tip === undefined || report.examined_slot === null
      ? null
      : // A confirmed tip from one node can trail a slot another node notified; not a lead.
        Math.max(0, tip - report.examined_slot)
  if (report.last_complete_sweep === null) return { ok: false, reason: 'starting', lag_slots: lag }

  const interval = streamLive(report) ? report.policy.reconcile_seconds : report.policy.poll_seconds
  if (report.now - report.last_complete_sweep.at > 2 * interval) {
    return { ok: false, reason: 'sweep_overdue', lag_slots: lag }
  }
  if (lag !== null && lag > maxLagSlots(report.policy)) {
    return { ok: false, reason: 'behind_tip', lag_slots: lag }
  }
  return { ok: true, reason: null, lag_slots: lag }
}
