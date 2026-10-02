// An in-process Postgres with the real migrations, for tests that need a database.
// PGlite, not a socket: the gate stays «Node only» (docs/PLAN.md → «Postgres — кеш»).

import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { type Db, schema } from '@mandate/db'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

export type TestDb = { db: Db; clear: () => Promise<void>; close: () => Promise<void> }

export const openTestDb = async (): Promise<TestDb> => {
  const client = new PGlite()
  const pglite = drizzle(client, { schema })
  await migrate(pglite, {
    migrationsFolder: fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
  })
  const db = pglite as unknown as Db
  return {
    db,
    clear: async () => {
      for (const table of [
        schema.config,
        schema.protocols,
        schema.pools,
        schema.policies,
        schema.declarations,
        schema.incidents,
        schema.attestations,
        schema.indexerCursor,
      ]) {
        await db.delete(table)
      }
    },
    close: () => client.close(),
  }
}
