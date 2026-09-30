import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq, getTableColumns, getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type Db, upsertNewer } from './index'
import * as schema from './schema'

/**
 * The cache against a real Postgres engine — PGlite, in process, with no socket (the
 * socket variant drops queries under a pipelining client). Decided 2026-09-28: the gate
 * stays «Node only», and the live database is first exercised by the indexer (T048).
 */

const U64_MAX = '18446744073709551615'

let client: PGlite
let db: Db

beforeAll(async () => {
  client = new PGlite()
  const pglite = drizzle(client, { schema })
  await migrate(pglite, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  })
  db = pglite as unknown as Db
})

afterAll(async () => {
  await client.close()
})

const pool = (overrides: Partial<typeof schema.pools.$inferInsert> = {}) => ({
  address: 'Pool1111111111111111111111111111111111111111',
  protocol: 'Prot1111111111111111111111111111111111111111',
  vault: 'Vaul1111111111111111111111111111111111111111',
  totalAssets: '1000',
  totalShares: '1000',
  lockedLimit: '0',
  openIncidents: 0,
  updatedSlot: 10,
  ...overrides,
})

const stored = async (address: string) =>
  (await db.select().from(schema.pools).where(eq(schema.pools.address, address)))[0]

describe('migration', () => {
  /**
   * The drift guard: `schema.ts` edited without `drizzle-kit generate` still
   * typechecks and still builds queries — against columns the migrated database does
   * not have. Every column the schema declares must exist after migrating.
   */
  it('creates every column the schema declares, with the same nullability', async () => {
    const tables = Object.values(schema).filter((value) => is(value, PgTable))
    expect(tables.length).toBe(8)

    for (const table of tables) {
      const name = getTableName(table)
      const { rows } = await client.query<{ column_name: string; is_nullable: string }>(
        'select column_name, is_nullable from information_schema.columns where table_name = $1',
        [name],
      )
      const actual = new Map(rows.map((row) => [row.column_name, row.is_nullable === 'YES']))
      for (const column of Object.values(getTableColumns(table))) {
        expect(actual.has(column.name), `${name}.${column.name}`).toBe(true)
        expect(actual.get(column.name), `${name}.${column.name} nullable`).toBe(!column.notNull)
      }
      expect(actual.size, `${name} has columns the schema does not`).toBe(
        Object.keys(getTableColumns(table)).length,
      )
    }
  })

  it('has no foreign keys — the indexer writes in whatever order it hears', async () => {
    const { rows } = await client.query(
      "select 1 from information_schema.table_constraints where constraint_type = 'FOREIGN KEY'",
    )
    expect(rows).toHaveLength(0)
  })
})

describe('u64 columns', () => {
  beforeEach(async () => {
    await db.delete(schema.pools)
  })

  it('hold the whole u64 range exactly, as decimal strings', async () => {
    // Above 2^63, where a Postgres `bigint` would already have overflowed.
    const above = (2n ** 63n + 1n).toString()
    await upsertNewer(db, schema.pools, [pool({ totalAssets: U64_MAX, totalShares: above })])
    const row = await stored(pool().address)
    expect(row?.totalAssets).toBe(U64_MAX)
    expect(row?.totalShares).toBe(above)
  })

  it('refuses one past u64 rather than rounding it', async () => {
    await expect(
      upsertNewer(db, schema.pools, [pool({ totalAssets: '184467440737095516150' })]),
    ).rejects.toThrow()
  })
})

describe('upsertNewer', () => {
  beforeEach(async () => {
    await db.delete(schema.pools)
    await upsertNewer(db, schema.pools, [pool({ updatedSlot: 10, totalAssets: '1000' })])
  })

  it('never moves a row back to an older slot', async () => {
    await upsertNewer(db, schema.pools, [pool({ updatedSlot: 9, totalAssets: '1' })])
    expect((await stored(pool().address))?.totalAssets).toBe('1000')
    expect((await stored(pool().address))?.updatedSlot).toBe(10)
  })

  it('takes a later slot, every column but the key', async () => {
    await upsertNewer(db, schema.pools, [
      pool({ updatedSlot: 11, totalAssets: '2000', lockedLimit: '500', openIncidents: 1 }),
    ])
    const row = await stored(pool().address)
    expect(row).toMatchObject({
      updatedSlot: 11,
      totalAssets: '2000',
      lockedLimit: '500',
      openIncidents: 1,
    })
  })

  it('lets the same slot through, so a replay is a no-op rather than an error', async () => {
    await upsertNewer(db, schema.pools, [pool({ updatedSlot: 10, totalAssets: '1000' })])
    expect((await stored(pool().address))?.totalAssets).toBe('1000')
  })

  it('stores a pool whose protocol is not indexed yet', async () => {
    const orphan = pool({
      address: 'Pool2222222222222222222222222222222222222222',
      protocol: 'NotYet',
    })
    await upsertNewer(db, schema.pools, [orphan])
    expect(await stored(orphan.address)).toBeDefined()
  })

  it('does nothing for an empty batch', async () => {
    await upsertNewer(db, schema.pools, [])
    expect(await db.select().from(schema.pools)).toHaveLength(1)
  })
})

describe('upsertNewer — columns a census cannot see', () => {
  const attestation = (overrides: Partial<typeof schema.attestations.$inferInsert> = {}) => ({
    address: 'Atte1111111111111111111111111111111111111111',
    incident: 'Inci1111111111111111111111111111111111111111',
    attestor: 'Auth1111111111111111111111111111111111111111',
    verdict: 'unauthorized' as const,
    submittedAt: 1_700_000_000,
    signature: null,
    updatedSlot: 10,
    ...overrides,
  })
  const read = async () =>
    (
      await db
        .select()
        .from(schema.attestations)
        .where(eq(schema.attestations.address, attestation().address))
    )[0]

  beforeEach(async () => {
    await db.delete(schema.attestations)
    await upsertNewer(db, schema.attestations, [attestation({ signature: 'Sig1' })])
  })

  it('keeps a stored signature when a later census row carries none', async () => {
    await upsertNewer(db, schema.attestations, [attestation({ updatedSlot: 11 })], {
      keep: [schema.attestations.signature],
    })
    expect(await read()).toMatchObject({ updatedSlot: 11, signature: 'Sig1' })
  })

  it('still writes a signature that arrives where there was none', async () => {
    await db.delete(schema.attestations)
    await upsertNewer(db, schema.attestations, [attestation()])
    await upsertNewer(db, schema.attestations, [attestation({ signature: 'Sig2' })], {
      keep: [schema.attestations.signature],
    })
    expect((await read())?.signature).toBe('Sig2')
  })

  it('erases it without `keep` — which is why state columns stay out of it', async () => {
    await upsertNewer(db, schema.attestations, [attestation({ updatedSlot: 11 })])
    expect((await read())?.signature).toBeNull()
  })
})
