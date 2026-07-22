// Drizzle schema and connection factory.
//
// This database is a cache of on-chain state, never a source of truth: it can be
// dropped and rebuilt from the chain. Every row carries `updated_slot` so that
// an indexer restart is idempotent and never rolls state backwards
// (docs/PLAN.md → "Модель даних").
export {}
