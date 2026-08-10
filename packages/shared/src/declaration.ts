import { z } from 'zod'

/**
 * Matching a privileged transaction against a protocol's declaration (FR-006).
 *
 * This is the one place the decision is made. Every attestor reads the same chain
 * state and runs this function, so two attestors can only disagree by running
 * different versions of it — which is why it is pure, has no configuration, and
 * takes its clock from the transaction rather than from the machine it runs on.
 *
 * **Equality, not judgement.** A transaction is declared when its instructions match
 * an entry by program id and instruction discriminator — machine equality
 * (`docs/PLAN.md` → R-2). Nothing about how the transaction *looks* enters into it:
 * no amounts, no destinations, no heuristics. FR-006 says so in as many words, and it
 * is what makes the verdict reproducible by a third party from the public trail
 * (SC-007).
 *
 * **What that leaves open, on purpose.** An entry says *which* operation is permitted,
 * not where it may send funds — so a declared fund-moving instruction is declared
 * whoever receives the money. The answer to that is not a cleverer rule here: it is
 * FR-035 (a fund-moving operation is only ever declared for a bounded window) and
 * FR-031 (the window takes effect only after a delay), which together keep a stolen
 * key from declaring its way out.
 */

/** Anchor writes eight bytes of method identity at the head of instruction data. */
export const DISCRIMINATOR_BYTES = 8

/**
 * Programs whose instructions carry no authority over a protocol's funds or
 * permissions, and which therefore need no declaration.
 *
 * Deliberately a constant and not a parameter: a list an operator could tune is a list
 * on which two attestors reach two verdicts. It is also deliberately short — anything
 * added here stops being watched, so an addition is a decision to be made once, in the
 * open, with the fixtures of T025 as the evidence.
 */
export const INERT_PROGRAM_IDS: readonly string[] = ['ComputeBudget111111111111111111111111111111']

/** Base58 as it comes off the chain. Compared for equality here, never decoded. */
export const addressSchema = z.string().min(32).max(44)

const byteSchema = z.number().int().min(0).max(255)

export const discriminatorSchema = z.array(byteSchema).length(DISCRIMINATOR_BYTES)

/** `DeclarationEntry`, exactly as the program stores it. */
export const declarationEntrySchema = z.object({
  programId: addressSchema,
  ixDiscriminator: discriminatorSchema,
  notBefore: z.number().int(),
  /** `null` is a permanent entry — legal only when `movesFunds` is false (FR-035). */
  notAfter: z.number().int().nullable(),
  movesFunds: z.boolean(),
  submittedAt: z.number().int(),
  /** `submittedAt + declarationDelay` (FR-031). */
  effectiveAt: z.number().int(),
  /** Set by a revocation, and effective from that second on (FR-032). */
  revokedAt: z.number().int().nullable(),
})

export const observedInstructionSchema = z.object({
  programId: addressSchema,
  /** Raw instruction data. Only its leading bytes are read. */
  data: z.array(byteSchema),
})

export const observedTransactionSchema = z.object({
  signature: z.string(),
  /** Cluster time of the block that carried it, in seconds — not the observer's clock. */
  blockTime: z.number().int(),
  /** Addresses that signed. A transaction is the protocol's business only if one of
   * its privileged addresses is among them. */
  signers: z.array(addressSchema),
  instructions: z.array(observedInstructionSchema),
})

export type DeclarationEntry = z.infer<typeof declarationEntrySchema>
export type ObservedInstruction = z.infer<typeof observedInstructionSchema>
export type ObservedTransaction = z.infer<typeof observedTransactionSchema>

export interface UncoveredInstruction {
  /** Position in `transaction.instructions`, so the trail can point at it. */
  index: number
  programId: string
  discriminator: number[]
}

export interface CoveredInstruction {
  index: number
  /** Position in the `entries` passed in — the caller holds the addresses. */
  entryIndex: number
}

