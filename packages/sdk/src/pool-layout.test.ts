import { BorshCoder, type Idl } from '@coral-xyz/anchor'
import { describe, expect, it } from 'vitest'
import committedIdl from './idl/drain_cover.json'
import { LEGACY_POOL_SIZE, POOL_FIELDS_SINCE_T082, POOL_SIZE, padLegacyPool } from './pool-layout'

const idl = committedIdl as unknown as Idl
const coder = new BorshCoder(idl)

const poolFields = (): string[] => {
  const pool = idl.types?.find((type) => type.name === 'Pool')
  if (pool === undefined || pool.type.kind !== 'struct' || pool.type.fields === undefined) {
    throw new Error('the IDL has no Pool struct')
  }
  return pool.type.fields.map((field) =>
    typeof field === 'object' && 'name' in field ? field.name : JSON.stringify(field),
  )
}

// Padding a legacy pool is only sound while the old layout is a prefix of the new
// one. A field inserted anywhere but the end would shift every offset after it, and
// a padded old pool would decode to numbers nobody wrote.
describe('the Pool layout across T082', () => {
  it('is the current size in the committed IDL', () => {
    // `size` counts the discriminator too.
    expect(coder.accounts.size('Pool')).toBe(POOL_SIZE)
  })

  it('grew only at the end', () => {
    expect(poolFields().slice(-POOL_FIELDS_SINCE_T082.length)).toEqual([...POOL_FIELDS_SINCE_T082])
    expect(POOL_SIZE - LEGACY_POOL_SIZE).toBe(8 * POOL_FIELDS_SINCE_T082.length)
  })

  it('pads a legacy pool and leaves any other length alone', () => {
    const legacy = Buffer.alloc(LEGACY_POOL_SIZE, 1)
    const padded = padLegacyPool(legacy)
    expect(padded.length).toBe(POOL_SIZE)
    expect(padded.subarray(0, LEGACY_POOL_SIZE)).toEqual(legacy)
    expect(padded.subarray(LEGACY_POOL_SIZE).every((byte) => byte === 0)).toBe(true)

    const current = Buffer.alloc(POOL_SIZE, 1)
    expect(padLegacyPool(current)).toBe(current)
  })
})
