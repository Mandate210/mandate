import { BN } from '@coral-xyz/anchor'
import { type Db, schema, upsertNewer } from '@mandate/db'
import {
  declarationsResponseSchema,
  errorResponseSchema,
  incidentDetailResponseSchema,
  incidentsResponseSchema,
} from '@mandate/shared'
import { Keypair } from '@solana/web3.js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { CLUSTER_TIME, INCIDENT, PROTOCOL, fakeCluster } from '../fake-cluster'
import { addresses, attestationOf, encode, fields, keys, programId, sig } from '../fixtures'
import { createIndexer } from '../indexer'
import { type TestDb, openTestDb } from '../test-db'
import { decodeCursor, encodeCursor } from './incidents'

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
})

const indexed = async () => {
  const cluster = await fakeCluster()
  const indexer = createIndexer({ rpc: cluster.rpc, db, programId })
  await indexer.census()
  return { cluster, indexer }
}

const getJson = async (path: string) => {
  const response = await createApp({ db, tip: async () => 100 }).request(path)
  return { status: response.status, body: (await response.json()) as unknown }
}

const list = async (query = '') =>
  incidentsResponseSchema.parse((await getJson(`/incidents${query}`)).body)

const detail = async (address = INCIDENT) =>
  incidentDetailResponseSchema.parse((await getJson(`/incidents/${address}`)).body)

/** The trigger's block time in the fixture world: slot 90 (`fakeCluster`). */
const TRIGGER_TIME = 1_709_999_999

const newAddress = () => Keypair.generate().publicKey.toBase58()

type IncidentRow = typeof schema.incidents.$inferSelect
type DeclarationRow = typeof schema.declarations.$inferSelect

const indexedIncident = async (): Promise<IncidentRow> => {
  const [row] = await db.select().from(schema.incidents)
  if (row === undefined) throw new Error('the census wrote no incident')
  return row
}

/** More incidents beside the fixture's, as rows: the list reads nothing else. */
const addIncidents = async (rows: Partial<IncidentRow>[]) => {
  const base = await indexedIncident()
  const added = rows.map((row) => ({ ...base, address: newAddress(), ...row }))
  await upsertNewer(db, schema.incidents, added)
  return added
}

const indexedEntry = async (): Promise<DeclarationRow> => {
  const [row] = await db.select().from(schema.declarations)
  if (row === undefined) throw new Error('the census wrote no declaration')
  return row
}

const setIncident = (changes: Partial<IncidentRow>) =>
  db.update(schema.incidents).set(changes).where(eq(schema.incidents.address, INCIDENT))

