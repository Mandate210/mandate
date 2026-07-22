Build a read-only demo web app. Frontend only — no smart contracts, no wallet
connection, no backend, no database. All data is mock data hardcoded in the app.

## What the product is

Parametric cover for Solana protocols against unauthorized use of their
privileged admin access.

A covered protocol declares in advance which privileged admin operations are
routine for it. When a privileged transaction does not match any effective
declaration entry, an incident opens. Independent attestors vote on it. As soon
as a quorum votes "unauthorized", the payout is released automatically in the
same transaction — no claim review, no negotiation, no veto.

## Look and feel

Dark theme. Dense financial / security dashboard, closer to a trading terminal
than to a landing page. No illustrations, no hero section, no marketing copy.
Monospace font for addresses, amounts and transaction signatures. Calm neutral
palette with one accent colour reserved for alerts and the payout moment.

## Screen 1 — Pools list (route `/`)

A table, one row per covered protocol:

| Protocol | Pool capital | Active coverage | Utilization | Attestors | Status |
| --- | --- | --- | --- | --- | --- |
| Meridian Perps | 4,200,000 USDC | 3,000,000 USDC | 71% | 7 | Active policy |
| Solstice Lend | 1,150,000 USDC | 750,000 USDC | 65% | 7 | Active policy |
| Kestrel Vaults | 380,000 USDC | 0 USDC | 0% | 7 | No policy |

Utilization is a progress bar. Above 80% it turns to the warning colour with the
tooltip "Pool nearly exhausted — no new policies accepted".

Clicking a row opens screen 2.

## Screen 2 — Protocol detail (route `/protocol/:id`)

Three blocks. Data below is for Meridian Perps; invent consistent values for the
other two.

**Coverage**
- Policy limit: 3,000,000 USDC
- Protocol retention: 20% (600,000 USDC)
- Payable on incident: **2,400,000 USDC**
- Term: until 2026-12-31
- Beneficiary: protocol treasury `MerdN…8kQ2`

**Declaration of allowed operations**

| Operation | Window | Submitted | Effective from | Status |
| --- | --- | --- | --- | --- |
| Update funding rate params | Tue 02:00–04:00 UTC | 2026-07-14 | 2026-07-16 | Effective |
| Add collateral market | one-off 2026-08-02 | 2026-07-30 | 2026-08-01 | Spent |
| Rotate oracle authority | Thu 01:00–03:00 UTC | 2026-08-08 | 2026-08-10 | Pending |

Caption under the table: "Widening the declaration takes effect after a delay.
Narrowing or revoking it takes effect immediately."

**Privileged addresses** — 5 Security Council signers, shown truncated.

## Screen 3 — Incident timeline (route `/incident/:id`)

This is the main screen of the demo. A vertical timeline where events appear one
after another with a short animation. A large elapsed-time counter at the top,
counting from the trigger transaction.

```
T+0s   Privileged transaction   5xK2…9fPq
       signer 3 of 5 · durable nonce · outside maintenance window
       ✗ matches no effective declaration entry

T+4s   Incident opened          bond 500 USDC
       quorum 5 of 7 · attestations accepted until T+300s

T+9s   ✗ unauthorized   attestor-02      1/5
T+12s  ✗ unauthorized   attestor-05      2/5
T+15s  ✓ authorized     attestor-01
T+18s  ✗ unauthorized   attestor-03      3/5
T+20s  ✗ unauthorized   attestor-07      4/5
T+22s  ✗ unauthorized   attestor-04      5/5   ← QUORUM REACHED

T+22s  PAYOUT 2,400,000 USDC → Meridian Perps treasury
       released by the same transaction that recorded the quorum
```

`attestor-06` never votes — leave it visibly absent, it shows the quorum forms
even when part of the set is unavailable. `attestor-01` disagrees and stays
visible in the final state.

The counter stopping at 22 seconds is the point of the whole demo: that is the
time from an unauthorized transaction to money in the treasury. Make it the
largest element on the screen.

## Screen 4 — Verification trail (route `/incident/:id/verify`)

The same incident presented as evidence rather than as a show — a plain list a
third party could check independently:

- trigger transaction signature
- snapshot of the declaration entries that were effective when it opened
- all 6 attestations: attestor, verdict, timestamp, transaction signature
- payout transaction, amount, beneficiary
- the quorum rule in force at that moment (5 of 7)

A "Copy all as JSON" button.

## Demo controls

In the header:
- **Run scenario** — resets and replays the incident timeline from the start over
  roughly 25 seconds of real time
- **Reset** — return to the "no incidents" state

## Hard constraints

- Use only the invented protocol names above. Do not use any real protocol,
  company or product name anywhere in the app.
- Do not use real Solana addresses or transaction signatures. Show truncated
  placeholders like `5xK2…9fPq` only.
- No wallet connection, no login, no forms, no writes. The app only displays data.
- All amounts in USDC. No prices, no conversions, no other assets.
- Footer on every page: `Demo — mock data`.
