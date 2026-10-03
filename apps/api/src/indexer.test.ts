import { BN } from '@coral-xyz/anchor'
import { type Db, schema } from '@mandate/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { A, B, CLUSTER_TIME, INCIDENT, PROTOCOL, fakeCluster } from './fake-cluster'
import {
  addresses,
  attestTx,
  encode,
  fields,
  keys,
  openTx,
  programId,
  resolveTx,
  sig,
} from './fixtures'
import { idlAddress } from './idl'
import { createIndexer } from './indexer'
import { type TestDb, openTestDb } from './test-db'

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

const incidentRow = async () =>
  (await db.select().from(schema.incidents).where(eq(schema.incidents.address, INCIDENT)))[0]

describe('census', () => {
  it('rebuilds the whole cache from the chain alone', async () => {
    const cluster = await fakeCluster()
    const report = await createIndexer({ rpc: cluster.rpc, db, programId }).census()

    expect(report.unplaced).toBe(0)
    expect(report.written).toEqual({
      config: 1,
      protocols: 1,
      pools: 1,
      policies: 2,
      declarations: 1,
      incidents: 1,
      attestations: 2,
    })
    const [protocol] = await db.select().from(schema.protocols)
    expect(protocol?.protocolId).toBe(keys.protocolId.toBase58())
    const [config] = await db.select().from(schema.config)
    expect(config).toMatchObject({ assetDecimals: 6, programId: programId.toBase58() })
  })

  it("recovers every signature the trail needs from the accounts' own history", async () => {
    const cluster = await fakeCluster()
    await createIndexer({ rpc: cluster.rpc, db, programId }).census()

    expect(await incidentRow()).toMatchObject({
      openedSignature: sig('SigOpen'),
      payoutSignature: sig('SigResolve'),
      payoutAt: 1_710_000_060,
      triggerSlot: 90,
      triggerBlockTime: 1_709_999_999,
    })
    const attestations = await db.select().from(schema.attestations)
    expect(Object.fromEntries(attestations.map((row) => [row.address, row.signature]))).toEqual({
      [A]: sig('SigAttestA'),
      [B]: sig('SigAttestB'),
    })
  })

  it('costs nothing extra the second time: provenance once, only the IDL is read again', async () => {
    const cluster = await fakeCluster()
    const indexer = createIndexer({ rpc: cluster.rpc, db, programId })
    await indexer.census()
    cluster.calls.length = 0
    cluster.setSlot(101)
    const report = await indexer.census()

    expect(report.filled).toBe(0)
    // The declared program's IDL is re-read on purpose: its upgrade authority can change it.
    expect(cluster.calls).toEqual([
      'programAccounts',
      `foreignAccount:${await idlAddress(keys.declared.toBase58())}`,
    ])
  })

  it('keeps recovered signatures when a later census rewrites the row', async () => {
    const cluster = await fakeCluster()
    const indexer = createIndexer({ rpc: cluster.rpc, db, programId })
    await indexer.census()
    cluster.setSlot(200)
    await cluster.replace(
      INCIDENT,
      await encode('Incident', fields.incident({ shortfall: new BN(7) })),
    )
    await indexer.census()

    expect(await incidentRow()).toMatchObject({
      shortfall: '7',
      updatedSlot: 200,
      openedSignature: sig('SigOpen'),
      payoutSignature: sig('SigResolve'),
    })
  })

  it('never takes the cache back to an older slot', async () => {
    const cluster = await fakeCluster()
    const indexer = createIndexer({ rpc: cluster.rpc, db, programId })
    cluster.setSlot(200)
    await indexer.census()
    cluster.setSlot(150)
    await cluster.replace(
      INCIDENT,
      await encode('Incident', fields.incident({ shortfall: new BN(7) })),
    )
    await indexer.census()

    expect(await incidentRow()).toMatchObject({ shortfall: '0', updatedSlot: 200 })
  })

  it('records the slot it read at and its cluster time, which the api reports as as_of', async () => {
    const cluster = await fakeCluster()
    await createIndexer({ rpc: cluster.rpc, db, programId }).census()
    expect(await db.select().from(schema.indexerCursor)).toEqual([
      { id: 'census', lastSlot: 100, lastSignature: null, blockTime: CLUSTER_TIME },
    ])
  })
})

