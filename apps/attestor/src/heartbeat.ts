// The attestor's heartbeat (T069): `GET /health`, a report of how far it has looked.
//
// A silent attestor looks exactly like a quiet chain, so it says what it can vouch for
// instead of being asked to prove a negative. The rule that reads the report is
// `judgeAttestor` in `packages/shared`; `api` applies it again with the cluster tip and
// folds every attestor it watches into its own `/health` (decided 2026-10-06: a URL per
// attestor, not a row in our database — an attestor run by another party has no reason
// to hold our credentials, and publishing a URL is all M3 asks of it).
//
// No RPC per request. The endpoint is public wherever its operator puts it, and a
// handler that read the tip would spend the attestor's credit budget for whoever polls.

import { type Server, createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { type AttestorReport, judgeAttestor, streamLive } from '@mandate/shared'
import { Hono } from 'hono'
import type { WatchPolicy, WatcherHealth } from './watch'

const seconds = (ms: number): number => Math.floor(ms / 1000)

/**
 * The public report, from the watcher's raw facts.
 *
 * `examined_slot` is the furthest the attestor can vouch for: the newest slot
 * notification while the stream is alive, otherwise the tip before the last complete
 * sweep — and never past a transaction still waiting for its retry, because nothing at
 * or beyond that slot has been handled. A stuck transaction therefore shows as lag, which
 * is what it is: the incident it should have opened is not open.
 *
 * Null until the first complete sweep. A stream that is up says nothing about the
 * startup window, which only the sweep reads.
 */
export const buildReport = ({
  attestor,
  health,
  policy,
  now,
}: {
  attestor: string
  health: WatcherHealth
  policy: Pick<WatchPolicy, 'stallSeconds' | 'pollSeconds' | 'reconcileSeconds'>
  /** Milliseconds. */
  now: number
}): AttestorReport => {
  const facts = {
    attestor,
    now: seconds(now),
    stream: health.stream
      ? { slot: health.stream.slot, at: seconds(health.stream.at) }
      : { slot: null, at: null },
    last_complete_sweep: health.lastCompleteSweep
      ? { slot: health.lastCompleteSweep.slot, at: seconds(health.lastCompleteSweep.at) }
      : null,
    pending: health.pending,
    policy: {
      stall_seconds: policy.stallSeconds,
      poll_seconds: policy.pollSeconds,
      reconcile_seconds: policy.reconcileSeconds,
    },
  }

  let examined: number | null = null
  if (facts.last_complete_sweep !== null) {
    examined = facts.last_complete_sweep.slot
    if (streamLive(facts) && facts.stream.slot !== null) {
      examined = Math.max(examined, facts.stream.slot)
    }
    if (health.oldestPendingSlot !== null) {
      examined = Math.max(0, Math.min(examined, health.oldestPendingSlot - 1))
    }
  }

  const report = { ...facts, examined_slot: examined }
  const { ok, reason } = judgeAttestor(report)
  return { ...report, ok, reason }
}

/** `GET /health`: the report, 503 when the attestor judges itself unwell. */
export const heartbeatApp = (report: () => AttestorReport) =>
  new Hono().get('/health', (c) => {
    const body = report()
    return c.json(body, body.ok ? 200 : 503)
  })

/**
 * Serves the heartbeat. Loopback by default: on a shared host `api` reads it locally,
 * and exposing it is the operator's decision, made with `ATTESTOR_HEALTH_HOST`.
 */
export const serveHeartbeat = ({
  report,
  port,
  host = '127.0.0.1',
}: {
  report: () => AttestorReport
  port: number
  host?: string
}): Promise<Server> => {
  const server = createServer(getRequestListener(heartbeatApp(report).fetch))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
