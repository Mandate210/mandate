// `GET /health` (T049): how far the cache is behind the cluster.
//
// Decided 2026-10-02: `lag_slots` is the cluster's *confirmed* tip less the indexer's
// watermark, so the ~13s that `finalized` costs is in it, as docs/PLAN.md promises. Red
// only when a census has been missed — on a quiet program the watermark moves once per
// census, and a tighter bound would alarm on silence. Not ok answers 503 with the same
// body, so an uptime monitor that reads only the status code still sees it.
// T069 extends this with the attestors' heartbeat.

import type { Db } from '@mandate/db'
import type { HealthResponse } from '@mandate/shared'
import { Hono } from 'hono'
import { fail } from '../errors'
import { DEFAULT_CENSUS_INTERVAL_SECONDS } from '../indexer'
import { readWatermark } from '../snapshot'

/** Solana's target slot time. Slots run slower at times, which only loosens the bound. */
const SLOT_SECONDS = 0.4

/** One and a half census intervals: one census late is a hiccup, the next one missed is not. */
export const MAX_LAG_SLOTS = Math.ceil((1.5 * DEFAULT_CENSUS_INTERVAL_SECONDS) / SLOT_SECONDS)

export const healthRoutes = ({
  db,
  tip,
  maxLagSlots = MAX_LAG_SLOTS,
}: {
  db: Db
  /** The cluster's confirmed slot. The one RPC call any route makes. */
  tip: () => Promise<number>
  maxLagSlots?: number
}) =>
  new Hono().get('/health', async (c) => {
    const [watermark, cluster] = await Promise.all([
      readWatermark(db),
      tip().then(
        (slot) => slot,
        () => null,
      ),
    ])
    if (cluster === null) return fail(c, 503, 'INTERNAL', 'The cluster tip could not be read')

    // Nothing indexed yet reads as the whole chain behind — red, and visibly so.
    const slot = watermark?.slot ?? 0
    // A confirmed tip from one node can trail a finalized slot from another; not a lead.
    const lag = Math.max(0, cluster - slot)
    const body: HealthResponse = {
      ok: watermark !== null && lag <= maxLagSlots,
      slot,
      lag_slots: lag,
    }
    return c.json(body, body.ok ? 200 : 503)
  })
