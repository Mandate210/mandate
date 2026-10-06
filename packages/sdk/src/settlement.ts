// Which transaction settled an incident, read from the transaction alone (T078).
//
// The vote that completes a quorum settles the incident inside `attest`, and says so
// with an `IncidentSettled` event carried as an inner instruction into this program
// (`emit_cpi!`, `programs/drain-cover/src/events.rs`). Every attestation is an `attest`,
// so the event — not the instruction — is what tells the deciding one apart.
//
// Incidents paid before T078 were paid by a separate `resolve`, an instruction the
// program no longer has. Its trace on chain is permanent, and the database is a
// disposable cache, so the indexer has to keep recognising it to rebuild a payout's
// signature from nothing; so does a third party replaying an old decision (SC-007).
// Recognised by its discriminator and account layout as they stood, written down here
// because the current IDL no longer carries them.

import { BorshCoder, type Idl } from '@coral-xyz/anchor'
import type { ObservedTransaction } from '@mandate/shared'
import type { PublicKey } from '@solana/web3.js'
import { DRAIN_COVER_IDL } from './idl'

const coder = new BorshCoder(DRAIN_COVER_IDL as unknown as Idl)

/** Anchor's tag for an event carried by self-CPI: `sha256("anchor:event")[..8]`, LE. */
export const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d] as const

/**
 * `resolve` as deployed until T078: `sha256("global:resolve")[..8]`, and its accounts in
 * order — `config protocol pool policy incident vault beneficiary_token opener_token
 * token_program`. Only the incident's position is read.
 */
export const LEGACY_RESOLVE = {
  discriminator: [246, 150, 236, 206, 108, 63, 58, 10],
  incidentAccountIndex: 4,
} as const

export type SettledStatus = 'paid_out' | 'closed_no_payout'

export interface Settlement {
  incident: string
  status: SettledStatus
  /**
   * Base units, as decimal strings. `null` for a legacy `resolve`, whose instruction
   * carried no amounts — the incident account holds them.
   */
  payout: string | null
  shortfall: string | null
  /** `attest` and its event since T078; `resolve` before. */
  via: 'attest' | 'resolve'
}

const startsWith = (data: readonly number[], prefix: readonly number[]): boolean =>
  prefix.every((byte, index) => data[index] === byte)

/** `{ PaidOut: {} }` / `{ paidOut: {} }` → `paid_out`. */
const statusOf = (value: unknown): SettledStatus | null => {
  const name = (Object.keys(value as object)[0] ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
  return name === 'paid_out' || name === 'closed_no_payout' ? name : null
}

/**
 * Every incident this transaction settled — none for all but one transaction per
 * incident. Top-level and inner instructions alike: an event is always inner, and a
 * `resolve` sent through a multisig would have been too.
 */
export const settlementsIn = (
  programId: PublicKey,
  transaction: ObservedTransaction,
): Settlement[] => {
  const ours = programId.toBase58()
  const found: Settlement[] = []

  for (const instruction of transaction.instructions) {
    if (instruction.programId !== ours) continue
    const { data } = instruction

    if (startsWith(data, EVENT_IX_TAG)) {
      const event = coder.events.decode(
        Buffer.from(data.slice(EVENT_IX_TAG.length)).toString('base64'),
      )
      if (event === null || event.name !== 'IncidentSettled') continue
      const fields = event.data as Record<string, unknown>
      const status = statusOf(fields.status)
      if (status === null) continue
      found.push({
        incident: (fields.incident as PublicKey).toBase58(),
        status,
        payout: String(fields.payout),
        shortfall: String(fields.shortfall),
        via: 'attest',
      })
      continue
    }

    if (
      startsWith(data, LEGACY_RESOLVE.discriminator) &&
      data.length === LEGACY_RESOLVE.discriminator.length
    ) {
      const incident = instruction.accounts[LEGACY_RESOLVE.incidentAccountIndex]
      // `resolve` had one outcome: it paid, or the transaction failed and never got here.
      if (incident !== undefined) {
        found.push({ incident, status: 'paid_out', payout: null, shortfall: null, via: 'resolve' })
      }
    }
  }

  return found
}
