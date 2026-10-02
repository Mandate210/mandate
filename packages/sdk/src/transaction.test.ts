import { describe, expect, it } from 'vitest'
import {
  JsonRpcError,
  MAX_TRANSACTION_VERSION,
  UnsupportedTransactionVersionError,
  createJsonRpc,
  readTransaction,
} from './transaction'

/** A node that answers each request with the next of `replies`, and records the requests. */
const fakeNode = (replies: { status?: number; body?: unknown }[]) => {
  const requests: { method: string; params: unknown[] }[] = []
  const pauses: number[] = []
  const send = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as { method: string; params: unknown[] })
    const reply = replies.shift() ?? { body: { jsonrpc: '2.0', id: 0, result: null } }
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
  }) as typeof fetch
  const rpc = createJsonRpc('http://node', {
    fetch: send,
    sleep: async (ms) => {
      pauses.push(ms)
    },
  })
  return { rpc, requests, pauses }
}

describe('readTransaction', () => {
  it('asks for json, for every version this reader knows, at the given commitment', async () => {
    const node = fakeNode([{ body: { jsonrpc: '2.0', id: 1, result: null } }])
    expect(await readTransaction(node.rpc, 'Sig', 'finalized')).toEqual({ kind: 'missing' })
    expect(node.requests).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [
          'Sig',
          {
            encoding: 'json',
            maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION,
            commitment: 'finalized',
          },
        ],
      },
    ])
    expect(MAX_TRANSACTION_VERSION).toBe(1)
  })

  it('turns -32015 into its own error, so it is never mistaken for a missing transaction', async () => {
    const node = fakeNode([
      {
        body: {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32015, message: 'Transaction version (2) is not supported' },
        },
      },
    ])
    await expect(readTransaction(node.rpc, 'Sig', 'confirmed')).rejects.toBeInstanceOf(
      UnsupportedTransactionVersionError,
    )
  })

  it('passes any other RPC error through', async () => {
    const node = fakeNode([
      { body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } } },
    ])
    await expect(readTransaction(node.rpc, 'Sig', 'confirmed')).rejects.toBeInstanceOf(JsonRpcError)
  })
})

describe('createJsonRpc', () => {
  it('retries 429 with a doubling pause, as web3.js did', async () => {
    const node = fakeNode([
      { status: 429 },
      { status: 429 },
      { body: { jsonrpc: '2.0', id: 3, result: 42 } },
    ])
    expect(await node.rpc('getSlot', [])).toBe(42)
    expect(node.pauses).toEqual([500, 1000])
  })

  it('gives up after five retries and says why', async () => {
    const node = fakeNode(Array.from({ length: 6 }, () => ({ status: 429 })))
    await expect(node.rpc('getSlot', [])).rejects.toThrow('HTTP 429')
    expect(node.pauses).toHaveLength(5)
  })
})
