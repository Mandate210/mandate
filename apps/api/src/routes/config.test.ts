import { schema } from '@mandate/db'
import { configResponseSchema, errorResponseSchema } from '@mandate/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { CLUSTER_TIME, fakeCluster } from '../fake-cluster'
import { keys, programId } from '../fixtures'
import { createIndexer } from '../indexer'
import { type TestDb, openTestDb } from '../test-db'

let testDb: TestDb

beforeAll(async () => {
  testDb = await openTestDb()
})

afterAll(async () => {
  await testDb.close()
})

beforeEach(async () => {
  await testDb.clear()
})

const getJson = async (path: string) => {
  const response = await createApp({ db: testDb.db, tip: async () => 100 }).request(path)
  return { status: response.status, body: (await response.json()) as unknown }
}

const indexed = async () => {
  const cluster = await fakeCluster()
  await createIndexer({ rpc: cluster.rpc, db: testDb.db, programId }).census()
  return cluster
}

describe('GET /config', () => {
  it('serves nothing before the first census', async () => {
    const { status, body } = await getJson('/config')
    expect(status).toBe(503)
    expect(errorResponseSchema.parse(body).error.code).toBe('INTERNAL')
  })

  it('is the singleton one to one, with the mint’s decimals and the moment it was read', async () => {
    await indexed()
    const { status, body } = await getJson('/config')

    expect(status).toBe(200)
    expect(configResponseSchema.parse(body)).toEqual({
      as_of: { slot: 100, unix_ts: CLUSTER_TIME },
      program_id: programId.toBase58(),
      admin: keys.admin.toBase58(),
      asset_mint: keys.mint.toBase58(),
      asset_decimals: 6,
      declaration_delay: 30,
      attest_window: 90,
      withdraw_delay: 300,
      quorum_bps: 6000,
      attestor_count: 2,
      open_bond: '1000000',
      paused: false,
    })
  })

  it('sends the bond as a string, so a u64 survives JSON', async () => {
    await indexed()
    await testDb.db.update(schema.config).set({ openBond: '18446744073709551615' })
    const config = configResponseSchema.parse((await getJson('/config')).body)
    expect(config.open_bond).toBe('18446744073709551615')
  })
})
