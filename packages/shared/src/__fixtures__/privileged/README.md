# Privileged transaction fixtures — the evidence behind SC-002

Real mainnet transactions that real privileged addresses took part in. One file per
protocol, named after the privileged address; `skipped.json` records the addresses that
were looked at and produced nothing, which is a finding in itself.

**Took part in, not signed.** A privileged address is very often a multisig's, which is
off-curve: no keypair for it exists anywhere, so it can never appear among a
transaction's signers however much authority it holds. An earlier snapshot kept only
signed transactions and so contained no multisig-governed protocol at all — which is how
the matching rule came to return `not-privileged` on their program upgrades. Each file
counts both ways of taking part, in `signed` and `involvedOnly`.

Collected by `packages/shared/scripts/fetch-privileged.mjs`, and re-collected by
running it again — the script clears this directory first, so a run is one coherent
snapshot rather than a pile of samples taken at different hours.

## Where the addresses come from

**None of them were typed from memory.** The script starts at a recent block, takes the
programs that appear in it, reads each program's `ProgramData` account to find its
upgrade authority, and then keeps the transactions that authority took part in. Each
file states that chain in `provenance.derivedFrom`, so «this address is privileged» is
a claim anyone can re-check against mainnet rather than take on trust.

## What «skipped» does and does not mean

A public endpoint serves a window of days, not the whole chain — `provenance.
firstAvailableBlock` records the oldest slot it could serve when the snapshot was taken.
So an address in `skipped.json` is one with **no history inside that window**, which is
not the same as an address that never acts. The first version of this collector called
it «never appears as a signer» and claimed more than it had measured.

## Shape

```jsonc
{
  "provenance": {
    "cluster": "mainnet-beta",
    "rpc": "https://solana-rpc.publicnode.com",
    "fetchedAt": "<ISO-8601>",
    "derivedFrom": "upgrade authority of program …, read from its ProgramData account",
    "firstAvailableBlock": 438556507  // the endpoint's oldest servable slot
  },
  "authority": "…",              // the privileged address
  "programId": "…",              // the program it is authority over
  "signed": 105,                 // transactions the authority signed
  "involvedOnly": 2,             // …and ones it only took part in
  "transactions": [
    {
      "signature": "…",
      "slot": 438854410,
      "blockTime": 1786555530,   // seconds, cluster clock
      "signers": ["…"],          // static keys, up to numRequiredSignatures
      "accountKeys": ["…"],      // static keys then the ones a lookup table supplied
      "instructions": [
        {
          "programId": "…",
          "data": "3Bxs…",       // base58, verbatim from the RPC
          "accounts": ["…"]      // indices resolved to addresses
        }
      ],
      "innerInstructions": [     // grouped by the instruction that caused them
        { "index": 2, "instructions": [{ "programId": "…", "data": "…", "accounts": ["…"], "stackHeight": 2 }] }
      ]
    }
  ]
}
```

`data` stays base58 exactly as the RPC returned it. Decoding it at collection time
would mean the fixture recorded our interpretation of the transaction instead of the
transaction; `declaration.sc002.test.ts` decodes when it reads, and flattens the inner
instructions into execution order with `flattenInstructions`.

**No signer flags on the inner instructions, and none can be added.** The runtime
records nothing about which accounts a CPI signed for — `invoke_signed` leaves no trace
in a transaction's metadata. That an instruction *takes* the privileged address is the
whole of what is observable, and the whole of what the rule matches on.

## What these fixtures are not

They are **not** a claim that any of these protocols is covered by a policy, or has any
relationship with this project. They are public chain history, used as test data for a
matching rule. Mock data elsewhere in the repo uses invented protocols for exactly the
opposite reason — a page showing a real protocol as insured would be a false statement
about somebody else's company (`docs/PLAN.md` → «Порядок постачання»).
