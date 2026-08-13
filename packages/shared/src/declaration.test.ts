import { describe, expect, it } from 'vitest'
import {
  type DeclarationEntry,
  INERT_PROGRAM_IDS,
  type ObservedInstruction,
  type ObservedTransaction,
  entryCovers,
  evaluateTransaction,
  methodOf,
} from './declaration'

const PROTOCOL_PROGRAM = 'Drai11111111111111111111111111111111111111'
const OTHER_PROGRAM = 'Othe22222222222222222222222222222222222222'
const ADMIN = 'Admi33333333333333333333333333333333333333'
const STRANGER = 'Stra44444444444444444444444444444444444444'
/** Stands in for a multisig's own program, which signs with its members' keys. */
const MULTISIG = 'Mult55555555555555555555555555555555555555'
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

/** A top-level instruction taking the admin — the ordinary case, where the same address
 * both signs and is passed as the authority. */
const ix = (
  programId: string,
  data: number[],
  accounts: string[] = [ADMIN],
  stackHeight = 1,
): ObservedInstruction => ({ programId, data, accounts, stackHeight })

const transaction = (overrides: Partial<ObservedTransaction> = {}): ObservedTransaction => ({
  signature: 'sig',
  blockTime: DURING,
  signers: [ADMIN],
  accountKeys: [ADMIN, PROTOCOL_PROGRAM],
  instructions: [ix(PROTOCOL_PROGRAM, PAUSE)],
  ...overrides,
})

const evaluate = (
  overrides: Partial<ObservedTransaction> = {},
  entries: DeclarationEntry[] = [entry()],
) => evaluateTransaction({ transaction: transaction(overrides), entries, privileged: [ADMIN] })

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

