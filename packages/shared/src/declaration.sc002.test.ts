import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type DeclarationEntry,
  type ObservedTransaction,
  evaluateTransaction,
  methodOf,
  scopeOf,
} from './declaration'
import { base58Decode, flattenInstructions } from './observed'

/**
 * SC-002 — no false incident on real privileged transactions.
 *
 * The fixtures are mainnet transactions signed by real upgrade authorities, collected
 * by `scripts/fetch-privileged.mjs`; every address in them was derived from the chain
 * rather than typed from memory, and each file carries the derivation in `provenance`.
 *
 * **What makes this more than a tautology.** Declarations are built from the *earlier*
 * quarter of each protocol's history and the verdict is taken on the *later* three
 * quarters, so the question the test asks is the one that matters: when a protocol
 * declares the operations it has been performing, does the matcher keep recognising
 * those same operations as they run again? A transaction whose operation never
 * appeared in the earlier period is not counted either way — the protocol would have
 * declared that one too — but the number that *are* counted is asserted, so the test
 * cannot pass by quietly checking nothing.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'privileged')
const HOUR = 3_600
const DAY = 24 * HOUR
/** The share of each protocol's history that stands in for «what it declared». */
const TRAIN_SHARE = 0.25
/** SC-002 asks for at least this many real transactions. */
const REQUIRED = 200

const rpcInstructionSchema = z.object({
  programId: z.string(),
  data: z.string(),
  accounts: z.array(z.string()),
  stackHeight: z.number().int().nullable().optional(),
})

const fixtureSchema = z.object({
  provenance: z.object({
    cluster: z.string(),
    rpc: z.string(),
    fetchedAt: z.string(),
    derivedFrom: z.string(),
    firstAvailableBlock: z.number().int(),
  }),
  authority: z.string(),
  programId: z.string(),
  signed: z.number().int(),
  involvedOnly: z.number().int(),
  transactions: z
    .array(
      z.object({
        signature: z.string(),
        slot: z.number(),
        blockTime: z.number().int(),
        signers: z.array(z.string()),
        accountKeys: z.array(z.string()),
        instructions: z.array(rpcInstructionSchema),
        innerInstructions: z.array(
          z.object({ index: z.number().int(), instructions: z.array(rpcInstructionSchema) }),
        ),
      }),
    )
    .min(1),
})

interface Protocol {
  authority: string
  signed: number
  involvedOnly: number
  transactions: ObservedTransaction[]
}

/** Base58 lives in the files; the rule reads bytes. Decoded on the way in, along with
 * the flattening, so the fixtures stay verbatim evidence and the interpretation of them
 * sits in one visible place. */
const decode = (instruction: z.infer<typeof rpcInstructionSchema>) => ({
  programId: instruction.programId,
  data: base58Decode(instruction.data),
  accounts: instruction.accounts,
  ...(instruction.stackHeight == null ? {} : { stackHeight: instruction.stackHeight }),
})

const load = (): Protocol[] =>
  readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json') && name !== 'skipped.json')
    .map((name) => {
      const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')))
      return {
        authority: fixture.authority,
        signed: fixture.signed,
        involvedOnly: fixture.involvedOnly,
        transactions: fixture.transactions
          .map((transaction) => ({
            signature: transaction.signature,
            blockTime: transaction.blockTime,
            signers: transaction.signers,
            accountKeys: transaction.accountKeys,
            instructions: flattenInstructions(
              transaction.instructions.map(decode),
              transaction.innerInstructions.map((group) => ({
                index: group.index,
                instructions: group.instructions.map(decode),
              })),
            ),
          }))
          .sort((left, right) => left.blockTime - right.blockTime),
      }
    })

const protocols = load()
const total = protocols.reduce((sum, protocol) => sum + protocol.transactions.length, 0)
const involvedOnly = protocols.reduce((sum, protocol) => sum + protocol.involvedOnly, 0)

/**
 * What a declaration is keyed on — the pair an entry stores — for exactly the
 * instructions the rule will hold this protocol to.
 *
 * Taking the scope from `scopeOf` rather than restating it is what keeps the two
 * branches honest: a protocol declares what it is answerable for, and if the rule ever
 * widened its scope without the declaration widening with it, this test would start
 * finding false openings instead of silently agreeing with itself.
 */
const operationsOf = (transaction: ObservedTransaction, authority: string): string[] =>
  (scopeOf({ transaction, privileged: [authority] })?.instructions ?? []).map(
    ({ instruction }) =>
      `${instruction.programId}:${methodOf(instruction.programId, instruction.data).join(',')}`,
  )

/** The entries a protocol would have filed for the operations it was already running. */
const declare = (operations: Set<string>, effectiveAt: number, until: number): DeclarationEntry[] =>
  [...operations].map((operation) => {
    const [programId, method] = operation.split(':')
    return {
      programId: programId as string,
      ixDiscriminator: (method as string).split(',').map(Number),
      notBefore: effectiveAt,
      notAfter: until,
      // Conservatively the strictest kind of entry: a bounded window, which is all
      // FR-035 allows for anything that moves funds.
      movesFunds: true,
      submittedAt: effectiveAt - DAY,
      effectiveAt,
      revokedAt: null,
    }
  })

