import { describe, expect, it } from 'vitest'
import {
  type DeclarationEntry,
  INERT_PROGRAM_IDS,
  type ObservedTransaction,
  discriminatorOf,
  entryCovers,
  evaluateTransaction,
} from './declaration'

const PROTOCOL_PROGRAM = 'Drai11111111111111111111111111111111111111'
const OTHER_PROGRAM = 'Othe22222222222222222222222222222222222222'
const ADMIN = 'Admi33333333333333333333333333333333333333'
const STRANGER = 'Stra44444444444444444444444444444444444444'
const PAUSE = [1, 2, 3, 4, 5, 6, 7, 8]
const WITHDRAW = [9, 9, 9, 9, 9, 9, 9, 9]

const HOUR = 3_600
const SUBMITTED = 1_000_000
const DELAY = 24 * HOUR
const EFFECTIVE = SUBMITTED + DELAY
/** Inside the entry's window, and after it took effect. */
const DURING = EFFECTIVE + HOUR

const entry = (overrides: Partial<DeclarationEntry> = {}): DeclarationEntry => ({
  programId: PROTOCOL_PROGRAM,
  ixDiscriminator: PAUSE,
  notBefore: EFFECTIVE,
  notAfter: EFFECTIVE + 2 * HOUR,
  movesFunds: true,
  submittedAt: SUBMITTED,
  effectiveAt: EFFECTIVE,
  revokedAt: null,
  ...overrides,
})

const transaction = (overrides: Partial<ObservedTransaction> = {}): ObservedTransaction => ({
  signature: 'sig',
  blockTime: DURING,
  signers: [ADMIN],
  instructions: [{ programId: PROTOCOL_PROGRAM, data: PAUSE }],
  ...overrides,
})

const evaluate = (
  overrides: Partial<ObservedTransaction> = {},
  entries: DeclarationEntry[] = [entry()],
) => evaluateTransaction({ transaction: transaction(overrides), entries, privileged: [ADMIN] })

