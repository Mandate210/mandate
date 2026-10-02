import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fromRpcTransaction } from './rpc-transaction'

/**
 * Real mainnet transactions as `getTransaction` returned them in `encoding: 'json'`.
 * For legacy and v0, `expected` is what the reader this one replaced — over
 * `@solana/web3.js` 1.x — made of the same transaction.
 */
type RpcFixture = { signature: string; raw: Record<string, unknown>; expected: unknown }

const fixture = (name: 'legacy' | 'v0' | 'v1'): RpcFixture =>
  JSON.parse(
    readFileSync(new URL(`./__fixtures__/rpc/${name}.json`, import.meta.url), 'utf8'),
  ) as RpcFixture

const read = (f: RpcFixture) => fromRpcTransaction(f.signature, f.raw)

const ok = (f: RpcFixture) => {
  const result = read(f)
  if (result.kind !== 'ok') throw new Error(`expected a transaction, got ${result.kind}`)
  return result.transaction
}

describe('fromRpcTransaction', () => {
  it('reads a legacy transaction exactly as the web3.js reader did', () => {
    const legacy = fixture('legacy')
    expect(ok(legacy)).toEqual(legacy.expected)
  })

  it('reads a v0 transaction with lookup-table addresses exactly as the web3.js reader did', () => {
    const v0 = fixture('v0')
    const transaction = ok(v0)
    expect(transaction).toEqual(v0.expected)
    // The loaded addresses follow the static keys, and the indices count across both.
    const message = (v0.raw.transaction as { message: { accountKeys: string[] } }).message
    expect(transaction.accountKeys.length).toBeGreaterThan(message.accountKeys.length)
  })

  it('reads a v1 transaction, which the web3.js reader refused', () => {
    const v1 = fixture('v1')
    const transaction = ok(v1)
    const raw = v1.raw as {
      blockTime: number
      transaction: {
        message: { accountKeys: string[]; header: { numRequiredSignatures: number } }
      }
      meta: { innerInstructions: { instructions: unknown[] }[] }
    }
    const outer = 3
    const inner = raw.meta.innerInstructions.reduce((n, group) => n + group.instructions.length, 0)

    expect(transaction.signature).toBe(v1.signature)
    expect(transaction.blockTime).toBe(raw.blockTime)
    expect(transaction.signers).toEqual(
      raw.transaction.message.accountKeys.slice(
        0,
        raw.transaction.message.header.numRequiredSignatures,
      ),
    )
    expect(transaction.instructions).toHaveLength(outer + inner)
    // Outer instructions first in their own order, each followed by what it invoked.
    expect(transaction.instructions[0]?.programId).toBe(
      'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9',
    )
    expect(transaction.instructions.at(-1)?.programId).toBe('11111111111111111111111111111111')
    // v1 carries its compute budget in the message, not as instructions.
    expect(transaction.instructions.some((i) => i.programId.startsWith('ComputeBudget'))).toBe(
      false,
    )
  })

  it('takes every required signer, not just the fee payer', () => {
    // Which branch of the rule applies turns on who signed (`evaluateTransaction`): a
    // privileged address that co-signs as the second signer must be seen signing.
    const legacy = fixture('legacy')
    const transaction = legacy.raw.transaction as { message: Record<string, unknown> }
    const keys = transaction.message.accountKeys as string[]
    const header = transaction.message.header as Record<string, number>
    const cosigned = {
      ...legacy.raw,
      transaction: {
        ...transaction,
        message: { ...transaction.message, header: { ...header, numRequiredSignatures: 3 } },
      },
    }
    const read = fromRpcTransaction(legacy.signature, cosigned)
    expect(read.kind === 'ok' && read.transaction.signers).toEqual(keys.slice(0, 3))
  })

  it('reports a failed transaction as failed, never as an event', () => {
    const legacy = fixture('legacy')
    const meta = legacy.raw.meta as Record<string, unknown>
    const failed = { ...legacy.raw, meta: { ...meta, err: { InstructionError: [0, 'Custom'] } } }
    expect(fromRpcTransaction(legacy.signature, failed)).toEqual({ kind: 'failed' })
  })

  it('reports a transaction the node has not got, or not its block time, as missing', () => {
    const legacy = fixture('legacy')
    expect(fromRpcTransaction(legacy.signature, null)).toEqual({ kind: 'missing' })
    expect(fromRpcTransaction(legacy.signature, { ...legacy.raw, blockTime: null })).toEqual({
      kind: 'missing',
    })
  })

  it('refuses an account index past the keys rather than inventing an empty program id', () => {
    const legacy = fixture('legacy')
    const message = (legacy.raw.transaction as { message: Record<string, unknown> }).message
    const broken = {
      ...legacy.raw,
      transaction: {
        message: {
          ...message,
          instructions: [{ programIdIndex: 999, accounts: [], data: '1' }],
        },
      },
    }
    expect(() => fromRpcTransaction(legacy.signature, broken)).toThrow(/index 999/)
  })

  it('refuses a response that is not a transaction', () => {
    expect(() => fromRpcTransaction('sig', { hello: 'world' })).toThrow()
  })
})