describe('methodOf', () => {
  it('takes the first eight bytes of an Anchor instruction', () => {
    expect(methodOf(PROTOCOL_PROGRAM, [...PAUSE, 42, 43])).toEqual(PAUSE)
  })

  it('zero-fills data shorter than eight bytes', () => {
    expect(methodOf(PROTOCOL_PROGRAM, [3])).toEqual([3, 0, 0, 0, 0, 0, 0, 0])
    expect(methodOf(PROTOCOL_PROGRAM, [])).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('takes only the opcode of a native instruction', () => {
    // The loader's `Write` puts the chunk offset right after the opcode, so two
    // chunks of one deployment differ in bytes four to eight. They are the same
    // operation, and a protocol that declared «I deploy upgrades» has declared both.
    const first = methodOf(LOADER, [1, 0, 0, 0, 204, 185, 0, 0, 0xaa, 0xbb])
    const second = methodOf(LOADER, [1, 0, 0, 0, 16, 76, 1, 0, 0xcc])
    expect(first).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect(first).toEqual(second)
  })

  it('keeps different native opcodes apart', () => {
    // `DeployWithMaxDataLen` is not `Write`, and a token transfer is not a burn.
    expect(methodOf(LOADER, [3, 0, 0, 0])).not.toEqual(methodOf(LOADER, [1, 0, 0, 0]))
    expect(methodOf(TOKEN, [3, 1, 2, 3, 4, 5, 6, 7, 8])).toEqual([3, 0, 0, 0, 0, 0, 0, 0])
    expect(methodOf(TOKEN, [8, 1, 2])).not.toEqual(methodOf(TOKEN, [3, 1, 2]))
  })
})

describe('entryCovers', () => {
  const instruction = ix(PROTOCOL_PROGRAM, PAUSE)

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

describe('evaluateTransaction — a privileged address signed', () => {
  it('declares a transaction whose instruction an entry covers', () => {
    expect(evaluate()).toEqual({
      status: 'declared',
      basis: 'signature',
      covered: [{ index: 0, entryIndex: 0 }],
    })
  })

  it('leaves alone a transaction the privileged addresses are nowhere in', () => {
    // Not a verdict about the transaction — a statement that it is not this protocol's
    // business. The watcher only ever sees privileged addresses, but the rule has to
    // hold on its own.
    expect(
      evaluate({
        signers: [STRANGER],
        accountKeys: [STRANGER, PROTOCOL_PROGRAM],
        instructions: [ix(PROTOCOL_PROGRAM, PAUSE, [STRANGER])],
      }),
    ).toEqual({ status: 'not-privileged' })
  })

  it('reports an undeclared instruction with enough to point at it', () => {
    const verdict = evaluate({ instructions: [ix(PROTOCOL_PROGRAM, WITHDRAW)] })

    expect(verdict).toEqual({
      status: 'undeclared',
      basis: 'signature',
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
      basis: 'signature',
      covered: [{ index: 0, entryIndex: 1 }],
    })
  })

  it('refuses the whole transaction when one instruction is uncovered', () => {
    // The privileged key authorised everything in it, so a declared pause carrying an
    // undeclared transfer is an undeclared transaction.
    const verdict = evaluate({
      instructions: [ix(PROTOCOL_PROGRAM, PAUSE), ix(OTHER_PROGRAM, WITHDRAW)],
    })

    expect(verdict).toEqual({
      status: 'undeclared',
      basis: 'signature',
      uncovered: [{ index: 1, programId: OTHER_PROGRAM, discriminator: WITHDRAW }],
    })
  })

  it('judges an instruction that does not name it, because its signature authorised it', () => {
    // The scope follows the authority: everything in a transaction a privileged key
    // signed ran under that key, whether or not the instruction lists it. A withdrawal
    // moving funds out of a vault whose authority is some other PDA is exactly the shape
    // an attacker would reach for if the rule looked only at named accounts.
    const verdict = evaluate({
      instructions: [ix(PROTOCOL_PROGRAM, PAUSE), ix(OTHER_PROGRAM, WITHDRAW, [STRANGER])],
    })

    expect(verdict.status).toBe('undeclared')
  })

  it('ignores instructions that carry no authority', () => {
    const [computeBudget] = INERT_PROGRAM_IDS
    if (computeBudget === undefined) throw new Error('the inert list is empty')

    // Nearly every real transaction sets a compute limit. Demanding a declaration for
    // that would make SC-002 unreachable — every legitimate transaction would open an
    // incident.
    const verdict = evaluate({
      instructions: [ix(computeBudget, [2, 64, 66, 15, 0], []), ix(PROTOCOL_PROGRAM, PAUSE)],
    })

    expect(verdict).toEqual({
      status: 'declared',
      basis: 'signature',
      covered: [{ index: 1, entryIndex: 0 }],
    })
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

describe('evaluateTransaction — a multisig acted on the protocol’s behalf', () => {
  /**
   * The shape 5 of the 17 real upgrade authorities behind T025 are in: the privileged
   * address is off-curve, so no signature of its can ever exist. A member signs, the
   * multisig program runs, and the privileged address comes down as a CPI signer of an
   * inner instruction — where no signer flag is recorded at all.
   */
  const executed = (inner: ObservedInstruction[], overrides: Partial<ObservedTransaction> = {}) =>
    transaction({
      signers: [STRANGER],
      accountKeys: [STRANGER, ADMIN, MULTISIG, PROTOCOL_PROGRAM],
      instructions: [ix(MULTISIG, [7, 7, 7, 7, 7, 7, 7, 7], [STRANGER, ADMIN]), ...inner],
      ...overrides,
    })

  const multisigEntry = entry({
    programId: MULTISIG,
    ixDiscriminator: [7, 7, 7, 7, 7, 7, 7, 7],
  })

  it('does not lose the transaction merely because the privileged address could not sign', () => {
    // The regression this whole branch exists for. Before it, this returned
    // `not-privileged` — a protocol upgrade through a multisig was invisible.
    const verdict = evaluateTransaction({
      transaction: executed([ix(PROTOCOL_PROGRAM, WITHDRAW, [ADMIN], 2)]),
      entries: [entry(), multisigEntry],
      privileged: [ADMIN],
    })

    expect(verdict).toEqual({
      status: 'undeclared',
      basis: 'involvement',
      uncovered: [{ index: 1, programId: PROTOCOL_PROGRAM, discriminator: WITHDRAW }],
    })
  })

  it('declares an inner instruction the protocol had declared', () => {
    const verdict = evaluateTransaction({
      transaction: executed([ix(PROTOCOL_PROGRAM, PAUSE, [ADMIN], 2)]),
      entries: [entry(), multisigEntry],
      privileged: [ADMIN],
    })

    expect(verdict).toEqual({
      status: 'declared',
      basis: 'involvement',
      covered: [
        { index: 0, entryIndex: 1 },
        { index: 1, entryIndex: 0 },
      ],
    })
  })

  it('judges only the instructions that take the privileged address', () => {
    // The executor's own bookkeeping — paying its rent, closing its buffer — is not the
    // protocol's business, and demanding a declaration for it would open an incident on
    // every multisig execution.
    const verdict = evaluateTransaction({
      transaction: executed([
        ix(PROTOCOL_PROGRAM, PAUSE, [ADMIN], 2),
        ix(OTHER_PROGRAM, WITHDRAW, [STRANGER], 2),
      ]),
      entries: [entry(), multisigEntry],
      privileged: [ADMIN],
    })

    expect(verdict.status).toBe('declared')
  })

  it('is not the protocol’s business when nothing takes the address', () => {
    // Named in the transaction and used by nothing in it — an account passed and
    // ignored, or one an address table dragged in.
    const verdict = evaluateTransaction({
      transaction: executed([ix(OTHER_PROGRAM, WITHDRAW, [STRANGER], 2)], {
        instructions: [
          ix(MULTISIG, [7, 7, 7, 7, 7, 7, 7, 7], [STRANGER]),
          ix(OTHER_PROGRAM, WITHDRAW, [STRANGER], 2),
        ],
      }),
      entries: [],
      privileged: [ADMIN],
    })

    expect(verdict).toEqual({ status: 'not-privileged' })
  })

  it('still reads the clock and the window the same way', () => {
    const verdict = evaluateTransaction({
      transaction: executed([ix(PROTOCOL_PROGRAM, PAUSE, [ADMIN], 2)], {
        blockTime: EFFECTIVE - 1,
      }),
      entries: [entry(), multisigEntry],
      privileged: [ADMIN],
    })

    expect(verdict.status).toBe('undeclared')
  })
})
