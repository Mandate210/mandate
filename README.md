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

**Deployed:** program `DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P` on Solana
[devnet](https://explorer.solana.com/address/DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P?cluster=devnet).
Every incident, every attestation and every payout is readable there by anyone,
without asking us for anything.

**Interface:** [a demo of the flow](https://mandate210.github.io/mandate/),
running on mock data — the protocols, the incident and the amounts in it are
invented, and every page says so above the header.

## Try it

The scenario stages ten compromises of privileged access as real transactions,
starts real attestor workers, and then only fires the transactions. The watching,
the verdict, the incident, the attestations and the payout are the workers' own
doing — which is the whole claim.

```bash
pnpm --filter @drain-cover/scenarios devnet:compromise    # against devnet
pnpm --filter @drain-cover/scenarios compromise           # against a local validator
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
- Two defects that only appear under real network latency are open and block the
  next milestone — `docs/TASKS.md` → T070, T071.

## Layout

```
programs/drain-cover/   Anchor program — the only source of truth
apps/attestor/          worker: watch privileged addresses → compare → attest
apps/web/               the interface, on mock data for now
packages/shared/        the declaration-matching rule, as a pure function
packages/sdk/           typed program client
scenarios/              ten reproduced compromises, and the devnet measurements
tests/                  integration tests against a live validator

apps/api/               placeholder — read-only REST + indexer, not built yet
packages/db/            placeholder — a cache of chain state, never truth
```

The program is the only source of truth by design: it holds the capital, counts
the quorum and executes the payout. Everything off-chain is a cache or an
observer, and can be rebuilt from the chain — if anything can only be recovered
from Postgres, it is in the wrong place.

Requirements and success criteria are in `docs/SPEC.md`, the architecture and its
risks in `docs/PLAN.md`, and the work itself in `docs/TASKS.md`.
