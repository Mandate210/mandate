# Declaring maintenance: a guide for covered protocols

Mandate pays out when your protocol's privileged access is used **without your
declaring it first**. A declaration is how you say "this is us". This guide covers what
to declare, the rules the program enforces, and the `mandate-declare` CLI you use to
submit, narrow, revoke and list your entries.

Everything here is a transaction signed by your protocol's **declaration authority**,
the `authority` set when your protocol was registered. The status page is read-only,
and no part of Mandate holds your key (FR-034).

## What gets matched, and what you must declare

Attestors compare each privileged transaction against your entries, using only two
things: **which program** and **which instruction** (the instruction's discriminator).
Amounts, destinations and timing heuristics play no part. An entry covers an
instruction if the program and the discriminator match and the transaction's block time
falls inside the entry's window while the entry is in force.

Which instructions have to be covered depends on how your privileged address took part:

- **It signed the transaction.** Then *every* instruction in it has to be covered,
  including instructions reached through CPI. One uncovered instruction makes the whole
  transaction undeclared. The only exception is the Compute Budget program, which is
  ignored.
- **It did not sign, but instructions take it as an account.** This is the case for a
  multisig whose vault is your privileged address. Only the instructions that take the
  address have to be covered.

So declare every instruction your maintenance transaction carries. A program upgrade
with `solana program deploy`, for example, is several transactions made of:

| Program | Instructions |
|---|---|
| System | `create_account` (the buffer) |
| BPF Upgradeable Loader | `initialize_buffer`, `write` (many times), `upgrade` |

Covering only `upgrade` leaves the buffer writes undeclared, and that alone opens an
incident.

## The rules

| Rule | What it means for you |
|---|---|
| **Delay (FR-031)** | A new entry is in force only after the cluster's `declaration_delay`, counted from the moment the transaction lands. Submit well ahead of the maintenance. Anything performed before the entry takes effect is undeclared. |
| **Revoke and narrow take effect at once (FR-032)** | No delay. This is your defence against a stolen authority key: an entry it submits stays *pending* for the whole delay, and you can revoke it in that time. |
| **Only forward** | Revocation and narrowing never reach into the past. An operation performed while an entry was in force stays declared. You cannot narrow a window to end before now. |
| **Only narrower** | Narrowing shortens the end of a window. Widening it means submitting a new entry, which waits out the delay like any other. |
| **Permanent windows (FR-035)** | An entry without an end is allowed only for operations that move no funds and hand over no control of them, such as pausing the protocol. Anything that moves funds or changes rights over them is declared only for a bounded window. |
| **Window ends are inclusive** | A window declared to 12:00:00 covers an operation at exactly 12:00:00. |

You state yourself whether an operation moves funds (`--moves-funds` or
`--no-moves-funds`, with no default). For the native programs the CLI knows, it refuses
`--no-moves-funds` on operations known to move funds or change authority. Examples are
`upgrade`, `set_authority`, `transfer` and `mint_to`.

## The CLI

From a clone of the repository:

```bash
pnpm install
pnpm --filter @mandate/cli declare <command> [options]
```

The examples below write `mandate-declare` for that command.

Every command reads from the chain through the RPC you give it (`--rpc <url>` or
`SOLANA_RPC_URL`), not through Mandate's API. Times are unix seconds, `now`, or ISO 8601
**with a zone** (`2026-11-03T09:00:00Z`). A time without a zone is refused, because
different machines would read it differently. `--protocol` is your protocol account's
address, as shown on the status page.

### Signing: a key file or a multisig

Each command that writes takes exactly one of:

- `--keypair <file>`: the authority's Solana CLI keypair file. It is read for this one
  transaction and not kept. The CLI shows what it is about to send and asks before
  signing. Pass `--yes` to skip the question in scripts.
- `--unsigned`: nothing is signed or sent. The CLI prints the transaction, unsigned,
  with your authority as fee payer, in base58 and base64, and prints the instruction as
  JSON. Use this when the authority is a multisig, such as a Squads vault: import the
  transaction, or propose the instruction, there. The vault pays the rent for a new
  entry (about 0.0015 SOL), so it needs the SOL.

Two things to know about `--unsigned` with a multisig:

- The delay counts from **execution**. A proposal executed a day later takes effect a
  day later.
- A new entry's address is fixed by its number when you build the transaction. If
  another entry lands before your proposal executes, the program refuses the proposal.
  Rebuild it and propose it again. Nothing is overwritten.

### Submit

```bash
# A three-hour upgrade window next Tuesday: one entry per instruction the deploy carries
for ix in initialize_buffer write upgrade; do
  mandate-declare submit --protocol <addr> \
    --program BPFLoaderUpgradeab1e11111111111111111111111 --instruction $ix \
    --from 2026-11-03T09:00:00Z --until 2026-11-03T12:00:00Z --moves-funds \
    --keypair ~/keys/protocol-authority.json
done
mandate-declare submit --protocol <addr> \
  --program 11111111111111111111111111111111 --instruction create_account \
  --from 2026-11-03T09:00:00Z --until 2026-11-03T12:00:00Z --moves-funds \
  --keypair ~/keys/protocol-authority.json

# A permanent entry for your own Anchor program's pause instruction
mandate-declare submit --protocol <addr> \
  --program <your program id> --instruction pause \
  --from now --permanent --no-moves-funds --unsigned
```

How `--instruction` is resolved:

- **System, BPF Upgradeable Loader, Address Lookup Table, SPL Token, Token-2022 (base
  instructions) and Associated Token Account** come from a built-in table, in each
  program's own encoding (`snake_case` or `CamelCase` names both work).
- **Any other program is treated as Anchor.** The discriminator is taken from the IDL
  the program published on-chain (`anchor idl init`). Pass `--idl <file>` if it
  published none.
- `--discriminator <hex>` gives the bytes directly. For native programs only the method
  bytes count: one byte for the token programs, four for the others. The CLI refuses
  extra bytes that attestors would ignore, because such an entry would never match. Use
  this for Token-2022 extension instructions.

Before signing, the CLI repeats the program's own checks, so a multisig never signs a
transaction the program would refuse. It also shows when the entry would take effect
if it landed now.

### Narrow and revoke

```bash
mandate-declare narrow --protocol <addr> --seq 4 --until 2026-11-03T10:30:00Z --keypair <file>
mandate-declare revoke --protocol <addr> --seq 4 --keypair <file>
```

`--seq` is the entry's number, from `list`.

### List

```bash
mandate-declare list --protocol <addr>          # pending, scheduled and in force
mandate-declare list --protocol <addr> --all    # with revoked and expired
mandate-declare list --protocol <addr> --json
```

The state of each entry is computed at the **cluster's** time:

| State | Meaning |
|---|---|
| `pending` | The delay has not passed yet. |
| `scheduled` | In force, but the window has not opened. |
| `effective` | Covers operations now. |
| `expired` | The window has closed. |
| `revoked` | Revoked. |

Check `list` regularly. A pending entry you did not submit means your authority key is
compromised, and it can only be stopped while it is pending.
