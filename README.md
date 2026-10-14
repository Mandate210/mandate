# Mandate

Parametric coverage for Solana protocols that pays out automatically when a
protocol's privileged admin access is used without authorization.

## Why

DeFi insurance today covers **bugs in code** — contract exploits, oracle
failures, de-pegs. The largest realized loss of 2026 was none of those. Council
signers were socially engineered, and the transactions carried valid signatures,
prepared ahead of time and executed at a moment of the attacker's choosing. No
audit and no formal verification would have flagged it: the contract did exactly
what legitimate signatures told it to do.

That leaves a gap. Monitoring tools inspect transactions before execution but
carry no financial liability when they miss one. Insurance protocols underwrite a
different event entirely. Nobody compensates the loss.

## How it works

A protocol is covered by a capital pool dedicated to it alone. When a privileged
transaction shows the marks of an unauthorized action, an incident opens and an
independent set of attestors classifies it. Once the quorum agrees, the payout is
released automatically — no claim review, no negotiation, no trust in an insurer.

## Status

**`v0.3.0` — the cover runs as a deployment, not as a demo.** Three attestors and
the API run on a server of their own, and anyone can watch them work: the app and
the landing page read real devnet data, and `/health` says how far each attestor
has looked. A compromise staged as a real transaction is noticed, classified and
paid out by those attestors alone — the vote that completes the quorum carries the
payout in the same instruction. Nobody touches anything in between.

| Measured on devnet | Budget | Result |
|---|---|---|
| Compromise shapes paid out by the deployment's attestors, of ten reproduced | ≥ 9 | **10** |
| False incidents, over 819 real historical privileged transactions | 0 | **0** |
| Offending transaction → money in the treasury, slowest of the ten | ≤ 180s | **4.2s** |
| Confirmation → payout initiated (p95, 20 runs) | ≤ 30s | **10s** |
| Fees to carry one incident | ≤ $1.00 | **$0.006** |

The first and third rows come from one run of `devnet:compromise:hosted` on
2026-10-09, in which the scenario started no workers of its own: it only fired the
transactions, and the three attestors on the server voted. Nine of the payouts landed
between 1.6s and 4.2s after the offending transaction was confirmed. The tenth,
`freeze-user-funds`, was paid in full too, but the run read the treasury's balance
only after firing and so could not time it — the scenario now reads it before. Each
event opened exactly one incident. The p95 and the fees come from `devnet:measure`
on 2026-10-06; at `v0.1.0` they were 12s and $0.008, and the slowest cycle was ~20s.

The control matters as much as the count: a maintenance operation the protocol had
declared in advance is left alone. Without that, "ten of ten" is equally the score
of a system that opens an incident on everything it sees.

**Deployed:** program `HMtvDKR9i4WKxfMfC7fGXXiiReh3APGoNsiCcrbCzMHk` on Solana
[devnet](https://explorer.solana.com/address/HMtvDKR9i4WKxfMfC7fGXXiiReh3APGoNsiCcrbCzMHk?cluster=devnet).
Every number in the table above was measured on it. The `v0.1.0` numbers came from
the previous deployment,
[`DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P`](https://explorer.solana.com/address/DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P?cluster=devnet),
which stays live: its configuration is fixed at creation, so a program with a
changed account layout had to go out under a new address. Every incident, every
attestation and every payout on either is readable by anyone, without asking us
for anything.

**Interface:** [the app](https://mandate210.github.io/mandate/app/) reads devnet
through the public API — every pool, incident, attestation and payout on it is the
chain's. [The landing page](https://mandate210.github.io/mandate/) walks through one
of those incidents, line by line. Both only read: nothing there signs or writes.

**Running:** the API and three attestors run on one VM; each attestor reports how far
it has looked, and [`/health`](https://204-168-183-173.sslip.io/health) goes red when
any of them falls silent (`docs/deploy-hetzner.md`).

## Try it

The scenario stages ten compromises of privileged access as real transactions,
starts real attestor workers, and then only fires the transactions. The watching,
the verdict, the incident, the attestations and the payout are the workers' own
doing — which is the whole claim.

```bash
pnpm --filter @mandate/scenarios devnet:compromise          # against devnet
pnpm --filter @mandate/scenarios devnet:compromise:hosted   # devnet, the deployment's attestors vote
pnpm --filter @mandate/scenarios compromise                 # against a local validator
```

With `:hosted` it starts no workers at all: it waits until every attestor's
`/health` counts the protocols it staged, then fires. It prints an explorer link
for every incident it settles. Running it against
devnet needs a funded key and a deployment of your own — `docs/deploy-devnet.md`
is the runbook, including what a deployment fixes forever and what it costs.

## What is not here yet

Worth knowing before drawing conclusions:

- **The capital in the pool is ours, and so are the policies.** Outside
  underwriters cannot deposit yet.
- **Every attestor is run by us.** The quorum is counted honestly, but while all
  the nodes belong to one party, its independence is arithmetic rather than real.
  Attestors put up no stake yet, so a wrong vote costs them nothing.
- **No mainnet and no external audit.** Neither is close, and both come before
  anything touches real money.
- The two defects real network latency exposed are closed: attestors racing to open
  two incidents on one event (an incident is now addressed by the transaction that
  triggered it, so a second one cannot exist), and incidents whose window expired
  never being closed (attestors now sweep them, releasing the capital they held).

## Layout

```
programs/drain-cover/   Anchor program — the only source of truth
apps/attestor/          worker: watch privileged addresses → compare → attest
apps/web/               the interface — reads the API, never signs
apps/landing/           the landing page — static, no build
apps/cli/               mandate-declare: a covered protocol's declaration entries
packages/shared/        the declaration-matching rule, as a pure function
packages/sdk/           typed program client
scenarios/              ten reproduced compromises, and the devnet measurements
tests/                  integration tests against a live validator

apps/api/               read-only REST + indexer
packages/db/            a cache of chain state, never truth
```

The program is the only source of truth by design: it holds the capital, counts
the quorum and executes the payout. Everything off-chain is a cache or an
observer, and can be rebuilt from the chain — if anything can only be recovered
from Postgres, it is in the wrong place.

Requirements and success criteria are in `docs/SPEC.md`, the architecture and its
risks in `docs/PLAN.md`.

## License

Apache-2.0 — see [`LICENSE`](LICENSE). Copyright 2026 Mandate210.
