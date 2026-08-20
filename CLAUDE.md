# Mandate

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

**After every program change, sync the IDL into the SDK:**

```bash
pnpm --filter @mandate/sdk sync:idl
```

`target/` is gitignored, so `packages/sdk/src/idl/` holds a committed copy — that is
what lets the CI `typescript` job typecheck without Rust. A drift guard compares the
two whenever `target/` exists, so a forgotten sync fails locally rather than shipping
a client built against an older program.

Both `anchor` commands run inside WSL — see «Toolchain» below.

**Two test suites, on purpose.** `*.test.ts` needs nothing but Node and belongs to
`pnpm gate`; `*.itest.ts` needs a running validator and is excluded from the default
`vitest run`. Keep the gate green on a machine with no Rust and no validator — that
is what the CI `typescript` job is. Integration tests build their world through
`tests/harness.ts`, which refuses any RPC endpoint that is not loopback.

**`anchor test` is not usable here** and is wired to fail with an explanation.
Anchor runs its scripts inside WSL, which has no node. Three steps instead:

```bash
wsl -e bash -lc "solana-test-validator --reset --slots-per-epoch 32"   # WSL, keep running
wsl -e bash -lc "cd <repo in WSL> && anchor deploy"         # WSL
pnpm --filter @mandate/tests test:integration           # Windows
```

**The end-to-end scenario is a fourth step, and it needs its own ledger:**

```bash
pnpm --filter @mandate/scenarios compromise     # Windows, after --reset + deploy
```

It stages ten compromises as real transactions, starts real attestor workers and
measures SC-003 and SC-005. It runs with a **30-second declaration delay** where the
integration suite uses 24 hours — three of its scenarios and its control turn on an
entry being in force, and none of them is reachable in a three-minute run otherwise.
`Config` fixes that delay forever at creation, so the scenario and the integration
suite cannot share a ledger: reset between them. The scenario says so rather than
failing on a confusing timing assertion.

`--reset` is not optional. `Config` is a singleton PDA, and the admin and settlement
mint are fixed inside it forever, so a ledger carrying a config from an earlier run
puts the suite in a state it cannot reproduce. Its attestation window is one of those
fixed values, and the tests set it to 90 seconds (`tests/world.ts`) because
`close_expired_incident` can only act once a deadline has passed and no RPC moves the
cluster clock — a ledger whose config predates that value makes
`close_expired_incident.itest.ts` fail in `beforeAll` and say so.

**`--slots-per-epoch 32` is not optional either.** An attestor admitted in one epoch
votes from the next (FR-008), and the default epoch is 432 000 slots — about two days —
so on a default validator no attestor ever becomes active and nothing can be attested,
resolved or paid out. At 32 slots an epoch passes in roughly thirteen seconds, which is
what `waitForNextEpoch` in `tests/harness.ts` waits for.

Two conventions keep the integration files independent of each other, and both are
easy to undo by accident:

- **The admin and the asset mint come from constant seeds** (`tests/harness.ts`).
  Whichever file runs first creates them; the rest find the same addresses. Generate
  a keypair per file instead and only the first file to run has admin rights or the
  mint that `Config` recorded — and Vitest promises nothing about file order.
- **Shared starting state goes through `tests/world.ts`** (`ensureConfig`), never
  through "the other file already did it".

`it.skipIf(cond)` evaluates `cond` when the test is collected, before `beforeAll`
runs — a flag assigned in `beforeAll` is still `undefined` there, and every test
silently skips. Compute such conditions at module level with top-level `await`.

**Never use `PublicKey.unique()` in an integration test.** It is a per-process
counter, and each test file gets its own module registry — so two files hand out the
same addresses and collide on a shared ledger ("account already in use"). Use
`Keypair.generate().publicKey`. In unit tests, where nothing is written to a chain, the
counter is fine.

**Accounts constrained by `address = …` have to be passed explicitly.** A pool's vault
is not derived from our seeds, so Anchor's client cannot resolve it and fails with
"Account `vault` not provided". `findVault` in the SDK derives it.

**Compute expected balances from chain state, not by hand.** Premiums become pool
capital, so free capital is not "funded minus locked" — a test doing that arithmetic
inline passed while asserting nothing.

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
  anything already deployed. A backup lives outside the repo — restore it into
  `target/deploy/` **before** deploying, never after (`docs/deploy-devnet.md` → Ключі).
- `anchor keys sync` rewrites only the cluster configured in `Anchor.toml`; the
  other one is updated by hand. `tests/config-consistency.test.ts` guards all
  three places the id is duplicated.
