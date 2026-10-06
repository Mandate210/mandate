// An RPC that remembers, and one that only remembers (T056).
//
// The devnet half of SC-007 is a replay against answers a real RPC gave, recorded once
// and committed — so `pnpm gate` checks a real incident without a network, and the
// recording is the evidence: raw `getAccountInfo` bytes and raw `getTransaction` JSON,
// decoded by the test the way a third party would decode them.
//
// Keyed by method and parameters, nothing else. The endpoint is not part of the key and
// is never written down: a provider URL carries its API key in the path or the query.

import type { JsonRpc } from '@mandate/sdk'

export type Recording = Record<string, unknown>

const keyOf = (method: string, params: readonly unknown[]): string =>
  JSON.stringify([method, params])

/** Passes every call through to `rpc` and keeps the answer in `into`. */
export const recordingRpc =
  (rpc: JsonRpc, into: Recording): JsonRpc =>
  async (method, params) => {
    const answer = await rpc(method, params)
    into[keyOf(method, params)] = answer
    return answer
  }

/**
 * Answers from a recording only. A question the recording does not hold throws: a
 * replay that changed what it asks has to be recorded again, not quietly given `null`
 * — which an RPC would mean as «no such account».
 */
export const recordedRpc =
  (recording: Recording): JsonRpc =>
  async (method, params) => {
    const key = keyOf(method, params)
    if (!(key in recording)) throw new Error(`not in the recording: ${key}`)
    return recording[key]
  }
