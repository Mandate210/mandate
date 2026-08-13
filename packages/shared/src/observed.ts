import type { ObservedInstruction } from './declaration'

/**
 * Turning what an RPC returns into what the rule reads.
 *
 * The rule in `declaration.ts` takes one flat list of instructions; an RPC returns the
 * transaction's own instructions in one place and the ones reached through CPI in
 * another, keyed by the top-level instruction that caused them. This is the single
 * place that reconciles the two, so that no caller invents its own order — two
 * attestors flattening differently would report the same uncovered instruction at two
 * different indices, and the trails would not match (SC-007).
 *
 * Deliberately kept apart from the rule itself: this knows the shape an RPC speaks, and
 * the rule must not.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Base58 to bytes.
 *
 * Here because an RPC speaks base58 for the things the rule reads as bytes — inner
 * instruction data, signatures, addresses — and because three copies of this had grown
 * across the collector, the SC-002 loader and the attestor. Small enough not to be worth
 * a dependency; not small enough to be worth writing twice.
 *
 * A leading zero byte is a leading `1` and has to be carried separately: the arithmetic
 * below cannot tell one leading zero from ten.
 */
export const base58Decode = (text: string): number[] => {
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros += 1

  const bytes: number[] = []
  for (let index = zeros; index < text.length; index += 1) {
    let carry = BASE58_ALPHABET.indexOf(text[index] as string)
    if (carry === -1) throw new Error(`not base58: ${text}`)
    for (let byte = 0; byte < bytes.length; byte += 1) {
      carry += (bytes[byte] as number) * 58
      bytes[byte] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  return [...new Array<number>(zeros).fill(0), ...bytes.reverse()]
}

/** An instruction as an RPC reports it, before the depth is known. */
export interface RpcInstruction {
  programId: string
  data: number[]
  accounts: string[]
  /** Present on inner instructions from any current node; absent on the outer ones. */
  stackHeight?: number | null
}

/** `meta.innerInstructions` — the instructions one top-level instruction caused. */
export interface RpcInnerInstructionGroup {
  /** Which top-level instruction they hang off. */
  index: number
  instructions: RpcInstruction[]
}

/**
 * Execution order: each top-level instruction, then everything it caused, before the
 * next one. That is the order the runtime ran them in, and it is what makes a single
 * index enough to point at any instruction in the transaction.
 */
export const flattenInstructions = (
  instructions: readonly RpcInstruction[],
  innerInstructions: readonly RpcInnerInstructionGroup[] = [],
): ObservedInstruction[] => {
  const inner = new Map<number, RpcInstruction[]>()
  for (const group of innerInstructions) {
    inner.set(group.index, [...(inner.get(group.index) ?? []), ...group.instructions])
  }

  return instructions.flatMap((instruction, index) => [
    { ...normalise(instruction, 1) },
    // A node that predates `stackHeight` reports inner instructions without one. Depth 2
    // is then a floor, not a measurement — nothing in the rule reads it, and calling a
    // CPI instruction top-level would be the one wrong answer.
    ...(inner.get(index) ?? []).map((child) => normalise(child, child.stackHeight ?? 2)),
  ])
}

const normalise = (instruction: RpcInstruction, fallbackHeight: number): ObservedInstruction => ({
  programId: instruction.programId,
  data: instruction.data,
  accounts: instruction.accounts,
  stackHeight: instruction.stackHeight ?? fallbackHeight,
})
