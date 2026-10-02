import { BN } from '@coral-xyz/anchor'
import { type Db, schema, upsertNewer } from '@mandate/db'
import {
  errorResponseSchema,
  healthResponseSchema,
  poolsResponseSchema,
  protocolDetailResponseSchema,
} from '@mandate/shared'
import { Keypair } from '@solana/web3.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { CLUSTER_TIME, PROTOCOL, fakeCluster } from '../fake-cluster'
import { addresses, encode, fields, keys, programId } from '../fixtures'
import { createIndexer } from '../indexer'
import { type TestDb, openTestDb } from '../test-db'
import { MAX_LAG_SLOTS } from './health'

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

/** The api over the test database, with a cluster tip the test sets. */
const api = (tip: () => Promise<number> = async () => 100) => createApp({ db, tip })

/** The fixture world, indexed by the real indexer at slot 100 — as the cache holds it. */
const indexed = async () => {
  const cluster = await fakeCluster()
  const indexer = createIndexer({ rpc: cluster.rpc, db, programId })
  await indexer.census()
  return { cluster, indexer }
}

const getJson = async (path: string, tip?: () => Promise<number>) => {
  const response = await api(tip).request(path)
  return { status: response.status, body: (await response.json()) as unknown }
}

const POLICY0 = addresses.policy0.toBase58()
const POLICY1 = addresses.policy1.toBase58()
const OTHER_PROTOCOL = Keypair.generate().publicKey.toBase58()

describe('before the first census', () => {
  it('serves no state, since there is no moment to report', async () => {
    for (const path of ['/pools', `/pools/${PROTOCOL}`]) {
      const { status, body } = await getJson(path)
      expect(status).toBe(503)
      expect(errorResponseSchema.parse(body).error.code).toBe('INTERNAL')
    }
  })

  it('reports itself unhealthy, with the whole chain as its lag', async () => {
    const { status, body } = await getJson('/health', async () => 500)
    expect(status).toBe(503)
    expect(healthResponseSchema.parse(body)).toEqual({ ok: false, slot: 0, lag_slots: 500 })
  })
})

describe('GET /pools', () => {
  it('reports every pool at the moment the indexer read the chain', async () => {
    await indexed()
    const { status, body } = await getJson('/pools')

    expect(status).toBe(200)
    const pools = poolsResponseSchema.parse(body)
    expect(pools.as_of).toEqual({ slot: 100, unix_ts: CLUSTER_TIME })
    expect(pools.pools).toEqual([
      {
        protocol: PROTOCOL,
        pool: addresses.pool.toBase58(),
        // u64::MAX, exact: a JSON number would have rounded it.
        total_assets: '18446744073709551615',
        total_shares: '1000',
        locked_limit: '500',
        utilization_bps: 0,
        open_incidents: 0,
        // The pending policy is inside its period and paid for: in force all the same.
        policies_in_force: 2,
      },
    ])
  })

  it('takes as_of from the later of the census and the last followed transaction', async () => {
    const { cluster, indexer } = await indexed()
    cluster.setSlot(105)
    await indexer.handleSignature('SigOpen')

    const pools = poolsResponseSchema.parse((await getJson('/pools')).body)
    expect(pools.as_of).toEqual({ slot: 105, unix_ts: CLUSTER_TIME + 5 })
  })

  it('computes in_force at as_of, with the end second excluded', async () => {
    const { cluster, indexer } = await indexed()
    await cluster.replace(
      POLICY0,
      await encode('Policy', fields.policy({ end_ts: new BN(CLUSTER_TIME + 3) })),
    )

    // Both the count and the policy's own flag, read at as_of — not at the wall clock,
    // which has long passed the fixture world's CLUSTER_TIME.
    const inForce = async () => {
      const pools = poolsResponseSchema.parse((await getJson('/pools')).body)
      const detail = protocolDetailResponseSchema.parse((await getJson(`/pools/${PROTOCOL}`)).body)
      return {
        count: pools.pools[0]?.policies_in_force,
        policy0: detail.policies.find((policy) => policy.address === POLICY0)?.in_force,
      }
    }

    cluster.setSlot(102)
    await indexer.census()
    expect(await inForce()).toEqual({ count: 2, policy0: true })

    cluster.setSlot(103)
    await indexer.census()
    expect(await inForce()).toEqual({ count: 1, policy0: false })
  })

  it("counts only the pool's own protocol's policies", async () => {
    await indexed()
    const [policy] = await db.select().from(schema.policies).limit(1)
    if (policy === undefined) throw new Error('the census wrote no policy')
    await upsertNewer(db, schema.policies, [
      { ...policy, address: Keypair.generate().publicKey.toBase58(), protocol: OTHER_PROTOCOL },
    ])

    const pools = poolsResponseSchema.parse((await getJson('/pools')).body)
    expect(pools.pools.map((pool) => pool.policies_in_force)).toEqual([2])
    const detail = protocolDetailResponseSchema.parse((await getJson(`/pools/${PROTOCOL}`)).body)
    expect(detail.pool.policies_in_force).toBe(2)
    expect(detail.policies).toHaveLength(2)
  })

  it('ignores a cursor whose slot the node could not date', async () => {
    await indexed()
    await db.insert(schema.indexerCursor).values({ id: 'live', lastSlot: 900, blockTime: null })

    const pools = poolsResponseSchema.parse((await getJson('/pools')).body)
    expect(pools.as_of.slot).toBe(100)
  })
})