describe('SC-002 — real privileged transactions open no incident', () => {
  it('has the body of evidence the criterion asks for', () => {
    expect(total).toBeGreaterThanOrEqual(REQUIRED)
  })

  it('sees a privileged address that acts without ever signing', () => {
    // The regression that the involvement branch exists for, on real chain history
    // rather than on a constructed transaction. Without it every one of these is
    // `not-privileged` — a protocol governed by a multisig is invisible to the cover it
    // is paying for, and its program upgrades most of all.
    //
    // The share is small on this snapshot and that is a fact about the endpoint, not
    // about the world: a public RPC keeps days of history, and a multisig upgrade is
    // rare enough that a two-day window mostly misses it. What the snapshot does carry
    // is `skipped.json` — the authorities with no history in the window at all, five of
    // which are off-curve and so can never sign anything, ever.
    const involved = protocols.flatMap((protocol) =>
      protocol.transactions
        .filter(
          (transaction) => scopeOf({ transaction, privileged: [protocol.authority] })?.basis === 'involvement',
        )
        .map((transaction) => ({ authority: protocol.authority, signature: transaction.signature })),
    )

    expect(involvedOnly).toBeGreaterThan(0)
    expect(involved.length).toBeGreaterThan(0)
    console.log(
      `SC-002: ${involvedOnly} of ${total} transactions involve a privileged address that did not sign`,
    )
  })

  it('opens an incident on an undeclared operation, whoever signed the transaction', () => {
    // The other side of the same coin, and the reason the involvement branch is not
    // simply «be more permissive»: with nothing declared, every one of these has to be
    // grounds for an incident. A branch that recognised the transaction but never found
    // anything uncovered in it would satisfy the test above and protect nobody.
    const verdicts = protocols.flatMap((protocol) =>
      protocol.transactions
        .filter(
          (transaction) => scopeOf({ transaction, privileged: [protocol.authority] })?.basis === 'involvement',
        )
        .map((transaction) =>
          evaluateTransaction({ transaction, entries: [], privileged: [protocol.authority] }),
        ),
    )

    expect(verdicts.length).toBeGreaterThan(0)
    expect(verdicts.every((verdict) => verdict.status === 'undeclared')).toBe(true)
  })

  it('opens no incident on an operation the protocol had already been performing', () => {
    let checked = 0
    let novel = 0
    const falseOpenings: { authority: string; signature: string; uncovered: unknown }[] = []

    for (const protocol of protocols) {
      const split = Math.max(1, Math.floor(protocol.transactions.length * TRAIN_SHARE))
      const history = protocol.transactions.slice(0, split)
      const later = protocol.transactions.slice(split)
      if (later.length === 0) continue

      const declared = new Set(
        history.flatMap((transaction) => operationsOf(transaction, protocol.authority)),
      )
      const effectiveAt = history[history.length - 1]?.blockTime ?? 0
      const until = (later[later.length - 1]?.blockTime ?? 0) + HOUR
      const entries = declare(declared, effectiveAt, until)

      for (const transaction of later) {
        const operations = operationsOf(transaction, protocol.authority)
        // An operation this protocol had not performed before is outside what this
        // test can say anything about: it would have been declared as well.
        if (!operations.every((operation) => declared.has(operation))) {
          novel += 1
          continue
        }

        checked += 1
        const verdict = evaluateTransaction({
          transaction,
          entries,
          privileged: [protocol.authority],
        })
        if (verdict.status !== 'declared') {
          falseOpenings.push({
            authority: protocol.authority,
            signature: transaction.signature,
            uncovered: verdict.status === 'undeclared' ? verdict.uncovered : verdict.status,
          })
        }
      }
    }

    // Reported rather than asserted: how much of the traffic is operations seen for the
    // first time is a fact about the fixtures, and a useful one for T027.
    console.log(
      `SC-002: ${protocols.length} protocols, ${total} transactions, ${checked} checked, ${novel} first-time operations`,
    )

    expect(falseOpenings).toEqual([])
    // Guards against passing while checking almost nothing.
    expect(checked).toBeGreaterThanOrEqual(REQUIRED)

    // **This is the assertion that catches an unstable matching key**, and the count
    // above is not: a key that changes with an instruction's arguments still agrees
    // with itself, so nothing comes out undeclared — the traffic just stops looking
    // familiar. Measured on this snapshot: 3% of transactions are first-time
    // operations with `METHOD_BYTES`, and 54% were without it, when every chunk of a
    // program upgrade carried its own offset in the key.
    expect(novel / (checked + novel)).toBeLessThan(0.1)
  })
})
