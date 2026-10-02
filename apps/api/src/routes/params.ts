// Path parameters shared by the routes, validated before any query (docs/PLAN.md → Безпека).

import { zValidator } from '@hono/zod-validator'
import { pubkeySchema } from '@mandate/shared'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { fail } from '../errors'

/**
 * An account address: base58 that decodes to exactly 32 bytes. Not `isOnCurve` — a
 * protocol's address is a PDA, which is off the curve by construction.
 */
const isAddress = (text: string): boolean => {
  try {
    new PublicKey(text)
    return true
  } catch {
    return false
  }
}

export const addressSchema = pubkeySchema.refine(isAddress, {
  message: 'Expected a 32-byte base58 address',
})

/** `:protocol`, answering 400 in the contract's error format. */
export const protocolParam = zValidator(
  'param',
  z.object({ protocol: addressSchema }),
  (result, c) => {
    if (!result.success) {
      return fail(c, 400, 'INVALID_INPUT', 'Invalid protocol address', {
        issues: result.error.issues,
      })
    }
  },
)