export type Verdict =
  /** No privileged address signed it, so it is not this protocol's business at all. */
  | { status: 'not-privileged' }
  | { status: 'declared'; covered: CoveredInstruction[] }
  /** Grounds to open an incident (FR-006). */
  | { status: 'undeclared'; uncovered: UncoveredInstruction[] }

/**
 * The eight bytes an entry is matched on, zero-filled if the data is shorter.
 *
 * For an Anchor program these are the method's identity and nothing else, which is the
 * case the model is built for. For a native program — SPL Token, System — the first
 * byte is the opcode and the rest are already arguments, so an entry declaring one of
 * those pins those leading argument bytes too. That makes such an entry *narrower*
 * than its author may expect, never wider: it can withhold cover from an operation the
 * protocol meant to declare, and it can never extend cover to one it did not.
 */
export const discriminatorOf = (data: readonly number[]): number[] =>
  Array.from({ length: DISCRIMINATOR_BYTES }, (_, index) => data[index] ?? 0)

const sameBytes = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/**
 * Whether one entry covers one instruction executed at `at`.
 *
 * Every comparison is against the entry as it stood **at the moment of the
 * transaction**, never as it stands now: an operation performed while an entry was
 * effective stays declared even after the entry is revoked (`docs/PLAN.md` →
 * «Скасування негайне, але не зворотне»). Otherwise a protocol could revoke its way
 * into an incident against itself, and an attestor checking an hour later would reach
 * a different verdict than one checking now.
 *
 * The window ends are inclusive. A maintenance window declared to 12:00:00 covers an
 * operation at exactly 12:00:00 — the boundary second belongs to the protocol that
 * declared it, and reading it the other way would make an incident out of a
 * punctual operation.
 */
export const entryCovers = (
  entry: DeclarationEntry,
  instruction: ObservedInstruction,
  at: number,
): boolean => {
  if (entry.programId !== instruction.programId) return false
  if (!sameBytes(entry.ixDiscriminator, discriminatorOf(instruction.data))) return false

  // FR-031: an operation executed before its entry took effect is undeclared, however
  // long the entry has existed.
  if (at < entry.effectiveAt) return false
  if (at < entry.notBefore) return false
  if (entry.notAfter !== null && at > entry.notAfter) return false
  // FR-032: revocation is immediate, and only forward.
  if (entry.revokedAt !== null && at >= entry.revokedAt) return false

  return true
}

/**
 * The verdict on one observed transaction.
 *
 * **Every instruction has to be covered.** A transaction signed by a privileged key
 * executes everything in it under that key's authority, so one uncovered instruction
 * makes the transaction undeclared even if the rest were declared — otherwise a
 * declared pause could carry an undeclared transfer along with it.
 */
export const evaluateTransaction = ({
  transaction,
  entries,
  privileged,
}: {
  transaction: ObservedTransaction
  /** The protocol's declaration entries, all of them, as read from the chain. */
  entries: readonly DeclarationEntry[]
  /** `Protocol.privileged` — the addresses whose signature makes a transaction ours. */
  privileged: readonly string[]
}): Verdict => {
  const isPrivileged = transaction.signers.some((signer) => privileged.includes(signer))
  if (!isPrivileged) return { status: 'not-privileged' }

  const covered: CoveredInstruction[] = []
  const uncovered: UncoveredInstruction[] = []

  for (const [index, instruction] of transaction.instructions.entries()) {
    if (INERT_PROGRAM_IDS.includes(instruction.programId)) continue

    const entryIndex = entries.findIndex((entry) =>
      entryCovers(entry, instruction, transaction.blockTime),
    )
    if (entryIndex === -1) {
      uncovered.push({
        index,
        programId: instruction.programId,
        discriminator: discriminatorOf(instruction.data),
      })
    } else {
      covered.push({ index, entryIndex })
    }
  }

  return uncovered.length > 0 ? { status: 'undeclared', uncovered } : { status: 'declared', covered }
}
