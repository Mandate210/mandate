// `GET /health` (T049, T069): how far the cache is behind the cluster, and whether the
// attestors this deployment watches are still looking.
//
// Decided 2026-10-02: `lag_slots` is the cluster's *confirmed* tip less the indexer's
// watermark, so the ~13s that `finalized` costs is in it, as docs/PLAN.md promises. Red
// only when a census has been missed — on a quiet program the watermark moves once per
// census, and a tighter bound would alarm on silence. Not ok answers 503 with the same
// body, so an uptime monitor that reads only the status code still sees it.
//
// Decided 2026-10-06 (T069): every attestor in `ATTESTOR_HEALTH_URLS` is asked for its
// heartbeat and judged by `judgeAttestor` against the same tip. Any one of them silent or
// behind turns this red — on M2 all of them are ours, so one falling quiet is already an
// incident even while the quorum survives it; `quorum_alive` says which of the two it is.

import { type Db, schema } from '@mandate/db'
import {
  type AttestorReport,
  type AttestorStatus,
  type HealthResponse,
  attestorReportSchema,
  judgeAttestor,
  quorumNeeded,
} from '@mandate/shared'
import { Hono } from 'hono'
import { fail } from '../errors'
import { DEFAULT_CENSUS_INTERVAL_SECONDS } from '../indexer'
import { readWatermark } from '../snapshot'

/** Solana's target slot time. Slots run slower at times, which only loosens the bound. */
const SLOT_SECONDS = 0.4

/** One and a half census intervals: one census late is a hiccup, the next one missed is not. */
export const MAX_LAG_SLOTS = Math.ceil((1.5 * DEFAULT_CENSUS_INTERVAL_SECONDS) / SLOT_SECONDS)

/** What asking one attestor produced: its report, or why there is none. */
export type AttestorProbe =
  | { report: AttestorReport }
  | { failure: 'unreachable' | 'invalid_report' }

/** Long enough for a loaded host, short enough that a monitor's own timeout is not hit. */
export const PROBE_TIMEOUT_MS = 2_000

/**
 * Asks every heartbeat at once. A 503 is still a report — an attestor that judges itself
 * unwell says why in the body — so the status is not what decides `unreachable`.
 */
export const probeAttestors =
  (urls: readonly string[], timeoutMs = PROBE_TIMEOUT_MS) =>
  (): Promise<AttestorProbe[]> =>
    Promise.all(
      urls.map(async (url): Promise<AttestorProbe> => {
        let body: unknown
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
          body = await response.json()
        } catch {
          return { failure: 'unreachable' }
        }
        const parsed = attestorReportSchema.safeParse(body)
        return parsed.success ? { report: parsed.data } : { failure: 'invalid_report' }
      }),
    )

const statusOf = (probe: AttestorProbe, tip: number): AttestorStatus => {
  if ('failure' in probe) {
    return {
      attestor: null,
      ok: false,
      reason: probe.failure,
      examined_slot: null,
      lag_slots: null,
      last_complete_sweep_at: null,
      protocols: null,
    }
  }
  const { report } = probe
  // The attestor's own `ok` is not trusted: the rule runs again, this time with the tip.
  const { ok, reason, lag_slots } = judgeAttestor(report, tip)
  return {
    attestor: report.attestor,
    ok,
    reason,
    examined_slot: report.examined_slot,
    lag_slots,
    last_complete_sweep_at: report.last_complete_sweep?.at ?? null,
    protocols: report.protocols ?? null,
  }
}

export const healthRoutes = ({
  db,
  tip,
  attestors = async () => [],
  maxLagSlots = MAX_LAG_SLOTS,
}: {
  db: Db
  /** The cluster's confirmed slot. The one RPC call any route makes. */
  tip: () => Promise<number>
  /** The heartbeats to fold in; none by default. */
  attestors?: () => Promise<AttestorProbe[]>
  maxLagSlots?: number
}) =>
  new Hono().get('/health', async (c) => {
    const [watermark, cluster, probes, [config]] = await Promise.all([
      readWatermark(db),
      tip().then(
        (slot) => slot,
        () => null,
      ),
      attestors(),
      db.select().from(schema.config).limit(1),
    ])
    if (cluster === null) return fail(c, 503, 'INTERNAL', 'The cluster tip could not be read')

    // Nothing indexed yet reads as the whole chain behind — red, and visibly so.
    const slot = watermark?.slot ?? 0
    // A confirmed tip from one node can trail a finalized slot from another; not a lead.
    const lag = Math.max(0, cluster - slot)
    const indexerOk = watermark !== null && lag <= maxLagSlots

    const statuses = probes.map((probe) => statusOf(probe, cluster))
    // Distinct keys: two URLs that reach the same attestor are one vote, not two.
    const live = new Set(statuses.filter((s) => s.ok).map((s) => s.attestor)).size
    // From the cached `Config`, so the denominator is the program's, not our assumption.
    const needed = config ? quorumNeeded(config.attestorCount, config.quorumBps) : null
    const quorumAlive = needed !== null && live >= needed

    const body: HealthResponse = {
      ok: indexerOk && statuses.every((s) => s.ok) && quorumAlive,
      slot,
      lag_slots: lag,
      attestors: statuses,
      quorum_needed: needed,
      quorum_alive: quorumAlive,
    }
    return c.json(body, body.ok ? 200 : 503)
  })