describe('GET /pools/:protocol', () => {
  it('returns the protocol, its pool, the policies holding a reservation and its incidents', async () => {
    await indexed()
    const { status, body } = await getJson(`/pools/${PROTOCOL}`)

    expect(status).toBe(200)
    const detail = protocolDetailResponseSchema.parse(body)
    expect(detail.as_of).toEqual({ slot: 100, unix_ts: CLUSTER_TIME })
    expect(detail.protocol).toEqual({
      address: PROTOCOL,
      protocol_id: keys.protocolId.toBase58(),
      authority: keys.authority.toBase58(),
      treasury: keys.treasury.toBase58(),
      privileged: [keys.privileged.toBase58()],
      new_policies_paused: false,
      incident_count: 1,
    })
    expect(detail.pool.policies_in_force).toBe(2)
    expect(detail.policies.map((policy) => [policy.address, policy.seq, policy.status])).toEqual([
      [POLICY0, 0, 'active'],
      [POLICY1, 1, 'pending'],
    ])
    expect(detail.policies[0]).toMatchObject({
      limit: '10000',
      retention: '500',
      remaining_limit: '500',
      // Everything left is retention: nothing a claim could still take.
      payable: '0',
      in_force: true,
    })
    expect(detail.recent_incidents).toEqual([
      expect.objectContaining({
        address: addresses.incident.toBase58(),
        policy: POLICY0,
        set_size: 2,
        // ceil(2 × 6 000 / 10 000): 1.2 attestations is two, as resolve counts it.
        quorum_needed: 2,
        votes_unauthorized: 2,
        status: 'paid_out',
        payout: '9500',
      }),
    ])
  })

  it('lists an exhausted policy nowhere and counts it as not in force', async () => {
    const { cluster, indexer } = await indexed()
    await cluster.replace(
      POLICY0,
      await encode('Policy', fields.policy({ status: { Exhausted: {} } })),
    )
    cluster.setSlot(101)
    await indexer.census()

    const detail = protocolDetailResponseSchema.parse((await getJson(`/pools/${PROTOCOL}`)).body)
    expect(detail.policies.map((policy) => policy.address)).toEqual([POLICY1])
    expect(detail.pool.policies_in_force).toBe(1)
  })

  it('answers 404 for an address the cache does not hold', async () => {
    await indexed()
    const unknown = Keypair.generate().publicKey.toBase58()
    const { status, body } = await getJson(`/pools/${unknown}`)

    expect(status).toBe(404)
    expect(errorResponseSchema.parse(body).error).toMatchObject({
      code: 'NOT_FOUND',
      details: { address: unknown },
    })
  })

  it('answers 400 for what is not a 32-byte address', async () => {
    await indexed()
    // Base58 of the right length that decodes to more than 32 bytes, and plain garbage.
    for (const bad of ['z'.repeat(44), 'not-an-address']) {
      const { status, body } = await getJson(`/pools/${bad}`)
      expect(status).toBe(400)
      expect(errorResponseSchema.parse(body).error.code).toBe('INVALID_INPUT')
    }
  })
})

describe('GET /health', () => {
  it('is ok while the lag stays within one and a half census intervals', async () => {
    await indexed()
    const { status, body } = await getJson('/health', async () => 100 + MAX_LAG_SLOTS)

    expect(status).toBe(200)
    expect(healthResponseSchema.parse(body)).toEqual({
      ok: true,
      slot: 100,
      lag_slots: MAX_LAG_SLOTS,
    })
  })

  it('turns 503 one slot past it, so a monitor reading only the status sees it', async () => {
    await indexed()
    const { status, body } = await getJson('/health', async () => 101 + MAX_LAG_SLOTS)

    expect(status).toBe(503)
    expect(healthResponseSchema.parse(body)).toMatchObject({
      ok: false,
      lag_slots: MAX_LAG_SLOTS + 1,
    })
  })

  it('never reports a lead over the cluster as negative lag', async () => {
    await indexed()
    const { body } = await getJson('/health', async () => 90)
    expect(healthResponseSchema.parse(body)).toEqual({ ok: true, slot: 100, lag_slots: 0 })
  })

  it('answers 503 in the error format when the tip cannot be read', async () => {
    await indexed()
    const { status, body } = await getJson('/health', async () => {
      throw new Error('429')
    })
    expect(status).toBe(503)
    expect(errorResponseSchema.parse(body).error.code).toBe('INTERNAL')
  })
})

it('answers an unknown path in the error format', async () => {
  const { status, body } = await getJson('/nowhere')
  expect(status).toBe(404)
  expect(errorResponseSchema.parse(body).error.code).toBe('NOT_FOUND')
})
