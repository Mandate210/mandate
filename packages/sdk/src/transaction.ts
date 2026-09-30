// A fetched transaction, reduced to what the rest of the system reads (T027, moved
// here in T048 so the attestor and the indexer read transactions through one copy).

import type { ObservedTransaction } from '@mandate/shared'
import { base58Decode, flattenInstructions } from '@mandate/shared'
import type { Connection } from '@solana/web3.js'

/**
 * A transaction as the rule needs it.
 *
 * **A failed transaction is not an event.** It changed nothing on chain, so it is no
 * evidence of anything and an incident opened on it would be an incident about an
 * attempt. `watch.ts` already drops these; this drops them again, because a signature
 * can also arrive from a sweep of history.
 *
 * `jsonParsed` is deliberately not used: it renames accounts per program and would make
 * what the rule sees depend on which programs the RPC happens to know how to decode.
 */
export const toObservedTransaction = (
  signature: string,
  fetched: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>,
): ObservedTransaction | null => {
  if (fetched.meta?.err != null) return null
  if (fetched.blockTime == null) return null

  const message = fetched.transaction.message
  const keys = message
    .getAccountKeys({ accountKeysFromLookups: fetched.meta?.loadedAddresses ?? null })
    .keySegments()
    .flat()
    .map((key) => key.toBase58())

  const compiled = message.compiledInstructions.map((instruction) => ({
    programId: keys[instruction.programIdIndex] ?? '',
    data: [...instruction.data],
    accounts: instruction.accountKeyIndexes.map((index) => keys[index] ?? ''),
  }))

  const inner = (fetched.meta?.innerInstructions ?? []).map((group) => ({
    index: group.index,
    instructions: group.instructions.map((instruction) => {
      const height = stackHeightOf(instruction)
      return {
        programId: keys[instruction.programIdIndex] ?? '',
        // Inner instruction data comes off the RPC base58-encoded, unlike the outer ones.
        data: base58Decode(instruction.data),
        accounts: instruction.accounts.map((index) => keys[index] ?? ''),
        ...(height === undefined ? {} : { stackHeight: height }),
      }
    }),
  }))

  return {
    signature,
    blockTime: fetched.blockTime,
    signers: message.staticAccountKeys
      .slice(0, message.header.numRequiredSignatures)
      .map((key) => key.toBase58()),
    accountKeys: keys,
    instructions: flattenInstructions(compiled, inner),
  }
}

/**
 * A node reports how deep a CPI instruction ran, but `@solana/web3.js` has never put
 * `stackHeight` on `CompiledInstruction`. Read defensively rather than asserted: the
 * field is genuinely optional on the wire, and `flattenInstructions` has a floor for
 * when it is missing.
 */
const stackHeightOf = (instruction: unknown): number | undefined => {
  if (typeof instruction !== 'object' || instruction === null) return undefined
  const value = (instruction as Record<string, unknown>).stackHeight
  return typeof value === 'number' ? value : undefined
}
