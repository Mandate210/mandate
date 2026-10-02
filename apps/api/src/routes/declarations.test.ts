import { readFileSync } from 'node:fs'
import { BN } from '@coral-xyz/anchor'
import { type Db, schema, upsertNewer } from '@mandate/db'
import { declarationsResponseSchema, errorResponseSchema } from '@mandate/shared'
import { Keypair, PublicKey } from '@solana/web3.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { CLUSTER_TIME, PROTOCOL, fakeCluster } from '../fake-cluster'
import { addresses, encode, fields, keys, programId, submitDeclarationTx } from '../fixtures'
import { idlAddress } from '../idl'
import { createIndexer } from '../indexer'
import { type TestDb, openTestDb } from '../test-db'

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

const declarations = async (protocol = PROTOCOL) =>
  declarationsResponseSchema.parse((await getJson(`/protocols/${protocol}/declarations`)).body)

const ENTRY0 = addresses.declaration0.toBase58()

/** Jupiter's real IDL account, from mainnet (`__fixtures__/idl/`). */
const JUPITER = JSON.parse(
  readFileSync(
    new URL(
      '../__fixtures__/idl/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { programId: string; dataBase64: string }
const JUPITER_IDL = { owner: JUPITER.programId, data: Buffer.from(JUPITER.dataBase64, 'base64') }
/** `route_v2`'s discriminator, as a real Jupiter transaction carried it. */
const ROUTE_V2 = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14]

/** Points the fixture world's entry at Jupiter's `route_v2`. */
const declareJupiter = async (cluster: Awaited<ReturnType<typeof fakeCluster>>) =>
  cluster.replace(
    ENTRY0,
    await encode(
      'DeclarationEntry',
      fields.declaration({
        program_id: new PublicKey(JUPITER.programId),
        ix_discriminator: ROUTE_V2,
      }),
    ),
  )

describe('GET /protocols/:protocol/declarations', () => {
  it('returns every entry as the program stores it, with its state at as_of', async () => {
    await indexed()
    const { status, body } = await getJson(`/protocols/${PROTOCOL}/declarations`)

    expect(status).toBe(200)
    expect(declarationsResponseSchema.parse(body)).toEqual({
      as_of: { slot: 100, unix_ts: CLUSTER_TIME },
      protocol: PROTOCOL,
      entries: [
        {
          address: ENTRY0,
          seq: 0,
          program_id: keys.declared.toBase58(),
          ix_discriminator: 'deadbeef00000001',
          // The fixture's program publishes no IDL: no name, rather than one we made up.
          instruction: null,
          not_before: 1_700_000_000,
          not_after: null,
          moves_funds: true,
          submitted_at: 1_699_999_000,
          effective_at: 1_700_000_000,
          revoked_at: 1_750_000_000,
          // Revocation is still ahead of CLUSTER_TIME.
          state: 'effective',
        },
      ],
    })
  })

  it('moves the state with as_of, not with the wall clock', async () => {
    const { cluster, indexer } = await indexed()
    await cluster.replace(
      ENTRY0,
      await encode(
        'DeclarationEntry',
        fields.declaration({ revoked_at: new BN(CLUSTER_TIME + 2) }),
      ),
    )

    cluster.setSlot(101)
    await indexer.census()
    expect((await declarations()).entries[0]?.state).toBe('effective')

    // Revocation applies from its own second on (FR-032).
    cluster.setSlot(102)
    await indexer.census()
    expect((await declarations()).entries[0]?.state).toBe('revoked')
  })

  it('orders entries by seq as a number', async () => {
    await indexed()
    const [entry] = await db.select().from(schema.declarations)
    if (entry === undefined) throw new Error('the census wrote no declaration')
    const copy = (seq: string) => ({
      ...entry,
      address: Keypair.generate().publicKey.toBase58(),
      seq,
    })
    await upsertNewer(db, schema.declarations, [copy('10'), copy('2')])

    expect((await declarations()).entries.map((e) => e.seq)).toEqual([0, 2, 10])
  })

  it('answers 404 for a protocol the cache does not hold, 400 for a bad address', async () => {
    await indexed()
    const unknown = await getJson(
      `/protocols/${Keypair.generate().publicKey.toBase58()}/declarations`,
    )
    expect(unknown.status).toBe(404)
    expect(errorResponseSchema.parse(unknown.body).error.code).toBe('NOT_FOUND')

    const bad = await getJson(`/protocols/${'z'.repeat(44)}/declarations`)
    expect(bad.status).toBe(400)
    expect(errorResponseSchema.parse(bad.body).error.code).toBe('INVALID_INPUT')
  })
})

describe("instruction names from the declared program's IDL", () => {
  it('names an entry from the real IDL of the program it declares', async () => {
    const { cluster, indexer } = await indexed()
    await declareJupiter(cluster)
    cluster.setForeign(await idlAddress(JUPITER.programId), JUPITER_IDL)
    cluster.setSlot(101)
    const report = await indexer.census()

    expect(report.named).toBe(1)
    expect((await declarations()).entries[0]?.instruction).toEqual({
      name: 'route_v2',
      source: 'anchor-idl',
    })
  })

  it('names a new entry on the live path, without waiting for a census', async () => {
    const { cluster, indexer } = await indexed()
    await declareJupiter(cluster)
    cluster.setForeign(await idlAddress(JUPITER.programId), JUPITER_IDL)
    cluster.addTransaction(
      submitDeclarationTx('SigSubmit', {
        declaredProgram: new PublicKey(JUPITER.programId),
        ixDiscriminator: ROUTE_V2,
      }),
    )
    cluster.setSlot(101)
    await indexer.handleSignature('SigSubmit')

    expect((await declarations()).entries[0]?.instruction?.name).toBe('route_v2')
  })

  it('takes no name from an IDL-shaped account the program does not own', async () => {
    const { cluster, indexer } = await indexed()
    await declareJupiter(cluster)
    cluster.setForeign(await idlAddress(JUPITER.programId), {
      ...JUPITER_IDL,
      owner: Keypair.generate().publicKey.toBase58(),
    })
    cluster.setSlot(101)
    await indexer.census()

    expect((await declarations()).entries[0]?.instruction).toBeNull()
  })

  it('follows the IDL as it is now: a name it no longer gives is cleared', async () => {
    const { cluster, indexer } = await indexed()
    await declareJupiter(cluster)
    const idl = await idlAddress(JUPITER.programId)
    cluster.setForeign(idl, JUPITER_IDL)
    cluster.setSlot(101)
    await indexer.census()
    expect((await declarations()).entries[0]?.instruction?.name).toBe('route_v2')

    cluster.setForeign(idl, null)
    cluster.setSlot(102)
    const report = await indexer.census()
    expect(report.named).toBe(1)
    expect((await declarations()).entries[0]?.instruction).toBeNull()
  })
})
