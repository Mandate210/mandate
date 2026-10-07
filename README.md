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

**`v0.1.0` — the cycle closes on devnet, unattended.** A compromise is staged as a
real transaction, workers notice it, classify it, reach a quorum and the payout
lands in the protocol's treasury. Nobody touches anything in between.

| Measured on devnet | Budget | Result |
|---|---|---|
| Compromise shapes recognised, of ten reproduced | ≥ 9 | **10** |
| False incidents, over 819 real historical privileged transactions | 0 | **0** |
| Offending transaction → money in the treasury | ≤ 180s | **~20s** |
| Confirmation → payout initiated (p95) | ≤ 30s | **12s** |
| Fees to carry one incident | ≤ $1.00 | **$0.008** |

The control matters as much as the count: a maintenance operation the protocol had
declared in advance is left alone. Without that, "ten of ten" is equally the score
of a system that opens an incident on everything it sees.

**Deployed:** program `HMtvDKR9i4WKxfMfC7fGXXiiReh3APGoNsiCcrbCzMHk` on Solana
[devnet](https://explorer.solana.com/address/HMtvDKR9i4WKxfMfC7fGXXiiReh3APGoNsiCcrbCzMHk?cluster=devnet).
The numbers above were first measured on the previous deployment,
[`DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P`](https://explorer.solana.com/address/DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P?cluster=devnet),
which stays live: its configuration is fixed at creation, so a program with a
changed account layout had to go out under a new address. The same two runs,
repeated on the current program on 2026-09-30, gave ten of ten recognised, the
slowest full cycle at 15.8s, p95 at 12s and $0.008 in fees. Every incident, every
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
pnpm --filter @mandate/scenarios devnet:compromise    # against devnet
pnpm --filter @mandate/scenarios compromise           # against a local validator
```

It prints an explorer link for every incident it settles. Running it against
devnet needs a funded key and a deployment of your own — `docs/deploy-devnet.md`
is the runbook, including what a deployment fixes forever and what it costs.

## What is not here yet

Worth knowing before drawing conclusions:

- **The capital in the pool is ours, and so are the policies.** Outside
  underwriters cannot deposit yet.
- **Every attestor is run by us.** The quorum is counted honestly, but while all
  the nodes belong to one party, its independence is arithmetic rather than real.
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
