# Privileged transaction fixtures — the evidence behind SC-002

Real mainnet transactions signed by real privileged addresses. One file per protocol,
named after the privileged address; `skipped.json` records the addresses that were
looked at and produced nothing, which is a finding in itself.

Collected by `packages/shared/scripts/fetch-privileged.mjs`, and re-collected by
running it again — the script clears this directory first, so a run is one coherent
snapshot rather than a pile of samples taken at different hours.

## Where the addresses come from

**None of them were typed from memory.** The script starts at a recent block, takes the
programs that appear in it, reads each program's `ProgramData` account to find its
upgrade authority, and then keeps the transactions that authority actually signed. Each
file states that chain in `provenance.derivedFrom`, so «this address is privileged» is
a claim anyone can re-check against mainnet rather than take on trust.

## Shape

```jsonc
{
  "provenance": {
    "cluster": "mainnet-beta",
    "rpc": "https://solana-rpc.publicnode.com",
    "fetchedAt": "2026-08-12T…",
    "derivedFrom": "upgrade authority of program …, read from its ProgramData account"
  },
  "authority": "…",              // the privileged address
  "programId": "…",              // the program it is authority over
  "transactions": [
    {
      "signature": "…",
      "slot": 438854410,
      "blockTime": 1786555530,   // seconds, cluster clock
      "signers": ["…"],          // static keys, up to numRequiredSignatures
      "instructions": [
        { "programId": "…", "data": "3Bxs…" }  // base58, verbatim from the RPC
      ]
    }
  ]
}
```

`data` stays base58 exactly as the RPC returned it. Decoding it at collection time
would mean the fixture recorded our interpretation of the transaction instead of the
transaction; `declaration.sc002.test.ts` decodes when it reads.

## What these fixtures are not

They are **not** a claim that any of these protocols is covered by a policy, or has any
relationship with this project. They are public chain history, used as test data for a
matching rule. Mock data elsewhere in the repo uses invented protocols for exactly the
opposite reason — a page showing a real protocol as insured would be a false statement
about somebody else's company (`docs/PLAN.md` → «Порядок постачання»).