describe('GET /incidents', () => {
  it('serves nothing before the first census', async () => {
    const { status, body } = await getJson('/incidents')
    expect(status).toBe(503)
    expect(errorResponseSchema.parse(body).error.code).toBe('INTERNAL')
  })

  it('lists the incidents at as_of, with no next page when they all fit', async () => {
    await indexed()
    const { status, body } = await getJson('/incidents')

    expect(status).toBe(200)
    const page = incidentsResponseSchema.parse(body)
    expect(page.as_of).toEqual({ slot: 100, unix_ts: CLUSTER_TIME })
    expect(page.incidents).toEqual([
      expect.objectContaining({
        address: INCIDENT,
        protocol: PROTOCOL,
        status: 'paid_out',
        quorum_needed: 2,
      }),
    ])
    expect(page.next_cursor).toBeNull()
  })

  it('pages newest first, address breaking a tie, each incident exactly once', async () => {
    await indexed()
    const base = await indexedIncident()
    // Three share an opened_at, so the order inside it — and the cursor across it — is
    // decided by the address alone.
    await addIncidents([
      { openedAt: base.openedAt + 10 },
      { openedAt: base.openedAt + 5 },
      { openedAt: base.openedAt + 5 },
      { openedAt: base.openedAt + 5 },
      { openedAt: base.openedAt - 1 },
    ])
    const expected = (await db.select().from(schema.incidents))
      .sort((a, b) => b.openedAt - a.openedAt || (a.address < b.address ? -1 : 1))
      .map((row) => row.address)

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await list(`?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`)
      expect(page.incidents.length).toBeLessThanOrEqual(2)
      seen.push(...page.incidents.map((incident) => incident.address))
      cursor = page.next_cursor
      pages += 1
      // A cursor that hands the same page out again would loop forever; fail instead.
    } while (cursor !== null && pages < 10)

    expect(seen).toEqual(expected)
    expect(pages).toBe(3)
  })

  it('shifts nothing when an incident opens between two pages', async () => {
    await indexed()
    const base = await indexedIncident()
    await addIncidents([{ openedAt: base.openedAt + 2 }, { openedAt: base.openedAt + 1 }])

    const first = await list('?limit=2')
    await addIncidents([{ openedAt: base.openedAt + 100 }])
    const second = await list(`?limit=2&cursor=${first.next_cursor}`)

    // An offset would have handed the second-newest out again; the key skips past it.
    expect(second.incidents.map((incident) => incident.address)).toEqual([INCIDENT])
    expect(second.next_cursor).toBeNull()
  })

  it('filters by protocol and by status, together', async () => {
    await indexed()
    const other = newAddress()
    const [open] = await addIncidents([
      { status: 'open', protocol: PROTOCOL },
      { status: 'open', protocol: other },
      { status: 'closed_no_payout', protocol: other },
    ])

    const byProtocol = await list(`?protocol=${PROTOCOL}`)
    expect(byProtocol.incidents.every((incident) => incident.protocol === PROTOCOL)).toBe(true)
    expect(byProtocol.incidents).toHaveLength(2)

    const both = await list(`?protocol=${PROTOCOL}&status=open`)
    expect(both.incidents.map((incident) => incident.address)).toEqual([open?.address])

    expect((await list('?status=closed_no_payout')).incidents).toHaveLength(1)
  })

  it('answers an empty list, not 404, for a protocol with no incidents', async () => {
    await indexed()
    const { status, body } = await getJson(`/incidents?protocol=${newAddress()}`)
    expect(status).toBe(200)
    expect(incidentsResponseSchema.parse(body).incidents).toEqual([])
  })

  it('answers 400 for a query outside the contract', async () => {
    await indexed()
    const forged = Buffer.from(`1:${'z'.repeat(44)}`).toString('base64url')
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=two',
      '?status=paid',
      `?protocol=${'z'.repeat(44)}`,
      '?cursor=not-a-cursor',
      `?cursor=${forged}`,
    ]) {
      const { status, body } = await getJson(`/incidents${query}`)
      expect(status, query).toBe(400)
      expect(errorResponseSchema.parse(body).error.code).toBe('INVALID_INPUT')
    }
  })
})

