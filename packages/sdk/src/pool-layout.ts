// Two lengths of `Pool` exist on a cluster that predates T082: the program appended
// the run of blocked time to the end of the layout, and an old pool stays at the old
// length until `migrate_pool` grows it. Readers that meet both — the SC-007 replay,
// the migration script — take the lengths from here.

/** Discriminator plus the layout as it was before T082. */
export const LEGACY_POOL_SIZE = 8 + 61

/** Discriminator plus the current layout. */
export const POOL_SIZE = 8 + 77

/** The fields T082 appended, in layout order — a legacy pool is the current one without them. */
export const POOL_FIELDS_SINCE_T082 = ['blocked_since', 'unblocked_at'] as const

/**
 * A legacy pool's bytes, padded to the current length so the current coder reads
 * the fields it has. The padding decodes as zeros; a caller must not read the
 * T082 fields of a padded pool as a record of anything.
 */
export const padLegacyPool = (data: Buffer): Buffer =>
  data.length === LEGACY_POOL_SIZE
    ? Buffer.concat([data, Buffer.alloc(POOL_SIZE - LEGACY_POOL_SIZE)])
    : data
