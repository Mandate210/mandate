import { defineConfig } from 'drizzle-kit'

// Migrations go through Supabase's *session* pooler (port 5432): DDL needs a session,
// and the transaction pooler the runtime uses (6543, `DATABASE_URL`) drops prepared
// statements between transactions. `generate` reads no database, so the URL is only
// needed by `migrate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL ?? '' },
})
