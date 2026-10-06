// What the program would refuse, said before anything is signed (T068).
//
// The program is the authority on every rule here, and these checks do not replace a
// single one of them. They exist because a refusal on-chain costs more than a fee when
// the authority is a multisig: the members sign a proposal one by one, and only the
// last execution finds out it was doomed. So each rule mirrors one `require!` in
// `submit_declaration.rs` or `revoke_declaration.rs`, with the same reason in words.

import { type DeclarationEntry, entryStateAt } from '@mandate/shared'

export class WindowError extends Error {
  override name = 'WindowError'
}

/**
 * Unix seconds, `now`, or ISO 8601 **with** a zone. A time without one is refused:
 * read as local time on one machine and UTC on another, a maintenance window shifts by
 * hours, and the shift is an incident.
 */
export const parseTime = (text: string, now: number): number => {
  if (text === 'now') return now
  if (/^\d+$/.test(text)) return Number(text)
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    throw new WindowError(`${text}: give a zone (Z or ±hh:mm), or unix seconds`)
  }
  const ms = Date.parse(text)
  if (Number.isNaN(ms)) throw new WindowError(`${text} is not a time`)
  return Math.floor(ms / 1000)
}

export const isoOf = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')

export interface SubmitTerms {
  readonly notBefore: number
  /** `null` is a permanent entry. */
  readonly notAfter: number | null
  readonly movesFunds: boolean
  readonly knownToMoveFunds: boolean | undefined
}

/**
 * `validate_window`, plus the one rule only the client can apply: the built-in table
 * knows that some native operations move funds, and a protocol that says otherwise is
 * asking for a permanent window FR-035 exists to forbid.
 *
 * Returns notes worth reading before signing; throws on what the program would refuse.
 */
export const checkSubmit = (
  terms: SubmitTerms,
  { now, delay }: { now: number; delay: number },
): string[] => {
  if (terms.knownToMoveFunds === true && !terms.movesFunds) {
    throw new WindowError(
      'this operation moves funds or hands over control of them: declare it with --moves-funds',
    )
  }
  const effectiveAt = now + delay
  if (terms.notAfter === null) {
    if (terms.movesFunds) {
      throw new WindowError(
        'a fund-moving operation is declared only for a bounded window (FR-035): give --until',
      )
    }
    return [`permanent: in force from ${isoOf(Math.max(effectiveAt, terms.notBefore))} with no end`]
  }
  if (terms.notAfter <= terms.notBefore) {
    throw new WindowError('the window ends before it begins')
  }
  if (terms.notAfter <= effectiveAt) {
    throw new WindowError(
      `the window closes at ${isoOf(terms.notAfter)}, before the entry takes effect at ` +
        `${isoOf(effectiveAt)} (submission + ${delay} s, FR-031): it would cover nothing`,
    )
  }
  const notes: string[] = []
  if (terms.notBefore < effectiveAt) {
    notes.push(
      `the window opens at ${isoOf(terms.notBefore)}, but nothing in it is declared before ` +
        `${isoOf(effectiveAt)} (FR-031)`,
    )
  }
  return notes
}

/** `validate_narrowing`, and the refusal to touch an entry that is already revoked. */
export const checkNarrow = (entry: DeclarationEntry, narrowTo: number, now: number): void => {
  if (entry.revokedAt !== null) throw new WindowError('the entry is already revoked')
  if (narrowTo < now) {
    throw new WindowError(
      'a window cannot be narrowed into the past: what already ran inside it stays declared',
    )
  }
  if (narrowTo <= entry.notBefore) {
    throw new WindowError('that would end the window before it opens — revoke the entry instead')
  }
  if (entry.notAfter !== null && narrowTo >= entry.notAfter) {
    throw new WindowError(
      `the window already ends at ${isoOf(entry.notAfter)}; widening it takes a new entry, which waits out the delay like any other (FR-031)`,
    )
  }
}

export const checkRevoke = (entry: DeclarationEntry): void => {
  if (entry.revokedAt !== null) throw new WindowError('the entry is already revoked')
}

/**
 * States `list` shows without `--all`. Pending is among them on purpose: an entry a
 * stolen key submitted is pending for the whole delay, and that delay is the team's
 * time to see it and revoke it (FR-031, FR-032).
 */
export const isLive = (entry: DeclarationEntry, now: number): boolean => {
  const state = entryStateAt(entry, now)
  return state !== 'revoked' && state !== 'expired'
}
