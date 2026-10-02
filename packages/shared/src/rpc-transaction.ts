import { z } from 'zod'
import type { ObservedTransaction } from './declaration'
import { base58Decode, flattenInstructions } from './observed'

/**
 * A `getTransaction` response in `encoding: 'json'`, read straight off the wire (T077).
 *
 * Decided 2026-10-02: the attestor and the indexer read transactions through this and
 * not through a client library. `@solana/web3.js` 1.x validates the response against
 * the versions it knew of, and rejected version 1 outright — at a time when v1 was a
 * quarter of devnet's traffic and a tenth of mainnet's. A privileged transaction the
 * attestor cannot read is a compromise it does not see, so the shape we depend on is
 * spelled out here, and only that much of it: fields a new version adds (v1 brought
 * `message.transactionConfig`) pass through without a release of anybody's parser.
 *
 * Legacy, v0 and v1 all answer in this shape. Addresses a v0 message loads from lookup
 * tables come in `meta.loadedAddresses` and follow the static keys — writable, then
 * read-only — which is the order instruction indices count in.
 *
 * `jsonParsed` is deliberately not used: it renames accounts per program and would make
 * what the rule sees depend on which programs the RPC happens to know how to decode.
 */

const indexSchema = z.number().int().nonnegative()

const rpcInstructionSchema = z.object({
  programIdIndex: indexSchema,
  accounts: z.array(indexSchema),
  /** Base58, outer and inner alike. */
  data: z.string(),
  stackHeight: z.number().int().nullish(),
})

export const rpcTransactionSchema = z.object({
  blockTime: z.number().int().nullish(),
  meta: z
    .object({
      err: z.unknown(),
      loadedAddresses: z
        .object({ writable: z.array(z.string()), readonly: z.array(z.string()) })
        .nullish(),
      innerInstructions: z
        .array(z.object({ index: indexSchema, instructions: z.array(rpcInstructionSchema) }))
        .nullish(),
    })
    .nullable(),
  transaction: z.object({
    message: z.object({
      header: z.object({ numRequiredSignatures: indexSchema }),
      accountKeys: z.array(z.string()),
      instructions: z.array(rpcInstructionSchema),
    }),
  }),
})

/**
 * What a read found.
 *
 * - `ok` — a successful transaction with a block time: something the rule can judge.
 * - `failed` — it ran and failed. **A failed transaction is not an event**: it changed
 *   nothing on chain, and an incident opened on it would be an incident about an attempt.
 * - `missing` — the node has not got it, or not its block time, yet or any more. Not an
 *   answer about the transaction: the caller decides whether to ask again.
 */
export type TransactionRead =
  | { kind: 'ok'; transaction: ObservedTransaction }
  | { kind: 'failed' }
  | { kind: 'missing' }

export const fromRpcTransaction = (signature: string, response: unknown): TransactionRead => {
  if (response === null) return { kind: 'missing' }
  const fetched = rpcTransactionSchema.parse(response)
  if (fetched.meta != null && fetched.meta.err != null) return { kind: 'failed' }
  if (fetched.blockTime == null) return { kind: 'missing' }

  const message = fetched.transaction.message
  const loaded = fetched.meta?.loadedAddresses
  const keys = [...message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])]
  // An index past the keys is a malformed response. Never an empty program id: that
  // would match no declaration entry and turn a broken read into an incident.
  const key = (index: number): string => {
    const found = keys[index]
    if (found === undefined) {
      throw new Error(`${signature}: account index ${index} past ${keys.length} keys`)
    }
    return found
  }
  const toInstruction = (instruction: z.infer<typeof rpcInstructionSchema>) => ({
    programId: key(instruction.programIdIndex),
    data: base58Decode(instruction.data),
    accounts: instruction.accounts.map(key),
  })

  const inner = (fetched.meta?.innerInstructions ?? []).map((group) => ({
    index: group.index,
    instructions: group.instructions.map((instruction) => ({
      ...toInstruction(instruction),
      ...(instruction.stackHeight == null ? {} : { stackHeight: instruction.stackHeight }),
    })),
  }))

  return {
    kind: 'ok',
    transaction: {
      signature,
      blockTime: fetched.blockTime,
      signers: message.accountKeys.slice(0, message.header.numRequiredSignatures),
      accountKeys: keys,
      instructions: flattenInstructions(message.instructions.map(toInstruction), inner),
    },
  }
}
