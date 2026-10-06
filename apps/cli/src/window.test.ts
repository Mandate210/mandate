import type { DeclarationEntry } from '@mandate/shared'
import { describe, expect, it } from 'vitest'
import { WindowError, checkNarrow, checkRevoke, checkSubmit, isLive, parseTime } from './window'

const NOW = 1_800_000_000
const DAY = 86_400
const CLUSTER = { now: NOW, delay: DAY }

describe('parseTime', () => {
  it('reads unix seconds, now, and ISO with a zone', () => {
    expect(parseTime('1800000000', NOW)).toBe(1_800_000_000)
    expect(parseTime('now', NOW)).toBe(NOW)
    expect(parseTime('2027-01-15T08:00:00Z', NOW)).toBe(Date.UTC(2027, 0, 15, 8) / 1000)
    expect(parseTime('2027-01-15T10:00:00+02:00', NOW)).toBe(Date.UTC(2027, 0, 15, 8) / 1000)
  })

  it('refuses a time whose zone would depend on the machine', () => {
    expect(() => parseTime('2027-01-15T08:00:00', NOW)).toThrow(/zone/)
    expect(() => parseTime('tomorrow', NOW)).toThrow(WindowError)
  })
})

describe('checkSubmit — submit_declaration.rs, said before signing', () => {
  const bounded = {
    notBefore: NOW,
    notAfter: NOW + 2 * DAY,
    movesFunds: true,
    knownToMoveFunds: undefined,
  }

  it('accepts a bounded window that outlives the delay, and notes the dead head', () => {
    expect(checkSubmit(bounded, CLUSTER)).toEqual([
      expect.stringMatching(/nothing in it is declared before/),
    ])
    expect(checkSubmit({ ...bounded, notBefore: NOW + 2 * DAY - 1 }, CLUSTER)).toEqual([])
  })

  it('refuses a permanent window for an operation that moves funds (FR-035)', () => {
    expect(() => checkSubmit({ ...bounded, notAfter: null }, CLUSTER)).toThrow(/FR-035/)
    expect(checkSubmit({ ...bounded, notAfter: null, movesFunds: false }, CLUSTER)).toEqual([
      expect.stringMatching(/permanent/),
    ])
  })

  it('refuses --no-moves-funds where the table knows better', () => {
    expect(() =>
      checkSubmit(
        { ...bounded, notAfter: null, movesFunds: false, knownToMoveFunds: true },
        CLUSTER,
      ),
    ).toThrow(/--moves-funds/)
  })

  it('refuses a window that covers nothing', () => {
    expect(() => checkSubmit({ ...bounded, notAfter: NOW }, CLUSTER)).toThrow(
      /ends before it begins/,
    )
    // The boundary is the program's: `not_after > effective_at`, strictly.
    expect(() => checkSubmit({ ...bounded, notAfter: NOW + DAY }, CLUSTER)).toThrow(/cover nothing/)
    expect(() => checkSubmit({ ...bounded, notAfter: NOW + DAY + 1 }, CLUSTER)).not.toThrow()
  })
})

const entry = (overrides: Partial<DeclarationEntry> = {}): DeclarationEntry => ({
  programId: '11111111111111111111111111111111',
  ixDiscriminator: [2, 0, 0, 0, 0, 0, 0, 0],
  notBefore: NOW - DAY,
  notAfter: NOW + DAY,
  movesFunds: true,
  submittedAt: NOW - 3 * DAY,
  effectiveAt: NOW - 2 * DAY,
  revokedAt: null,
  ...overrides,
})

describe('checkNarrow — revoke_declaration.rs, said before signing', () => {
  it('accepts a narrower end from now on, now included', () => {
    expect(() => checkNarrow(entry(), NOW + 60, NOW)).not.toThrow()
    expect(() => checkNarrow(entry(), NOW, NOW)).not.toThrow()
    expect(() =>
      checkNarrow(entry({ notAfter: null, movesFunds: false }), NOW + DAY * 365, NOW),
    ).not.toThrow()
  })

  it('refuses the past, a widening, an empty window and a revoked entry', () => {
    expect(() => checkNarrow(entry(), NOW - 1, NOW)).toThrow(/into the past/)
    expect(() => checkNarrow(entry(), NOW + DAY, NOW)).toThrow(/new entry/)
    expect(() => checkNarrow(entry({ notBefore: NOW + 60 }), NOW + 60, NOW)).toThrow(/revoke/)
    expect(() => checkNarrow(entry({ revokedAt: NOW - 1 }), NOW + 60, NOW)).toThrow(
      /already revoked/,
    )
  })
})

describe('checkRevoke and isLive', () => {
  it('revokes once', () => {
    expect(() => checkRevoke(entry())).not.toThrow()
    expect(() => checkRevoke(entry({ revokedAt: NOW }))).toThrow(/already revoked/)
  })

  it('shows pending entries — the delay is the time to catch a stolen key’s', () => {
    expect(isLive(entry({ effectiveAt: NOW + DAY, notAfter: NOW + 2 * DAY }), NOW)).toBe(true)
    expect(isLive(entry(), NOW)).toBe(true)
    expect(isLive(entry({ revokedAt: NOW }), NOW)).toBe(false)
    expect(isLive(entry({ notAfter: NOW - 1 }), NOW)).toBe(false)
  })
})
