/**
 * The program this interface is about, on the cluster it runs on — the one address on
 * a demo page that is real. Kept in step with `declare_id!` by
 * `tests/config-consistency.test.ts`: a redeploy moved it once and this link kept
 * pointing at the old program.
 */
export const PROGRAM_ID = 'HMtvDKR9i4WKxfMfC7fGXXiiReh3APGoNsiCcrbCzMHk'

const CLUSTER = 'devnet'

/** An account or a transaction on the explorer, on the cluster the program runs on. */
export const explorerUrl = (kind: 'address' | 'tx', id: string): string =>
  `https://explorer.solana.com/${kind}/${id}?cluster=${CLUSTER}`

export const PROGRAM_EXPLORER = explorerUrl('address', PROGRAM_ID)
