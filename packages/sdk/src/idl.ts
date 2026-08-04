import type { DrainCover } from './idl/drain_cover'
import rawIdl from './idl/drain_cover.json'

export type { DrainCover }

/**
 * The IDL as Anchor's runtime wants it.
 *
 * The JSON on disk is snake_case; the generated type is the same document in
 * camelCase, and Anchor converts between them internally. So the two shapes really
 * do differ, and TypeScript is right to refuse a direct cast — hence `unknown`,
 * which is the sanctioned escape when a cast is genuinely load-bearing (CLAUDE.md
 * → Hard rules). Both files come from `anchor build`; neither is hand-edited.
 */
export const DRAIN_COVER_IDL = rawIdl as unknown as DrainCover

/** Program id as recorded in the IDL. Guarded against `declare_id!` in idl.test.ts. */
export const PROGRAM_ID_FROM_IDL: string = rawIdl.address
