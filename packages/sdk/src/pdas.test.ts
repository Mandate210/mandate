import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  PROGRAM_ID,
  SEEDS,
  TRIGGER_SIG_LENGTH,
  findAttestation,
  findConfig,
  findIncident,
  seqSeed,
  triggerSeeds,
} from './index'

const stateDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'programs',
  'drain-cover',
  'src',
  'state',
)

/** Every `pub const *_SEED: &[u8] = b"..."` in the program's state modules. */
const seedsDeclaredInRust = (): Map<string, string> => {
  const found = new Map<string, string>()
  for (const file of [
    'config.rs',
    'protocol.rs',
    'pool.rs',
    'underwriter_position.rs',
    'policy.rs',
    'declaration.rs',
    'attestor.rs',
    'incident.rs',
    'attestation.rs',
  ]) {
    const source = readFileSync(join(stateDir, file), 'utf8')
    for (const [, name, value] of source.matchAll(/pub const (\w+)_SEED: &\[u8\] = b"([^"]+)"/g)) {
      if (name === undefined || value === undefined) continue
      found.set(name.toLowerCase(), value)
    }
  }
  return found
}

// A seed that differs from the program's derives a perfectly valid address the
// program will never recognise: no error, no match, an account that simply is not
// there. Nothing but this test compares the two sides.
describe('PDA seeds', () => {
  const rust = seedsDeclaredInRust()

  it('finds a seed constant for every account', () => {
    expect(rust.size).toBe(9)
  })

  it('matches the program byte for byte', () => {
    expect(SEEDS.config).toBe(rust.get('config'))
    expect(SEEDS.protocol).toBe(rust.get('protocol'))
    expect(SEEDS.pool).toBe(rust.get('pool'))
    expect(SEEDS.position).toBe(rust.get('position'))
    expect(SEEDS.policy).toBe(rust.get('policy'))
    expect(SEEDS.declaration).toBe(rust.get('declaration'))
    expect(SEEDS.attestor).toBe(rust.get('attestor'))
    expect(SEEDS.incident).toBe(rust.get('incident'))
    expect(SEEDS.attestation).toBe(rust.get('attestation'))
  })
})

describe('derivation', () => {
  it('derives the config address from constant seeds', () => {
    // Constant seeds mean one config per program id — the singleton is structural,
    // not enforced by a check.
    expect(findConfig(PROGRAM_ID).equals(findConfig(PROGRAM_ID))).toBe(true)
  })

  it('encodes sequence numbers as little-endian u64', () => {
    expect([...seqSeed(1)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect([...seqSeed(256)]).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    expect(seqSeed(0)).toHaveLength(8)
  })

  it('splits a trigger signature into two seeds of the maximum length', () => {
    const sig = Uint8Array.from({ length: TRIGGER_SIG_LENGTH }, (_, i) => i)
    const [first, second] = triggerSeeds(sig)
    expect([...first]).toEqual([...sig.subarray(0, 32)])
    expect([...second]).toEqual([...sig.subarray(32)])
  })

  it('refuses anything that is not a 64-byte signature', () => {
    // A 32-byte value derives a perfectly valid address the program will never
    // recognise, so the length is checked here rather than left to the runtime.
    expect(() => triggerSeeds(new Uint8Array(32))).toThrow(RangeError)
    expect(() => triggerSeeds(new Uint8Array(65))).toThrow(RangeError)
  })

  it('addresses an incident by every byte of its trigger and by its protocol', () => {
    const protocol = PublicKey.unique()
    const sig = Uint8Array.from({ length: TRIGGER_SIG_LENGTH }, (_, i) => i)
    const address = findIncident(PROGRAM_ID, protocol, sig)

    // Same inputs, same address — that is the whole point.
    expect(findIncident(PROGRAM_ID, protocol, sig).equals(address)).toBe(true)

    // Each half of the signature lives in its own seed, so a change at either end
    // has to move the address; a derivation that dropped a half would pass the
    // first byte and fail the last.
    for (const index of [0, 31, 32, 63]) {
      const other = Uint8Array.from(sig)
      other[index] = (other[index] ?? 0) ^ 0xff
      expect(findIncident(PROGRAM_ID, protocol, other).equals(address)).toBe(false)
    }

    // One transaction touching two covered protocols is two incidents.
    expect(findIncident(PROGRAM_ID, PublicKey.unique(), sig).equals(address)).toBe(false)
  })

  it('separates attestations by both identities', () => {
    const incident = PublicKey.unique()
    const first = PublicKey.unique()
    const second = PublicKey.unique()

    expect(
      findAttestation(PROGRAM_ID, incident, first).equals(
        findAttestation(PROGRAM_ID, incident, second),
      ),
    ).toBe(false)
  })
})
