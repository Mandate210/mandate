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
 *
 * **A privileged address does not have to sign.** Measured on the T025 fixtures and on
 * a re-derivation from mainnet: 5 of the 17 upgrade authorities found there are
 * off-curve addresses — program-derived, so no keypair for them exists and they can
 * never appear among a transaction's signers at all. Among them are the authorities of
 * Jupiter and pump.fun. They exercise their privilege through a multisig, which signs
 * with its members' keys and passes the privileged address down as a CPI signer.
 *
 * Judging by signature alone made every such protocol permanently invisible — a
 * `not-privileged` verdict on its own program upgrade, which is the single most
 * dangerous operation this cover exists to notice. So involvement, not signature, is
 * what makes a transaction the protocol's business (`docs/PLAN.md` → «Мультисиг і
 * привілейовані PDA»).
 *
 * **The CPI signature itself is not observable, and no rule here pretends otherwise.**
 * A transaction's metadata records inner instructions without any signer flag —
 * `invoke_signed` leaves no trace a third party could read. What is observable is that
 * an instruction *takes* the privileged address, and that is what is matched on.
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

/**
 * Programs that identify their method in fewer than eight bytes, and how many they
 * use. Everything absent from this table is assumed to be Anchor's eight.
 *
 * **This is not a convenience — without it the model refuses a protocol's own program
 * upgrade.** A native instruction puts its opcode first and its arguments straight
 * after, inside the same eight bytes: the upgradeable loader's `Write` carries the
 * offset of the chunk being written, so a single deployment produces dozens of
 * instructions that are the same operation with a different key each time. Measured on
 * real mainnet transactions, not reasoned about: the fixtures behind SC-002 are program
 * deployments, and matching on all eight bytes made every chunk of them undeclared
 * (`docs/PLAN.md` → «Фікстури SC-002»).
 *
 * Every address here was checked against mainnet before being written down, and every
 * width is that program's own instruction encoding — u32 opcodes for the native
 * programs, a single byte for the token programs.
 */
export const METHOD_BYTES: Readonly<Record<string, number>> = {
  /** System */
  '11111111111111111111111111111111': 4,
  /** BPF upgradeable loader — `Write`, `DeployWithMaxDataLen`, `Upgrade`, `SetAuthority` */
  BPFLoaderUpgradeab1e11111111111111111111111: 4,
  /** Address lookup table */
  AddressLookupTab1e1111111111111111111111111: 4,
  /** SPL Token */
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 1,
  /** SPL Token-2022 */
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 1,
  /** Associated token account — `Create` carries no data at all */
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 1,
}

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
  /** The addresses the instruction takes, in order. **Which of them signed is not in
   * here and cannot be**: for an instruction reached through CPI the runtime records no
   * signer flags at all. */
  accounts: z.array(addressSchema),
  /** 1 for an instruction the transaction lists, 2 and up for one reached through CPI.
   * Carried so the trail can say where an uncovered instruction sat, and so that
   * flattening stays reversible. */
  stackHeight: z.number().int().min(1),
})

export const observedTransactionSchema = z.object({
  signature: z.string(),
  /** Cluster time of the block that carried it, in seconds — not the observer's clock. */
  blockTime: z.number().int(),
  /** Addresses that signed the transaction itself. A privileged address among them
   * puts the *whole* transaction under its authority — see `evaluateTransaction`. */
  signers: z.array(addressSchema),
  /** Every address the transaction touches, including the ones an address table
   * supplied. Absence from this list is what makes a transaction none of our business. */
  accountKeys: z.array(addressSchema),
  /** Top-level and inner instructions in execution order, flattened — each one's depth
   * is its `stackHeight`. Flat because an uncovered instruction has to be identifiable
   * by a single index in the trail the incident carries. */
  instructions: z.array(observedInstructionSchema),
})

export type DeclarationEntry = z.infer<typeof declarationEntrySchema>
export type ObservedInstruction = z.infer<typeof observedInstructionSchema>
export type ObservedTransaction = z.infer<typeof observedTransactionSchema>

export interface UncoveredInstruction {
  /** Position in the flattened `transaction.instructions`, so the trail can point at it. */
  index: number
  programId: string
  discriminator: number[]
}

export interface CoveredInstruction {
  index: number
  /** Position in the `entries` passed in — the caller holds the addresses. */
  entryIndex: number
}

/**
 * Why the transaction was the protocol's business, and therefore how much of it had to
 * be declared. Recorded in the verdict because the two branches judge different scopes,
 * and an incident's trail has to say which one it was for a third party to reproduce it
 * (SC-007).
 */
export type Basis =
  /** A privileged address signed the transaction: all of it ran under that authority. */
  | 'signature'
  /** It did not sign, but instructions inside take it — a multisig executing on its
   * behalf. Only those instructions ran under the protocol's authority. */
  | 'involvement'