describe('the cursor', () => {
  it('round-trips the two keys of the order', () => {
    const cursor = { openedAt: 1_710_000_000, address: INCIDENT }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('refuses what it did not write', () => {
    for (const text of [
      '',
      'abc',
      Buffer.from(`x:${INCIDENT}`).toString('base64url'),
      Buffer.from(`1:${INCIDENT}:2`).toString('base64url'),
      Buffer.from('1:').toString('base64url'),
    ]) {
      expect(decodeCursor(text), text).toBeNull()
    }
  })
})

describe('GET /incidents/:pubkey', () => {
  it('returns the incident with its trigger, attestations, payout and verification', async () => {
    await indexed()
    const { status, body } = await getJson(`/incidents/${INCIDENT}`)

    expect(status).toBe(200)
    const incident = incidentDetailResponseSchema.parse(body)
    expect(incident.as_of).toEqual({ slot: 100, unix_ts: CLUSTER_TIME })
    expect(incident.incident).toMatchObject({ address: INCIDENT, status: 'paid_out' })
    expect(incident.trigger).toEqual({
      signature: incident.incident.trigger_signature,
      slot: 90,
      block_time: TRIGGER_TIME,
    })
    expect(incident.opened).toEqual({ signature: sig('SigOpen'), at: 1_710_000_000 })
    expect(incident.payout).toEqual({
      signature: sig('SigResolve'),
      amount: '9500',
      beneficiary: keys.beneficiary.toBase58(),
      at: 1_710_000_060,
    })
    expect(incident.verification.program_id).toBe(programId.toBase58())
    expect(incident.verification.accounts).toEqual({
      config: addresses.config.toBase58(),
      protocol: PROTOCOL,
      pool: addresses.pool.toBase58(),
      policy: addresses.policy0.toBase58(),
      incident: INCIDENT,
      // The pool account's own field — the address the program holds it to.
      vault: keys.vault.toBase58(),
    })
  })

  it('lists every attestation with the transaction that made it, oldest first', async () => {
    await indexed()
    const attestations = (await detail()).attestations

    const a = {
      attestor: keys.attestorA.toBase58(),
      attestation: attestationOf(keys.attestorA).toBase58(),
      verdict: 'unauthorized',
      submitted_at: 1_710_000_010,
      signature: sig('SigAttestA'),
    }
    const b = {
      attestor: keys.attestorB.toBase58(),
      attestation: attestationOf(keys.attestorB).toBase58(),
      verdict: 'authorized',
      submitted_at: 1_710_000_010,
      signature: sig('SigAttestB'),
    }
    // Submitted in the same second: the attestor's key breaks the tie, stably.
    expect(attestations).toEqual([a, b].sort((x, y) => (x.attestor < y.attestor ? -1 : 1)))

    await db
      .update(schema.attestations)
      .set({ submittedAt: 1_710_000_005 })
      .where(eq(schema.attestations.attestor, b.attestor))
    expect((await detail()).attestations.map((row) => row.attestor)).toEqual([
      b.attestor,
      a.attestor,
    ])
  })

  it('evaluates the declaration at the trigger, not at as_of', async () => {
    const { cluster, indexer } = await indexed()
    // Revoked after the trigger and before as_of: effective then, revoked now.
    await cluster.replace(
      addresses.declaration0.toBase58(),
      await encode('DeclarationEntry', fields.declaration({ revoked_at: new BN(1_710_000_000) })),
    )
    cluster.setSlot(101)
    await indexer.census()
    const declarations = declarationsResponseSchema.parse(
      (await getJson(`/protocols/${PROTOCOL}/declarations`)).body,
    )
    expect(declarations.entries.map((entry) => entry.state)).toEqual(['revoked'])

    const { declaration_at_trigger } = (await detail()).verification
    expect(declaration_at_trigger.evaluated_at).toBe(TRIGGER_TIME)
    expect(declaration_at_trigger.entries).toEqual([
      { ...declarations.entries[0], state: 'effective' },
    ])
  })

  it('leaves out an entry submitted after the trigger, and keeps one submitted at it', async () => {
    await indexed()
    const entry = await indexedEntry()
    const later = { ...entry, address: newAddress(), seq: '1', submittedAt: TRIGGER_TIME + 1 }
    const atTrigger = {
      ...entry,
      address: newAddress(),
      seq: '2',
      submittedAt: TRIGGER_TIME,
      effectiveAt: TRIGGER_TIME + 30,
      revokedAt: null,
    }
    await upsertNewer(db, schema.declarations, [later, atTrigger])

    const { entries } = (await detail()).verification.declaration_at_trigger
    expect(entries.map((row) => [row.address, row.state])).toEqual([
      [entry.address, 'effective'],
      // It existed, though not yet in force: the reader sees why it did not cover.
      [atTrigger.address, 'pending'],
    ])
  })

  it("leaves out another protocol's entries", async () => {
    await indexed()
    const entry = await indexedEntry()
    await upsertNewer(db, schema.declarations, [
      { ...entry, address: newAddress(), protocol: newAddress() },
    ])
    expect((await detail()).verification.declaration_at_trigger.entries).toHaveLength(1)
  })

  it('evaluates nothing when the trigger cannot be dated', async () => {
    await indexed()
    await setIncident({ triggerSlot: null, triggerBlockTime: null })

    const incident = await detail()
    expect(incident.trigger).toMatchObject({ slot: null, block_time: null })
    expect(incident.verification.declaration_at_trigger).toEqual({
      evaluated_at: null,
      entries: [],
    })
  })

  it('shows no payout until the paying transaction is found, and none for an open incident', async () => {
    await indexed()
    await setIncident({ payoutSignature: null, payoutAt: null })
    const unfound = await detail()
    expect(unfound.incident.status).toBe('paid_out')
    expect(unfound.payout).toBeNull()

    await setIncident({
      status: 'open',
      payoutSignature: sig('SigResolve'),
      payoutAt: 1_710_000_060,
    })
    expect((await detail()).payout).toBeNull()
  })

  it('answers 404 for an incident the cache does not hold, or holds only half of', async () => {
    await indexed()
    const unknown = newAddress()
    const { status, body } = await getJson(`/incidents/${unknown}`)
    expect(status).toBe(404)
    expect(errorResponseSchema.parse(body).error).toMatchObject({
      code: 'NOT_FOUND',
      details: { address: unknown },
    })

    await db.delete(schema.pools)
    expect((await getJson(`/incidents/${INCIDENT}`)).status).toBe(404)
  })

  it('answers 400 for what is not a 32-byte address', async () => {
    await indexed()
    for (const bad of ['z'.repeat(44), 'not-an-address']) {
      const { status, body } = await getJson(`/incidents/${bad}`)
      expect(status).toBe(400)
      expect(errorResponseSchema.parse(body).error.code).toBe('INVALID_INPUT')
    }
  })
})
