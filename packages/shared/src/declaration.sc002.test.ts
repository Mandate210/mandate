import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type DeclarationEntry,
  INERT_PROGRAM_IDS,
  type ObservedTransaction,
  evaluateTransaction,
  methodOf,
} from './declaration'

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

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** The fixtures keep instruction data exactly as the RPC returned it, which is base58.
 * Decoding here rather than at collection time keeps the files verbatim evidence. */
const base58Decode = (text: string): number[] => {
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros += 1

  const bytes: number[] = []
  for (let index = zeros; index < text.length; index += 1) {
    let carry = ALPHABET.indexOf(text[index] as string)
    if (carry === -1) throw new Error(`not base58: ${text}`)
    for (let byte = 0; byte < bytes.length; byte += 1) {
      carry += (bytes[byte] as number) * 58
      bytes[byte] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  return [...new Array<number>(zeros).fill(0), ...bytes.reverse()]
}

const fixtureSchema = z.object({
  provenance: z.object({
    cluster: z.string(),
    rpc: z.string(),
    fetchedAt: z.string(),
    derivedFrom: z.string(),
  }),
  authority: z.string(),
  programId: z.string(),
  transactions: z
    .array(
      z.object({
        signature: z.string(),
        slot: z.number(),
        blockTime: z.number().int(),
        signers: z.array(z.string()),
        instructions: z.array(z.object({ programId: z.string(), data: z.string() })),
      }),
    )
    .min(1),
})

interface Protocol {
  authority: string
  transactions: ObservedTransaction[]
}

const load = (): Protocol[] =>
  readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json') && name !== 'skipped.json')
    .map((name) => {
      const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')))
      return {
        authority: fixture.authority,
        transactions: fixture.transactions
          .map((transaction) => ({
            signature: transaction.signature,
            blockTime: transaction.blockTime,
            signers: transaction.signers,
            instructions: transaction.instructions.map((instruction) => ({
              programId: instruction.programId,
              data: base58Decode(instruction.data),
            })),
          }))
          .sort((left, right) => left.blockTime - right.blockTime),
      }
    })

const protocols = load()
const total = protocols.reduce((sum, protocol) => sum + protocol.transactions.length, 0)

/** What a declaration is keyed on — the pair an entry stores. */
const operationsOf = (transaction: ObservedTransaction): string[] =>
  transaction.instructions
    .filter((instruction) => !INERT_PROGRAM_IDS.includes(instruction.programId))
    .map(
      (instruction) =>
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

  it('opens no incident on an operation the protocol had already been performing', () => {
    let checked = 0
    let novel = 0
    const falseOpenings: { authority: string; signature: string; uncovered: unknown }[] = []

    for (const protocol of protocols) {
      const split = Math.max(1, Math.floor(protocol.transactions.length * TRAIN_SHARE))
      const history = protocol.transactions.slice(0, split)
      const later = protocol.transactions.slice(split)
      if (later.length === 0) continue

      const declared = new Set(history.flatMap(operationsOf))
      const effectiveAt = history[history.length - 1]?.blockTime ?? 0
      const until = (later[later.length - 1]?.blockTime ?? 0) + HOUR
      const entries = declare(declared, effectiveAt, until)

      for (const transaction of later) {
        const operations = operationsOf(transaction)
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
