The demo data and the scenario engine are correct — keep them. The problem is
that none of it is reachable: `src/App.tsx` still routes to the starter template,
so the deployed app shows "Start building your Solana app" and nothing else.

Fix the wiring and add the two missing screens. Do not regenerate the files that
already exist and work.

## Keep as they are

`src/lib/mockData.ts`, `src/lib/scenario.tsx`, `src/components/AppShell.tsx`,
`src/components/UtilizationBar.tsx`, `src/pages/Pools.tsx`,
`src/pages/ProtocolDetail.tsx`.

## 1. Rewrite `src/App.tsx`

Remove every Solana and wallet import — `ConnectionProvider`, `WalletProvider`,
`WalletModalProvider`, `PhantomWalletAdapter`, `clusterApiUrl` and the
`@solana/wallet-adapter-react-ui/styles.css` import. This app connects to nothing
and must never show a Connect Wallet button.

Wrap the routes in `ScenarioProvider` from `@/lib/scenario` and render everything
inside `AppShell`. Without the provider mounted, `useScenario()` throws and every
screen crashes.

Routes:

| Path | Screen |
| --- | --- |
| `/` | `Pools` |
| `/protocol/:id` | `ProtocolDetail` |
| `/incident/:id` | `IncidentTimeline` — new, see below |
| `/incident/:id/verify` | `Verification` — new, see below |
| `*` | `NotFound` |

## 2. Delete `src/pages/Index.tsx`

It is the untouched starter page: white background, "Start building your Solana
app", "Connect your wallet to get started". It must not exist in the demo.

## 3. New screen — `src/pages/IncidentTimeline.tsx`

This is the most important screen of the whole demo. Use `INCIDENT`, `TIMELINE`
and `useScenario()`, which already provide everything needed.

- A large elapsed-time counter at the top, driven by `elapsed` from
  `useScenario()`. **It must be the largest element on the page** — bigger than
  the heading, bigger than any number in the table. It counts up while the
  scenario runs and freezes at 22s.
- Below it, a vertical timeline rendering `visibleEvents` — events appear one
  after another as their timestamp is reached, each with a short fade/slide in.
  Never render the full list at once while running.
- Each attestation event shows: verdict, attestor id, and the running count
  toward quorum (`1/5`, `2/5`, …). The `authorized` vote from `attestor-01` stays
  visible and does not increment the count.
- `attestor-06` never appears — show the attestor set somewhere on the page with
  `attestor-06` visibly greyed out as "no response", so it is clear the quorum
  formed while part of the set was unavailable.
- The final payout event is the visual climax: 2,400,000 USDC to the Meridian
  Perps treasury, with a note that it was released by the same transaction that
  recorded the quorum.
- When `status === 'idle'`, show an empty state that points at the Run scenario
  button in the header.

## 4. New screen — `src/pages/Verification.tsx`

The same incident as evidence rather than as a show. Plain, dense, no animation.
Use `INCIDENT`, `ATTESTATIONS` and `DECLARATION_SNAPSHOT`.

- trigger transaction signature
- the declaration entries that were effective when the incident opened
- all attestations: attestor, verdict, timestamp, transaction signature
- payout transaction, amount, beneficiary
- the quorum rule in force at that moment (5 of 7)
- a "Copy all as JSON" button that copies the whole record

Link to it from the incident timeline page.

## 5. Remove the RPC dependency

Delete `VITE_SOLANA_RPC_URL` from `.env` and drop `@solana/web3.js`,
`@solana/spl-token`, `@supabase/supabase-js` and all `@solana/wallet-adapter-*`
packages from `package.json`. The demo reads no chain and calls no service — all
data is in `src/lib/mockData.ts`.

## 6. Footer

`Demo — mock data` on every page, in `AppShell`.
