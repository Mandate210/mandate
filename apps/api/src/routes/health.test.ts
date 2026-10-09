import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Db } from '@mandate/db'
import { healthResponseSchema } from '@mandate/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { fakeCluster } from '../fake-cluster'
import { programId } from '../fixtures'
import { createIndexer } from '../indexer'
import { type TestDb, openTestDb } from '../test-db'
import { type AttestorProbe, probeAttestors } from './health'
import { attestorReport } from './health.fixtures'

let testDb: TestDb
let db: Db

beforeAll(async () => {
  testDb = await openTestDb()
  db = testDb.db
})

afterAll(async () => {
  await testDb.close()
})

beforeEach(async () => {
  await testDb.clear()
  // The fixture world at slot 100: `Config` admits two attestors at 60 %, so two votes.
  const cluster = await fakeCluster()
  await createIndexer({ rpc: cluster.rpc, db, programId }).census()
})

const TIP = 400

const health = async (probes: AttestorProbe[]) => {
  const app = createApp({ db, tip: async () => TIP, attestors: async () => probes })
  const response = await app.request('/health')
  return { status: response.status, body: healthResponseSchema.parse(await response.json()) }
}

describe('GET /health — attestors (T069)', () => {
  it('is ok while every watched attestor is live and they carry the quorum', async () => {
    const one = attestorReport({ examined_slot: 398 })
    const two = attestorReport({ examined_slot: 400 })
    const { status, body } = await health([{ report: one }, { report: two }])

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, quorum_needed: 2, quorum_alive: true })
    expect(body.attestors).toEqual([
      {
        attestor: one.attestor,
        ok: true,
        reason: null,
        examined_slot: 398,
        lag_slots: 2,
        last_complete_sweep_at: one.last_complete_sweep?.at,
        protocols: 3,
      },
      expect.objectContaining({ attestor: two.attestor, ok: true, lag_slots: 0 }),
    ])
  })

  // The decision of 2026-10-06: all of them are ours, so one going quiet is an incident
  // even though the remaining two still pay out. `quorum_alive` tells the two apart.
  it('goes red when one of three is silent, while saying the quorum survives', async () => {
    const { status, body } = await health([
      { report: attestorReport() },
      { report: attestorReport() },
      { failure: 'unreachable' },
    ])
    expect(status).toBe(503)
    expect(body).toMatchObject({ ok: false, quorum_alive: true })
    expect(body.attestors[2]).toEqual({
      attestor: null,
      ok: false,
      reason: 'unreachable',
      examined_slot: null,
      lag_slots: null,
      last_complete_sweep_at: null,
      protocols: null,
    })
  })

  // T079: an attestor that missed a registration shows it as a smaller number than the
  // rest. One built before the field still parses — it is run by somebody else.
  it('reports how many protocols each attestor watches, null from one that does not say', async () => {
    const { protocols: _, ...older } = attestorReport()
    const { status, body } = await health([
      { report: attestorReport({ protocols: 5 }) },
      { report: older },
    ])
    expect(status).toBe(200)
    expect(body.attestors.map((attestor) => attestor.protocols)).toEqual([5, null])
  })

  it('says the quorum is gone when fewer live attestors remain than it needs', async () => {
    const { body } = await health([
      { report: attestorReport() },
      { report: attestorReport({ last_complete_sweep: null, examined_slot: null }) },
    ])
    expect(body).toMatchObject({ ok: false, quorum_alive: false })
    expect(body.attestors[1]).toMatchObject({ ok: false, reason: 'starting' })
  })

  // Judged again with the tip: the attestor cannot see its own lag without one.
  it('finds an attestor behind the tip that calls itself healthy', async () => {
    const behind = attestorReport({ examined_slot: TIP - 301 })
    expect(behind.ok).toBe(true)

    const { body } = await health([{ report: attestorReport() }, { report: behind }])
    expect(body.ok).toBe(false)
    expect(body.attestors[1]).toMatchObject({ ok: false, reason: 'behind_tip', lag_slots: 301 })
  })

  it('counts two URLs reaching the same attestor as one vote', async () => {
    const same = attestorReport()
    const { body } = await health([{ report: same }, { report: same }])
    expect(body).toMatchObject({ ok: false, quorum_alive: false })
  })

  it('watching none, is red while the program needs votes nobody here gives', async () => {
    const { status, body } = await health([])
    expect(status).toBe(503)
    expect(body).toMatchObject({ ok: false, attestors: [], quorum_needed: 2, quorum_alive: false })
  })
})

describe('probeAttestors', () => {
  const servers: Server[] = []

  /** A heartbeat endpoint answering with `status` and `body`. */
  const serve = async (status: number, body: string): Promise<string> => {
    const server = createServer((_, response) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(body)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`
  }

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  })

  // An attestor that judges itself unwell answers 503 and says why — still a report.
  it('reads the report from a 503 as well as from a 200', async () => {
    const up = attestorReport()
    const down = attestorReport({ last_complete_sweep: null, examined_slot: null })
    const probes = await probeAttestors([
      await serve(200, JSON.stringify(up)),
      await serve(503, JSON.stringify(down)),
    ])()
    expect(probes).toEqual([{ report: up }, { report: down }])
  })

  it('reports an answer that is not a report as invalid', async () => {
    const probes = await probeAttestors([
      await serve(200, '{"ok":true}'),
      await serve(200, '<html>'),
    ])()
    expect(probes).toEqual([{ failure: 'invalid_report' }, { failure: 'unreachable' }])
  })

  it('reports a closed port and a hung one as unreachable, the hung one within the timeout', async () => {
    const closed = await serve(200, '{}')
    const port = Number(new URL(closed).port)
    await new Promise((resolve) => servers.pop()?.close(resolve))

    const hung = createServer(() => {})
    servers.push(hung)
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve))
    const hungUrl = `http://127.0.0.1:${(hung.address() as AddressInfo).port}/health`

    const started = Date.now()
    const probes = await probeAttestors([`http://127.0.0.1:${port}/health`, hungUrl], 200)()
    expect(probes).toEqual([{ failure: 'unreachable' }, { failure: 'unreachable' }])
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