export type Verdict =
  /** The privileged addresses are nowhere in it, so it is not this protocol's business. */
  | { status: 'not-privileged' }
  | { status: 'declared'; basis: Basis; covered: CoveredInstruction[] }
  /** Grounds to open an incident (FR-006). */
  | { status: 'undeclared'; basis: Basis; uncovered: UncoveredInstruction[] }

/**
 * The eight bytes an entry is matched on: the program's method identity, zero-filled
 * to a fixed width.
 *
 * For an Anchor program that is the leading eight bytes and nothing else. For a program
 * in `METHOD_BYTES` it is only that program's opcode, because the bytes after it are
 * arguments, and matching on arguments would make the same operation a different
 * operation every time it runs with different inputs.
 *
 * Arguments are outside the model by design, not by oversight: an entry says *which*
 * operation is permitted, and FR-006 keeps amounts and destinations out of the verdict
 * entirely. Taking fewer bytes for these programs makes them behave the way Anchor
 * programs already did, rather than accidentally stricter.
 */
export const methodOf = (programId: string, data: readonly number[]): number[] => {
  const width = METHOD_BYTES[programId] ?? DISCRIMINATOR_BYTES
  return Array.from({ length: DISCRIMINATOR_BYTES }, (_, index) =>
    index < width ? (data[index] ?? 0) : 0,
  )
}

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
  if (!sameBytes(entry.ixDiscriminator, methodOf(instruction.programId, instruction.data)))
    return false

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
 * **The authority exercised sets the scope of what had to be declared**, and there are
 * exactly two scopes.
 *
 * *A privileged address signed it.* Then all of it ran under that address's authority,
 * and **every instruction has to be covered** — one uncovered instruction makes the
 * transaction undeclared even if the rest were declared, otherwise a declared pause
 * could carry an undeclared transfer along with it. This is the branch the whole SC-002
 * body of evidence sits in, and it is unchanged.
 *
 * *It did not sign, but instructions inside take it.* Then the transaction is somebody
 * else's — a multisig's, executed by its members — and only the instructions that take
 * the privileged address ran under the protocol's authority. Demanding the rest would
 * open an incident on every multisig execution over the executor's own bookkeeping,
 * which is a false opening about a protocol that did nothing wrong.
 *
 * The cost of the second branch is ceremony, and it is the deliberate direction to err
 * in: a protocol governed by a multisig has to declare the multisig's own instructions
 * too, because those genuinely take its privileged address, and an undeclared one is a
 * false opening rather than a missed compromise.
 */
export interface Scope {
  basis: Basis
  /** The instructions that ran under the protocol's authority, with their positions in
   * the flattened `transaction.instructions`. */
  instructions: { instruction: ObservedInstruction; index: number }[]
}

/**
 * What the protocol has to have declared for this transaction, and why — or `null` when
 * the transaction is none of its business.
 *
 * Separate from the verdict because it is also the answer to «what would a protocol
 * running this operation have declared», which is what the SC-002 evidence is built on.
 * One definition, so the question the test asks is the question the rule answers.
 */
export const scopeOf = ({
  transaction,
  privileged,
}: {
  transaction: ObservedTransaction
  privileged: readonly string[]
}): Scope | null => {
  if (!transaction.accountKeys.some((key) => privileged.includes(key))) return null

  const active = transaction.instructions
    .map((instruction, index) => ({ instruction, index }))
    .filter(({ instruction }) => !INERT_PROGRAM_IDS.includes(instruction.programId))

  if (transaction.signers.some((signer) => privileged.includes(signer))) {
    return { basis: 'signature', instructions: active }
  }

  const touching = active.filter(({ instruction }) =>
    instruction.accounts.some((account) => privileged.includes(account)),
  )
  // Present in the account list but taken by no instruction: nothing was done with it,
  // so there is nothing to judge. Reached by a transaction that merely names the address
  // — a fee payer's lookup table, an account passed and ignored.
  if (touching.length === 0) return null

  return { basis: 'involvement', instructions: touching }
}

export const evaluateTransaction = ({
  transaction,
  entries,
  privileged,
}: {
  transaction: ObservedTransaction
  /** The protocol's declaration entries, all of them, as read from the chain. */
  entries: readonly DeclarationEntry[]
  /** `Protocol.privileged` — the addresses whose involvement makes a transaction ours. */
  privileged: readonly string[]
}): Verdict => {
  const scope = scopeOf({ transaction, privileged })
  if (scope === null) return { status: 'not-privileged' }

  const { basis } = scope
  const covered: CoveredInstruction[] = []
  const uncovered: UncoveredInstruction[] = []

  for (const { instruction, index } of scope.instructions) {
    const entryIndex = entries.findIndex((entry) =>
      entryCovers(entry, instruction, transaction.blockTime),
    )
    if (entryIndex === -1) {
      uncovered.push({
        index,
        programId: instruction.programId,
        discriminator: methodOf(instruction.programId, instruction.data),
      })
    } else {
      covered.push({ index, entryIndex })
    }
  }

  return uncovered.length > 0
    ? { status: 'undeclared', basis, uncovered }
    : { status: 'declared', basis, covered }
}