describe('discriminatorOf', () => {
  it('takes the first eight bytes', () => {
    expect(discriminatorOf([...PAUSE, 42, 43])).toEqual(PAUSE)
  })

  it('zero-fills data shorter than a discriminator', () => {
    // A native-program instruction can be a single opcode byte. Padding keeps the
    // comparison total instead of throwing on a transaction we still have to judge.
    expect(discriminatorOf([3])).toEqual([3, 0, 0, 0, 0, 0, 0, 0])
    expect(discriminatorOf([])).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('entryCovers', () => {
  const instruction = { programId: PROTOCOL_PROGRAM, data: PAUSE }

  it('covers a matching instruction inside the window', () => {
    expect(entryCovers(entry(), instruction, DURING)).toBe(true)
  })

  it('refuses a different program or a different instruction', () => {
    expect(entryCovers(entry(), { ...instruction, programId: OTHER_PROGRAM }, DURING)).toBe(false)
    expect(entryCovers(entry(), { ...instruction, data: WITHDRAW }, DURING)).toBe(false)
  })

  it('refuses an operation performed before the entry took effect (FR-031)', () => {
    // Submitted long ago, and that is exactly what the delay is for: the entry exists,
    // but nothing it permits has happened yet.
    const early = entry({ notBefore: SUBMITTED })
    expect(entryCovers(early, instruction, EFFECTIVE - 1)).toBe(false)
    expect(entryCovers(early, instruction, EFFECTIVE)).toBe(true)
  })

  it('treats both ends of the window as inclusive', () => {
    const window = entry({ notBefore: EFFECTIVE + HOUR, notAfter: EFFECTIVE + 2 * HOUR })
    expect(entryCovers(window, instruction, EFFECTIVE + HOUR - 1)).toBe(false)
    expect(entryCovers(window, instruction, EFFECTIVE + HOUR)).toBe(true)
    expect(entryCovers(window, instruction, EFFECTIVE + 2 * HOUR)).toBe(true)
    expect(entryCovers(window, instruction, EFFECTIVE + 2 * HOUR + 1)).toBe(false)
  })

  it('covers any later time when the entry is permanent (FR-035)', () => {
    const permanent = entry({ notAfter: null, movesFunds: false })
    expect(entryCovers(permanent, instruction, EFFECTIVE)).toBe(true)
    expect(entryCovers(permanent, instruction, EFFECTIVE + 365 * 24 * HOUR)).toBe(true)
    expect(entryCovers(permanent, instruction, EFFECTIVE - 1)).toBe(false)
  })

  it('keeps covering what happened before it was revoked (FR-032)', () => {
    const revoked = entry({ revokedAt: DURING })
    // The operation ran while the entry stood, and revoking it afterwards does not
    // make that operation undeclared — otherwise a protocol could revoke its way into
    // an incident against itself.
    expect(entryCovers(revoked, instruction, DURING - 1)).toBe(true)
    // Immediate, from that very second.
    expect(entryCovers(revoked, instruction, DURING)).toBe(false)
    expect(entryCovers(revoked, instruction, DURING + 1)).toBe(false)
  })

  it('stops covering past a narrowed window end (FR-032)', () => {
    const narrowed = entry({ notAfter: DURING })
    expect(entryCovers(narrowed, instruction, DURING)).toBe(true)
    expect(entryCovers(narrowed, instruction, DURING + 1)).toBe(false)
  })
})

describe('evaluateTransaction', () => {
  it('declares a transaction whose instruction an entry covers', () => {
    expect(evaluate()).toEqual({ status: 'declared', covered: [{ index: 0, entryIndex: 0 }] })
  })

  it('leaves alone a transaction no privileged address signed', () => {
    // Not a verdict about the transaction — a statement that it is not this protocol's
    // business. The watcher only ever sees privileged addresses, but the rule has to
    // hold on its own.
    expect(evaluate({ signers: [STRANGER] })).toEqual({ status: 'not-privileged' })
  })

  it('reports an undeclared instruction with enough to point at it', () => {
    const verdict = evaluate({
      instructions: [{ programId: PROTOCOL_PROGRAM, data: WITHDRAW }],
    })

    expect(verdict).toEqual({
      status: 'undeclared',
      uncovered: [{ index: 0, programId: PROTOCOL_PROGRAM, discriminator: WITHDRAW }],
    })
  })

  it('declares nothing when the protocol has declared nothing', () => {
    const verdict = evaluate({}, [])
    expect(verdict.status).toBe('undeclared')
  })

  it('picks the entry that covers, not the first one that looks close', () => {
    const expired = entry({ notAfter: DURING - 1 })
    const current = entry({ notBefore: DURING - HOUR, notAfter: DURING + HOUR })

    expect(evaluate({}, [expired, current])).toEqual({
      status: 'declared',
      covered: [{ index: 0, entryIndex: 1 }],
    })
  })

  it('refuses the whole transaction when one instruction is uncovered', () => {
    // The privileged key authorised everything in it, so a declared pause carrying an
    // undeclared transfer is an undeclared transaction.
    const verdict = evaluate({
      instructions: [
        { programId: PROTOCOL_PROGRAM, data: PAUSE },
        { programId: OTHER_PROGRAM, data: WITHDRAW },
      ],
    })

    expect(verdict).toEqual({
      status: 'undeclared',
      uncovered: [{ index: 1, programId: OTHER_PROGRAM, discriminator: WITHDRAW }],
    })
  })

  it('ignores instructions that carry no authority', () => {
    const [computeBudget] = INERT_PROGRAM_IDS
    if (computeBudget === undefined) throw new Error('the inert list is empty')

    // Nearly every real transaction sets a compute limit. Demanding a declaration for
    // that would make SC-002 unreachable — every legitimate transaction would open an
    // incident.
    const verdict = evaluate({
      instructions: [
        { programId: computeBudget, data: [2, 64, 66, 15, 0] },
        { programId: PROTOCOL_PROGRAM, data: PAUSE },
      ],
    })

    expect(verdict).toEqual({ status: 'declared', covered: [{ index: 1, entryIndex: 0 }] })
  })

  it('judges by the transaction clock, not by the observer', () => {
    // The same transaction and the same entry, seen at two different times, give one
    // verdict — which is what lets a third party reproduce it later (SC-007).
    const early = evaluate({ blockTime: EFFECTIVE - 1 })
    const inside = evaluate({ blockTime: DURING })

    expect(early.status).toBe('undeclared')
    expect(inside.status).toBe('declared')
  })
})