describe('live', () => {
  it('writes what a transaction touched, with its signature, before any census', async () => {
    const cluster = await fakeCluster()
    const indexer = createIndexer({ rpc: cluster.rpc, db, programId })
    // The protocol is known already — as it is after the first census.
    await db.insert(schema.protocols).values({
      address: PROTOCOL,
      protocolId: keys.protocolId.toBase58(),
      authority: keys.authority.toBase58(),
      treasury: keys.treasury.toBase58(),
      privileged: [],
      pool: addresses.pool.toBase58(),
      newPoliciesPaused: false,
      nextPolicySeq: '2',
      nextDeclarationSeq: '1',
      incidentCount: '1',
      updatedSlot: 1,
    })

    await indexer.handleSignature(sig('SigAttestA'))

    const [attestation] = await db.select().from(schema.attestations)
    expect(attestation).toMatchObject({
      address: A,
      incident: INCIDENT,
      attestor: keys.attestorA.toBase58(),
      signature: sig('SigAttestA'),
      updatedSlot: 100,
    })
    expect(await incidentRow()).toMatchObject({ protocol: PROTOCOL, triggerSlot: 90 })
    const [protocol] = await db.select().from(schema.protocols)
    expect(protocol?.updatedSlot).toBe(100)
  })

  it('learns protocol_id from register_protocol itself', async () => {
    const cluster = await fakeCluster()
    await createIndexer({ rpc: cluster.rpc, db, programId }).handleSignature(sig('SigRegister'))
    const [protocol] = await db.select().from(schema.protocols)
    expect(protocol?.protocolId).toBe(keys.protocolId.toBase58())
    // Straight from the instruction, not from the account's history.
    expect(cluster.calls).not.toContain(`signatures:${PROTOCOL}`)
  })

  it('records the payout signature and time from resolve', async () => {
    const cluster = await fakeCluster()
    const indexer = createIndexer({ rpc: cluster.rpc, db, programId })
    await indexer.census()
    await db
      .update(schema.incidents)
      .set({ payoutSignature: null, payoutAt: null })
      .where(eq(schema.incidents.address, INCIDENT))

    await indexer.handleSignature(sig('SigResolve'))
    expect(await incidentRow()).toMatchObject({
      payoutSignature: sig('SigResolve'),
      payoutAt: 1_710_000_060,
    })
  })

  it('skips a transaction the node does not return', async () => {
    const cluster = await fakeCluster()
    await createIndexer({ rpc: cluster.rpc, db, programId }).handleSignature(sig('SigUnknown'))
    expect(cluster.calls).toEqual([`transaction:${sig('SigUnknown')}`])
  })
})

describe('start', () => {
  it('subscribes before the census, so nothing falls into the gap between them', async () => {
    const cluster = await fakeCluster()
    const indexer = createIndexer({ rpc: cluster.rpc, db, programId, censusIntervalSeconds: 3600 })
    await indexer.start()
    expect(cluster.calls.slice(0, 2)).toEqual(['subscribe', 'programAccounts'])
    await indexer.stop()
    expect(cluster.subscribed()).toBe(false)
  })

  it('does not fetch a transaction the logs already call failed', async () => {
    const cluster = await fakeCluster()
    const indexer = createIndexer({ rpc: cluster.rpc, db, programId, censusIntervalSeconds: 3600 })
    await indexer.start()
    cluster.calls.length = 0
    cluster.emit(sig('SigFailed'), true)
    cluster.emit(sig('SigAttestA'))
    await indexer.stop()
    expect(cluster.calls).not.toContain(`transaction:${sig('SigFailed')}`)
    expect(cluster.calls).toContain(`transaction:${sig('SigAttestA')}`)
  })
})
