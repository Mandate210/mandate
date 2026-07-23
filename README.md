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

Early development. The product specification is being written and is not part of
this repository yet.
