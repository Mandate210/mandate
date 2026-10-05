/**
 * How the pages write what the contract carries (T054). Pure, and nothing here adds a
 * fact: an amount is the account's base units with the decimal point put where the
 * mint puts it — never rounded, so a figure on a page matches an explorer to the last
 * unit (SC-007).
 */
import type { DeclarationEntryResponse, EntryState } from '@mandate/shared'

/** The one asset pools hold (FR-014). */
export const ASSET = 'USDC'

/** `Abcd…wxyz` — enough to recognise an address, the way explorers abbreviate. */
export const short = (address: string): string => `${address.slice(0, 4)}…${address.slice(-4)}`

/**
 * A `u64` in base units as a decimal number: grouped whole part, fraction without
 * trailing zeros. In bigint throughout — a JSON number is exact only to 2^53.
 */
export const decimal = (baseUnits: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals)
  const whole = (baseUnits / scale).toLocaleString('en-US')
  const fraction = (baseUnits % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/** An amount field of the contract, with its unit. */
export const amount = (baseUnits: string | bigint, decimals: number): string =>
  `${decimal(BigInt(baseUnits), decimals)} ${ASSET}`

/**
 * Capital no policy has reserved — what a new policy's limit can come from (FR-027).
 * Floored at zero: the contract leaves utilization uncapped so an over-promised pool
 * shows, and that pool has nothing free, not a negative amount.
 */
export const freeCapital = (totalAssets: string, lockedLimit: string): bigint => {
  const free = BigInt(totalAssets) - BigInt(lockedLimit)
  return free > 0n ? free : 0n
}

/** Basis points as a percentage, exactly: 999 → `9.99%`, 1050 → `10.5%`, 0 → `0%`. */
export const percent = (bps: number): string => {
  const hundredths = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '')
  return `${Math.floor(bps / 100)}${hundredths === '' ? '' : `.${hundredths}`}%`
}

const iso = (ts: number): string => new Date(ts * 1000).toISOString()

/** `2026-10-03` */
export const utcDay = (ts: number): string => iso(ts).slice(0, 10)

/** `2026-10-03 14:05` — the caller says UTC once, where it reads best. */
export const utcMinute = (ts: number): string => iso(ts).slice(0, 16).replace('T', ' ')

/** `2026-10-03 14:05:09 UTC` */
export const utcSecond = (ts: number): string => `${iso(ts).slice(0, 19).replace('T', ' ')} UTC`

/* ---------------------------------------------------------------- */
/* Declarations                                                      */
/* ---------------------------------------------------------------- */

export const ENTRY_STATE: Record<EntryState, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  effective: 'Effective',
  expired: 'Expired',
  revoked: 'Revoked',
}

/** The instruction's name when its program publishes one; otherwise what the chain holds. */
export const operationOf = (entry: DeclarationEntryResponse): string =>
  entry.instruction?.name ?? `${short(entry.program_id)} · ${entry.ix_discriminator}`

export const windowOf = (entry: DeclarationEntryResponse): string =>
  entry.not_after === null
    ? `from ${utcMinute(entry.not_before)} UTC, permanent`
    : `${utcMinute(entry.not_before)} – ${utcMinute(entry.not_after)} UTC`
