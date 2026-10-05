import type { DeclarationEntryResponse } from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { amount, decimal, freeCapital, operationOf, percent, short, windowOf } from './format'

describe('decimal', () => {
  it('puts the point where the mint does, grouping the whole part', () => {
    expect(decimal(100_100_000_000n, 6)).toBe('100,100')
    expect(decimal(1_234_567_890n, 6)).toBe('1,234.56789')
  })

  it('never rounds: a single base unit shows', () => {
    expect(decimal(1n, 6)).toBe('0.000001')
    expect(decimal(999_999n, 6)).toBe('0.999999')
  })

  it('reads zero as zero, and a mint without decimals as whole units', () => {
    expect(decimal(0n, 6)).toBe('0')
    expect(decimal(1_500n, 0)).toBe('1,500')
  })

  it('stays exact past 2^53, where a JSON number would not', () => {
    expect(decimal(18_446_744_073_709_551_615n, 6)).toBe('18,446,744,073,709.551615')
  })
})

describe('amount', () => {
  it('takes the contract string as it comes and adds the unit', () => {
    expect(amount('500000000', 6)).toBe('500 USDC')
  })
})

describe('freeCapital', () => {
  it('is what no policy reserved', () => {
    expect(freeCapital('100100000000', '10000000000')).toBe(90_100_000_000n)
  })

  it('is nothing, not a negative amount, in a pool that reserved more than it holds', () => {
    expect(freeCapital('100', '200')).toBe(0n)
  })
})

describe('percent', () => {
  it('writes basis points exactly, without trailing zeros', () => {
    expect(percent(999)).toBe('9.99%')
    expect(percent(1_050)).toBe('10.5%')
    expect(percent(7_142)).toBe('71.42%')
    expect(percent(5)).toBe('0.05%')
    expect(percent(0)).toBe('0%')
    expect(percent(10_000)).toBe('100%')
  })

  it('does not cap an over-promised pool', () => {
    expect(percent(20_000)).toBe('200%')
  })
})

describe('short', () => {
  it('keeps four characters at each end', () => {
    expect(short('HMtvDKR9i4WKxfMfC7fGXXiiReh3APGoNsiCcrbCzMHk')).toBe('HMtv…zMHk')
  })
})

describe('declaration entries', () => {
  const entry: DeclarationEntryResponse = {
    address: 'AxQ45U1ksybgPitXhvCUuq7mtBraBby7cnkAUdiJZMRZ',
    seq: 0,
    program_id: 'DV4j5BGiNYwjfWp6eW73oiPExnSxp4H4vq6rVg9Xo5Wx',
    ix_discriminator: '0123456789abcdef',
    instruction: null,
    not_before: Date.UTC(2026, 9, 3, 14, 5) / 1000,
    not_after: Date.UTC(2026, 9, 4, 9, 30) / 1000,
    moves_funds: false,
    submitted_at: 0,
    effective_at: 0,
    revoked_at: null,
    state: 'effective',
  }

  it('name the operation by the program and discriminator the chain holds', () => {
    expect(operationOf(entry)).toBe('DV4j…o5Wx · 0123456789abcdef')
    expect(operationOf({ ...entry, instruction: { name: 'set_fee', source: 'anchor-idl' } })).toBe(
      'set_fee',
    )
  })

  it('write a window that ends on another day with its date', () => {
    expect(windowOf(entry)).toBe('2026-10-03 14:05 – 2026-10-04 09:30 UTC')
  })

  it('call an entry without an end permanent', () => {
    expect(windowOf({ ...entry, not_after: null })).toBe('from 2026-10-03 14:05 UTC, permanent')
  })
})
