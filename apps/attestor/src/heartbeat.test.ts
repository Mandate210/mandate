import type { AddressInfo } from 'node:net'
import { attestorReportSchema } from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { buildReport, heartbeatApp, serveHeartbeat } from './heartbeat'
import { DEFAULT_WATCH_POLICY, type WatcherHealth } from './watch'

const ATTESTOR = 'Attestor1111111111111111111111111111111111'
const NOW = 1_800_000_000_000

/** Stream ticking, a complete sweep a minute ago, nothing stuck. */
const healthy = (overrides: Partial<WatcherHealth> = {}): WatcherHealth => ({
  stream: { slot: 1_000, at: NOW - 400 },
  lastCompleteSweep: { slot: 850, at: NOW - 60_000 },
  oldestPendingSlot: null,
  pending: 0,
  protocols: 4,
  ...overrides,
})

const reportOf = (health: WatcherHealth, now = NOW) =>
  buildReport({ attestor: ATTESTOR, health, policy: DEFAULT_WATCH_POLICY, now })

describe('buildReport', () => {
  it('vouches for nothing before the first complete sweep, however live the stream', () => {
    const report = reportOf(healthy({ lastCompleteSweep: null }))
    expect(report).toMatchObject({ examined_slot: null, ok: false, reason: 'starting' })
  })

  it('with the stream alive, vouches for its newest slot', () => {
    expect(reportOf(healthy())).toMatchObject({ examined_slot: 1_000, ok: true, reason: null })
  })

  // A stalled stream delivered nothing since its last slot; only the sweep looked since.
  it('with the stream stalled, vouches only for the tip before the last complete sweep', () => {
    const stalled = healthy({ stream: { slot: 1_000, at: NOW - 31_000 } })
    expect(reportOf(stalled).examined_slot).toBe(850)
  })

  it('never vouches past a transaction still waiting for its retry', () => {
    const stuck = healthy({ oldestPendingSlot: 900, pending: 1 })
    expect(reportOf(stuck)).toMatchObject({ examined_slot: 899, pending: 1 })
  })

  it('reports times in Unix seconds and its policy as configured', () => {
    const report = reportOf(healthy())
    expect(report.now).toBe(1_800_000_000)
    expect(report.stream).toEqual({ slot: 1_000, at: 1_799_999_999 })
    expect(report.last_complete_sweep).toEqual({ slot: 850, at: 1_799_999_940 })
    expect(report.policy).toEqual({ stall_seconds: 30, poll_seconds: 60, reconcile_seconds: 600 })
  })

  it('says how many protocols it watches (T079)', () => {
    expect(reportOf(healthy({ protocols: 7 })).protocols).toBe(7)
  })

  it('goes red when the safety net has not completed in two reconcile intervals', () => {
    const old = healthy({ lastCompleteSweep: { slot: 850, at: NOW - 1_201_000 } })
    expect(reportOf(old)).toMatchObject({ ok: false, reason: 'sweep_overdue' })
  })

  it('serves a report the shared schema accepts', () => {
    expect(attestorReportSchema.parse(reportOf(healthy()))).toEqual(reportOf(healthy()))
  })
})

describe('heartbeatApp', () => {
  it('answers 200 while healthy and 503 with the same report when not', async () => {
    let health = healthy()
    const app = heartbeatApp(() => reportOf(health))

    const up = await app.request('/health')
    expect(up.status).toBe(200)
    expect(attestorReportSchema.parse(await up.json()).ok).toBe(true)

    health = healthy({ lastCompleteSweep: null })
    const down = await app.request('/health')
    expect(down.status).toBe(503)
    expect(attestorReportSchema.parse(await down.json()).reason).toBe('starting')
  })

  // An uptime monitor's default method; the body is not needed to read the status.
  it('answers HEAD too', async () => {
    const response = await heartbeatApp(() => reportOf(healthy())).request('/health', {
      method: 'HEAD',
    })
    expect(response.status).toBe(200)
  })
})

describe('serveHeartbeat', () => {
  it('serves the report over a real socket, on loopback', async () => {
    const server = await serveHeartbeat({ report: () => reportOf(healthy()), port: 0 })
    try {
      const { address, port } = server.address() as AddressInfo
      expect(address).toBe('127.0.0.1')
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      expect(response.status).toBe(200)
      expect(attestorReportSchema.parse(await response.json()).attestor).toBe(ATTESTOR)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('refuses a port already taken instead of starting blind', async () => {
    const first = await serveHeartbeat({ report: () => reportOf(healthy()), port: 0 })
    try {
      const { port } = first.address() as AddressInfo
      await expect(serveHeartbeat({ report: () => reportOf(healthy()), port })).rejects.toThrow(
        /EADDRINUSE/,
      )
    } finally {
      await new Promise((resolve) => first.close(resolve))
    }
  })
})
