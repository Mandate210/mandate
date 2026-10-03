/**
 * The program this interface is about, on the cluster it runs on — the one address on
 * a demo page that is real. Kept in step with `declare_id!` by
 * `tests/config-consistency.test.ts`: a redeploy moved it once and this link kept
 * pointing at the old program.
 */
export const PROGRAM_ID = 'HMtvDKR9i4WKxfMfC7fGXXiiReh3APGoNsiCcrbCzMHk'

export const PROGRAM_EXPLORER = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`
