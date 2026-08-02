# drain-cover

Parametric cover for Solana protocols: pays out automatically when a protocol's
privileged admin access is used without authorization. Anchor program holds the
capital; independent attestors decide; payout is immediate and irreversible.

Read `docs/SPEC.md` before changing behaviour, `docs/PLAN.md` before changing
structure, `docs/TASKS.md` for what is next, `docs/SCRATCHPAD.md` for where the
last session stopped.

## Stack

pnpm 9 workspace + Turborepo · TypeScript 5 strict · Biome · Vitest · Hono ·
Drizzle + Postgres · React 18 + Vite 5 · Anchor 0.32.1 / Agave 4.2.0 / Rust 1.97
(exact versions in `docs/PLAN.md`; the Anchor TS client tops out at 0.32.1, which
is why the CLI is pinned there and not at 1.x).

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
anchor deploy    # deploys to whatever cluster Anchor.toml points at
```

**`anchor build` alone produces a program that will not deploy.** `cargo-build-sbf`
defaults to `--arch v0`, and every cluster with current features active refuses v0
execution. Build the deployable artifact in two steps, in this order — the second
overwrites the `.so` the first wrote:

```bash
anchor build                                                      # IDL
cargo build-sbf --manifest-path programs/drain-cover/Cargo.toml --arch v3
```

Both `anchor` commands run inside WSL — see «Toolchain» below.

**Two test suites, on purpose.** `*.test.ts` needs nothing but Node and belongs to
`pnpm gate`; `*.itest.ts` needs a running validator and is excluded from the default
`vitest run`. Keep the gate green on a machine with no Rust and no validator — that
is what the CI `typescript` job is. Integration tests build their world through
`tests/harness.ts`, which refuses any RPC endpoint that is not loopback.

**`anchor test` is not usable here** and is wired to fail with an explanation.
Anchor runs its scripts inside WSL, which has no node. Three steps instead:

```bash
wsl -e bash -lc "solana-test-validator --reset"             # WSL, keep running
wsl -e bash -lc "cd <repo in WSL> && anchor deploy"         # WSL
pnpm --filter @drain-cover/tests test:integration           # Windows
```

`--reset` is not optional. `Config` is a singleton PDA and other accounts key off
constant seeds, so the suite cannot recreate what a previous run already created.
Re-run against a used ledger and the tests fail on "account already in use" — the
suites say so explicitly rather than letting you debug the wrong thing.

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

## Toolchain

The on-chain toolchain lives in **WSL** (Ubuntu 24.04): Rust, Agave CLI, Anchor,
`solana-test-validator`. Everything else — git, pnpm, TS tests — runs on Windows.
Build from Windows with `wsl -e bash -lc "cd <repo path in WSL> && anchor build"`.

**Never commit from WSL.** Hooks and per-directory identity are configured with
Windows paths, so a commit made there skips the identity, secret and repo-owner
checks entirely (`docs/PLAN.md` → «Тулчейн: розподіл між WSL і Windows»).

`anchor build` from the mounted Windows drive takes minutes — that is the 9p
filesystem, not a broken setup.

## Watch out

- **The program keypair exists only in `target/deploy/`, which is gitignored.**
  Wiping `target` makes `anchor keys sync` mint a different address and orphans
  anything already deployed. Back it up before the first deploy.
- `anchor keys sync` rewrites only the cluster configured in `Anchor.toml`; the
  other one is updated by hand. `tests/config-consistency.test.ts` guards all
  three places the id is duplicated.
