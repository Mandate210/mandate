# drain-cover

Parametric cover for Solana protocols: pays out automatically when a protocol's
privileged admin access is used without authorization. Anchor program holds the
capital; independent attestors decide; payout is immediate and irreversible.

Read `docs/SPEC.md` before changing behaviour, `docs/PLAN.md` before changing
structure, `docs/TASKS.md` for what is next, `docs/SCRATCHPAD.md` for where the
last session stopped.

## Stack

pnpm 9 workspace + Turborepo · TypeScript 5 strict · Biome · Vitest · Hono ·
Drizzle + Postgres · React 18 + Vite 5 · Anchor 0.30 / Solana 1.18 (Rust).

```
programs/drain-cover/   Anchor program — the only source of truth
apps/api/               Hono read-only REST + indexer subscription
apps/attestor/          worker: watch privileged addrs → compare → attest
apps/web/               public status page, read-only
packages/shared/        Zod schemas + declaration-matching rule (pure)
packages/sdk/           typed program client + generated IDL
packages/db/            Drizzle schema — a cache of chain state, never truth
tests/                  Anchor integration tests (Vitest)
```
## Commands

```bash
pnpm gate        # lint + typecheck + test — must be green before every commit
pnpm dev         # all apps
pnpm lint:fix    # biome check --write
anchor build     # regenerates the IDL that packages/sdk depends on
anchor test      # runs tests/ against solana-test-validator
```

## Hard rules

- **No `any`.** Enforced by Biome, not by agreement. Use `unknown` + a guard.
- **Zod on every API boundary.** Schemas live in `packages/shared`, shared via `z.infer`.
- **Business logic as pure functions.** Especially declaration matching: every
  attestor must reach the same verdict from the same chain state.
- **TDD for the program and for matching.** Fixtures from real transactions.
- **The database is disposable.** If anything can only be recovered from Postgres,
  it is in the wrong place — it belongs on-chain.
- **No price oracles anywhere.** One dollar-denominated asset only (FR-014).
- **No auth, no sessions, no wallet adapter in `web`.** Every action is a signed
  transaction made outside the app (FR-034).
- Conventional commits, one task from `docs/TASKS.md` per commit, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Client repo: commits are authored as the client, never as the contractor.
  `.arena.json` stays out of the index. Before any push, check that no personal
  path, email or name leaked (`docs/PLAN.md` → Безпека).

## Known blockers

- Rust / Solana CLI / Anchor are **not installed** — `programs/` cannot build and
  the `program` CI job will fail until they are (`docs/PLAN.md` → C-6).
- `declare_id!` still holds the Anchor template placeholder. Run `anchor keys sync`
  before the first deploy; `tests/config-consistency.test.ts` guards the three
  places it is duplicated.
