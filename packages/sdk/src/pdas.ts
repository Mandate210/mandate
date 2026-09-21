import { BN } from '@coral-xyz/anchor'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

/**
 * Seeds, byte for byte as the program declares them. Every string here has a
 * counterpart in `programs/drain-cover/src/state/*.rs`, and nothing but
 * `pdas.test.ts` cross-checks the two: a mismatch derives a valid-looking address
 * that the program will never recognise.
 */
export const SEEDS = {
  config: 'config',
  protocol: 'protocol',
  pool: 'pool',
  position: 'position',
  policy: 'policy',
  declaration: 'decl',
  attestor: 'attestor',
  incident: 'incident',
  attestation: 'attest',
} as const

const seed = (value: string): Buffer => Buffer.from(value)

/** Sequence numbers are u64 in the program, little-endian in the seed. */
export const seqSeed = (seq: number | bigint): Buffer =>
  new BN(seq.toString()).toArrayLike(Buffer, 'le', 8)

const derive = (programId: PublicKey, seeds: Buffer[]): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0]

export const findConfig = (programId: PublicKey): PublicKey =>
  derive(programId, [seed(SEEDS.config)])

export const findProtocol = (programId: PublicKey, protocolId: PublicKey): PublicKey =>
  derive(programId, [seed(SEEDS.protocol), protocolId.toBuffer()])

export const findPool = (programId: PublicKey, protocol: PublicKey): PublicKey =>
  derive(programId, [seed(SEEDS.pool), protocol.toBuffer()])

export const findPosition = (programId: PublicKey, pool: PublicKey, owner: PublicKey): PublicKey =>
  derive(programId, [seed(SEEDS.position), pool.toBuffer(), owner.toBuffer()])

export const findPolicy = (
  programId: PublicKey,
  protocol: PublicKey,
  seq: number | bigint,
): PublicKey => derive(programId, [seed(SEEDS.policy), protocol.toBuffer(), seqSeed(seq)])

export const findDeclarationEntry = (
  programId: PublicKey,
  protocol: PublicKey,
  seq: number | bigint,
): PublicKey => derive(programId, [seed(SEEDS.declaration), protocol.toBuffer(), seqSeed(seq)])

export const findAttestor = (programId: PublicKey, authority: PublicKey): PublicKey =>
  derive(programId, [seed(SEEDS.attestor), authority.toBuffer()])

/** A transaction signature is 64 bytes; anything else is not one. */
export const TRIGGER_SIG_LENGTH = 64

/**
 * The two seeds a trigger signature contributes to an incident's address —
 * `trigger_seeds` in `programs/drain-cover/src/state/incident.rs`, byte for byte.
 *
 * A seed is capped at 32 bytes, so the signature goes in as two halves rather than
 * as a hash: the address follows from the signature and the protocol alone, which is
 * what lets anyone with an explorer reproduce it (SC-007).
 */
export const triggerSeeds = (triggerSig: ArrayLike<number>): [Buffer, Buffer] => {
  if (triggerSig.length !== TRIGGER_SIG_LENGTH) {
    throw new RangeError(
      `a trigger signature is ${TRIGGER_SIG_LENGTH} bytes, got ${triggerSig.length}`,
    )
  }
  // `ArrayLike` because a signature arrives as `number[]` from the IDL client and as
  // `Uint8Array` from a base58 decoder, and neither side should have to convert.
  const bytes = Buffer.from(Uint8Array.from(triggerSig))
  return [bytes.subarray(0, 32), bytes.subarray(32)]
}

/**
 * An incident is addressed by the transaction that caused it, so one event on one
 * protocol has exactly one possible incident address — «one incident per event» is
 * held by the runtime, not by clients agreeing to check first (T070).
 */
export const findIncident = (
  programId: PublicKey,
  protocol: PublicKey,
  triggerSig: ArrayLike<number>,
): PublicKey =>
  derive(programId, [seed(SEEDS.incident), protocol.toBuffer(), ...triggerSeeds(triggerSig)])

/**
 * A pool's vault: the associated token account of the pool PDA.
 *
 * Not derived from our own seeds, so no program instruction can resolve it for a
 * caller — every client has to pass it. `allowOwnerOffCurve` is on because the owner
 * is a PDA, which by construction is not a curve point.
 */
export const findVault = (assetMint: PublicKey, pool: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(assetMint, pool, true)

/**
 * Both identities live in the seeds, which is what makes "one attestor, one
 * attestation" (FR-009) a runtime guarantee rather than a check in our code.
 */
export const findAttestation = (
  programId: PublicKey,
  incident: PublicKey,
  attestor: PublicKey,
): PublicKey =>
  derive(programId, [seed(SEEDS.attestation), incident.toBuffer(), attestor.toBuffer()])
