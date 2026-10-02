import { describe, expect, it } from 'vitest'
import {
  amountSchema,
  discriminatorHexSchema,
  errorResponseSchema,
  incidentsQuerySchema,
  isInForce,
  payable,
  pubkeySchema,
  quorumNeeded,
  signatureSchema,
  toBaseUnits,
  utilizationBps,
} from './api'

const U64_MAX = '18446744073709551615'

describe('amountSchema', () => {
  it('takes a u64 in base units, verbatim', () => {
    for (const text of ['0', '1', '4200000000000', U64_MAX]) {
      expect(amountSchema.parse(text)).toBe(text)
    }
    expect(toBaseUnits(U64_MAX)).toBe(2n ** 64n - 1n)
  })

  it('refuses one past u64, and anything that is not a plain decimal', () => {
    // Every one of these must fail cleanly, not throw out of `BigInt`: a thrown error
    // in a validator is a 500 where the contract promises a 400.
    for (const text of [
      '18446744073709551616',
      '-1',
      '1.5',
      '1e6',
      '007',
      '',
      ' 1',
      '0x10',
      'abc',
    ]) {
      expect(amountSchema.safeParse(text).success, text).toBe(false)
    }
  })

  it('refuses a number, which is the lossy form the contract exists to avoid', () => {
    expect(amountSchema.safeParse(4_200_000).success).toBe(false)
  })
})

describe('address and signature formats', () => {
  it('takes base58 keys and signatures of the right length', () => {
    expect(pubkeySchema.safeParse('11111111111111111111111111111111').success).toBe(true)
    expect(pubkeySchema.safeParse('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').success).toBe(true)
    expect(signatureSchema.safeParse('5'.repeat(88)).success).toBe(true)
  })

  it('refuses characters base58 leaves out, and truncated placeholders', () => {
    // 0, O, I and l are not base58; `…` is how the old mocks shortened addresses.
    expect(pubkeySchema.safeParse(`0${'1'.repeat(31)}`).success).toBe(false)
    expect(pubkeySchema.safeParse('MerdN…8kQ2').success).toBe(false)
    expect(signatureSchema.safeParse('1'.repeat(44)).success).toBe(false)
  })

  it('takes a discriminator as sixteen lowercase hex digits', () => {
    expect(discriminatorHexSchema.safeParse('0102030405060708').success).toBe(true)
    expect(discriminatorHexSchema.safeParse('01020304050607').success).toBe(false)
    expect(discriminatorHexSchema.safeParse('0102030405060A08').success).toBe(false)
  })
})

describe('incidentsQuerySchema', () => {
  it('coerces the limit from a query string and defaults it', () => {
    expect(incidentsQuerySchema.parse({ limit: '50' }).limit).toBe(50)
    expect(incidentsQuerySchema.parse({}).limit).toBe(20)
  })

  it('refuses a limit outside 1..100 and an unknown status', () => {
    expect(incidentsQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(incidentsQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
    expect(incidentsQuerySchema.safeParse({ status: 'disputed' }).success).toBe(false)
  })
})

describe('errorResponseSchema', () => {
  it('has no code for failed authentication, because there is none (FR-030)', () => {
    const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'no' } }
    expect(errorResponseSchema.safeParse(unauthorized).success).toBe(false)
    expect(
      errorResponseSchema.parse({ error: { code: 'NOT_FOUND', message: 'no' } }).error.details,
    ).toEqual({})
  })
})

describe('derived fields', () => {
  it('rounds utilization down and reads an empty pool as zero', () => {
    expect(utilizationBps(3_000_000n, 4_200_000n)).toBe(7_142)
    expect(utilizationBps(0n, 0n)).toBe(0)
    expect(utilizationBps(1n, 3n)).toBe(3_333)
  })

  it('does not cap utilization, so an over-promised pool stays visible', () => {
    expect(utilizationBps(200n, 100n)).toBe(20_000)
  })

  it('stays exact at the top of u64', () => {
    const max = 2n ** 64n - 1n
    expect(utilizationBps(max, max)).toBe(10_000)
  })

  it('rounds the quorum up, as resolve does', () => {
    // Set of 3 at 60%: 1.8 attestations, so two — one would let a third decide.
    expect(quorumNeeded(3, 6_000)).toBe(2)
    expect(quorumNeeded(7, 6_000)).toBe(5)
    expect(quorumNeeded(5, 6_000)).toBe(3)
    expect(quorumNeeded(4, 10_000)).toBe(4)
  })

  it('floors payable at zero once the retention swallows what is left', () => {
    expect(payable(1_000n, 200n)).toBe(800n)
    expect(payable(150n, 200n)).toBe(0n)
  })

  describe('isInForce, as Policy::is_in_force', () => {
    const policy = { status: 'active', premiumPaid: 1n, startTs: 100, endTs: 200 } as const

    it('holds from the start second up to, not including, the end', () => {
      expect(isInForce(policy, 99)).toBe(false)
      expect(isInForce(policy, 100)).toBe(true)
      expect(isInForce(policy, 199)).toBe(true)
      expect(isInForce(policy, 200)).toBe(false)
    })

    it('never holds for an exhausted policy, even inside its period', () => {
      expect(isInForce({ ...policy, status: 'exhausted' }, 150)).toBe(false)
    })

    it('never holds without a paid premium', () => {
      expect(isInForce({ ...policy, premiumPaid: 0n }, 150)).toBe(false)
    })

    it('goes by the clock, not by the stored status', () => {
      // `status` moves only when an instruction writes it; time does not wait for one.
      expect(isInForce({ ...policy, status: 'pending' }, 150)).toBe(true)
      expect(isInForce({ ...policy, status: 'expired' }, 150)).toBe(true)
    })
  })
})
