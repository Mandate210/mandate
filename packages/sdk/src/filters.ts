// `getProgramAccounts` filters, derived from the IDL rather than written down (T071).
//
// A sweeper has to list incidents that are still open, and the cheap way to ask an RPC
// that is a `memcmp` on the one byte `Incident.status` occupies. That byte's offset is
// a consequence of every field declared before it, so hand-writing it would mean a
// number that goes quietly wrong the next time the account gains a field — and wrong
// here does not fail loudly: it returns a plausible, empty result, and the sweeper
// reports «nothing to close» forever while capital stays frozen.
//
// So the offset is computed from the same IDL the client decodes with. An account
// layout this module cannot size throws, which surfaces as a failing test rather than
// as a filter that matches nothing.

import type { GetProgramAccountsFilter } from '@solana/web3.js'
import rawIdl from './idl/drain_cover.json'

/** Anchor prefixes every account with an eight-byte discriminator. */
export const ACCOUNT_DISCRIMINATOR_LENGTH = 8

type IdlType = unknown

const PRIMITIVE_SIZES: Record<string, number> = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  pubkey: 32,
}

const definedType = (name: string): { kind: string; variants?: unknown[] } | undefined => {
  const found = rawIdl.types.find((type) => type.name === name)
  return found?.type as { kind: string; variants?: unknown[] } | undefined
}

/**
 * Bytes a field of this type occupies in a Borsh-encoded account.
 *
 * Fixed-size types only, which is all that stands before `Incident.status`. Anything
 * variable — a `string`, a `vec`, an `option` — has no offset worth computing after it,
 * so it throws rather than returning a guess.
 */
const sizeOf = (type: IdlType): number => {
  if (typeof type === 'string') {
    const size = PRIMITIVE_SIZES[type]
    if (size === undefined) throw new Error(`cannot size IDL type: ${type}`)
    return size
  }

  if (typeof type === 'object' && type !== null) {
    const record = type as Record<string, unknown>

    if (Array.isArray(record.array)) {
      const [element, length] = record.array as [IdlType, number]
      if (typeof length !== 'number') throw new Error('cannot size a non-fixed array')
      return sizeOf(element) * length
    }

    if (typeof record.defined === 'object' && record.defined !== null) {
      const { name } = record.defined as { name: string }
      const resolved = definedType(name)
      if (resolved === undefined) throw new Error(`unknown defined type: ${name}`)
      // A C-like enum is one byte: the variant index, and nothing else. One carrying
      // fields is not fixed-size and has no business standing before a filtered field.
      if (resolved.kind === 'enum') {
        const variants = (resolved.variants ?? []) as Record<string, unknown>[]
        if (variants.every((variant) => variant.fields === undefined)) return 1
        throw new Error(`enum ${name} carries fields and has no fixed size`)
      }
      if (resolved.kind === 'struct') {
        return fieldsSize(resolved as unknown as { fields: { type: IdlType }[] })
      }
      throw new Error(`cannot size defined type ${name} of kind ${resolved.kind}`)
    }
  }

  throw new Error(`cannot size IDL type: ${JSON.stringify(type)}`)
}

const fieldsSize = ({ fields }: { fields: { type: IdlType }[] }): number =>
  fields.reduce((total, field) => total + sizeOf(field.type), 0)

/**
 * Where a field starts inside an account, discriminator included.
 *
 * Throws on an unknown account or field, because every caller wants an address into a
 * layout and a wrong one is indistinguishable from an empty result.
 */
export const accountFieldOffset = (account: string, field: string): number => {
  const found = rawIdl.types.find((type) => type.name === account)
  if (found === undefined) throw new Error(`no such account in the IDL: ${account}`)

  const { fields } = found.type as { fields?: { name: string; type: IdlType }[] }
  if (fields === undefined) throw new Error(`${account} is not a struct`)

  let offset = ACCOUNT_DISCRIMINATOR_LENGTH
  for (const current of fields) {
    if (current.name === field) return offset
    offset += sizeOf(current.type)
  }
  throw new Error(`${account} has no field ${field}`)
}

/**
 * `IncidentStatus`, in declaration order — Borsh writes the variant index.
 *
 * Read off the IDL for the same reason the offset is: a variant inserted ahead of
 * `Open` would shift every index, and a filter built on a stale number silently
 * matches the wrong status.
 */
const incidentStatusIndex = (variant: string): number => {
  const resolved = definedType('IncidentStatus')
  const variants = (resolved?.variants ?? []) as { name: string }[]
  const index = variants.findIndex((candidate) => candidate.name === variant)
  if (index === -1) throw new Error(`IncidentStatus has no variant ${variant}`)
  return index
}

/** Base58 of a single byte. `memcmp` takes its needle base58-encoded. */
const base58Byte = (value: number): string => {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  if (value === 0) return '1'
  let rest = value
  let encoded = ''
  while (rest > 0) {
    encoded = (ALPHABET[rest % 58] as string) + encoded
    rest = Math.floor(rest / 58)
  }
  return encoded
}

/**
 * Incidents still taking attestations, and nothing else.
 *
 * The filter is what keeps the sweep affordable: on devnet the program holds 77
 * incidents and will hold thousands, while the number that are open at any moment is
 * the handful a sweeper has work for. An unfiltered `all()` was measured hanging
 * against a public RPC (T070); this returns the same answer for one memcmp.
 */
export const openIncidentsFilter = (): GetProgramAccountsFilter[] => [
  {
    memcmp: {
      offset: accountFieldOffset('Incident', 'status'),
      bytes: base58Byte(incidentStatusIndex('Open')),
    },
  },
]
