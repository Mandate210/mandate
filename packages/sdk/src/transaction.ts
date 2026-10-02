// Reading a transaction off an RPC node (T027; one copy for the attestor and the
// indexer since T048; raw JSON-RPC since T077).
//
// Decided 2026-10-02: not through `@solana/web3.js`. Its 1.x response validator knew
// the transaction versions of its day and rejected version 1 — by then a quarter of
// devnet's traffic and a tenth of mainnet's — so a privileged transaction in it was one
// the attestor could not read at all. The request is made here and the response is
// read by `fromRpcTransaction` in `@mandate/shared`, against a schema of only the fields
// the rule needs.

import { type TransactionRead, fromRpcTransaction } from '@mandate/shared'

/** The newest transaction version this reader asks the node for. */
export const MAX_TRANSACTION_VERSION = 1

/** `-32015`: the node holds the transaction, but in a version newer than we asked for. */
const UNSUPPORTED_VERSION_CODE = -32015

/**
 * The node has the transaction and we did not ask for its version. Not a transient
 * failure: asking again gives the same answer until `MAX_TRANSACTION_VERSION` is raised
 * — but nothing about the transaction is lost by waiting for that.
 */
export class UnsupportedTransactionVersionError extends Error {
  constructor(
    readonly signature: string,
    rpcMessage: string,
  ) {
    super(`${signature}: transaction version newer than ${MAX_TRANSACTION_VERSION} — ${rpcMessage}`)
    this.name = 'UnsupportedTransactionVersionError'
  }
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`JSON-RPC ${code}: ${message}`)
    this.name = 'JsonRpcError'
  }
}

export type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>

/**
 * A JSON-RPC caller on `endpoint` — the same URL a `Connection` was made with.
 *
 * HTTP 429 is retried with a doubling pause, as `@solana/web3.js` did, so moving off it
 * does not turn a busy free-tier endpoint into failed reads. Anything else is thrown.
 */
export const createJsonRpc = (
  endpoint: string,
  {
    fetch: send = fetch,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    retries = 5,
  }: {
    fetch?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    retries?: number
  } = {},
): JsonRpc => {
  let id = 0
  return async (method, params) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      })
      if (response.status === 429 && attempt < retries) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      if (!response.ok) throw new JsonRpcError(response.status, `HTTP ${response.status}`)
      const body = (await response.json()) as {
        result?: unknown
        error?: { code: number; message: string }
      }
      if (body.error !== undefined) throw new JsonRpcError(body.error.code, body.error.message)
      return body.result ?? null
    }
  }
}

/**
 * One transaction, as the rule reads it — or why it is not there (`TransactionRead`).
 * Throws `UnsupportedTransactionVersionError` for a version past the one asked for, and
 * whatever the transport throws; the caller decides what a failed read means for it.
 */
export const readTransaction = async (
  rpc: JsonRpc,
  signature: string,
  commitment: 'confirmed' | 'finalized',
): Promise<TransactionRead> => {
  let response: unknown
  try {
    response = await rpc('getTransaction', [
      signature,
      { encoding: 'json', maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION, commitment },
    ])
  } catch (error) {
    if (error instanceof JsonRpcError && error.code === UNSUPPORTED_VERSION_CODE) {
      throw new UnsupportedTransactionVersionError(signature, error.message)
    }
    throw error
  }
  return fromRpcTransaction(signature, response)
}
