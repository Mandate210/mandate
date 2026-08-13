import { describe, expect, it } from 'vitest'
import { type RpcInstruction, flattenInstructions } from './observed'

const A = 'Aaaa11111111111111111111111111111111111111'
const B = 'Bbbb22222222222222222222222222222222222222'
const C = 'Cccc33333333333333333333333333333333333333'

const rpc = (programId: string, stackHeight?: number): RpcInstruction => ({
  programId,
  data: [1],
  accounts: [A],
  ...(stackHeight === undefined ? {} : { stackHeight }),
})

describe('flattenInstructions', () => {
  it('puts what an instruction caused right after it', () => {
    // Execution order, which is what makes one index enough to point at any instruction.
    const flat = flattenInstructions(
      [rpc(A), rpc(B)],
      [{ index: 0, instructions: [rpc(C, 2)] }],
    )

    expect(flat.map((instruction) => instruction.programId)).toEqual([A, C, B])
  })

  it('keeps every group, including several hanging off one instruction', () => {
    const flat = flattenInstructions(
      [rpc(A), rpc(B)],
      [
        { index: 1, instructions: [rpc(C, 2)] },
        { index: 0, instructions: [rpc(C, 2), rpc(B, 3)] },
      ],
    )

    expect(flat.map((instruction) => instruction.programId)).toEqual([A, C, B, B, C])
    expect(flat.map((instruction) => instruction.stackHeight)).toEqual([1, 2, 3, 1, 2])
  })

  it('calls the transaction’s own instructions depth one', () => {
    expect(flattenInstructions([rpc(A)])[0]?.stackHeight).toBe(1)
  })

  it('never calls an inner instruction top-level, even without a reported depth', () => {
    // A node old enough to omit `stackHeight` must not make a CPI instruction look like
    // one the transaction listed — depth is a floor here, and nothing in the rule reads
    // it, but the one wrong answer is 1.
    const flat = flattenInstructions([rpc(A)], [{ index: 0, instructions: [rpc(C)] }])

    expect(flat[1]?.stackHeight).toBe(2)
  })

  it('carries the accounts through, because the rule matches on them', () => {
    const flat = flattenInstructions(
      [{ programId: A, data: [9], accounts: [B, C] }],
      [{ index: 0, instructions: [{ programId: B, data: [8], accounts: [C], stackHeight: 2 }] }],
    )

    expect(flat).toEqual([
      { programId: A, data: [9], accounts: [B, C], stackHeight: 1 },
      { programId: B, data: [8], accounts: [C], stackHeight: 2 },
    ])
  })

  it('handles a transaction that caused nothing', () => {
    expect(flattenInstructions([rpc(A)], [])).toHaveLength(1)
    expect(flattenInstructions([])).toEqual([])
  })
})
