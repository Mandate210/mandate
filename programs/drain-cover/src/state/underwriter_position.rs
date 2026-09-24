use anchor_lang::prelude::*;

pub const POSITION_SEED: &[u8] = b"position";

/// One underwriter's stake in one pool (FR-017). The owner is in the PDA seeds,
/// so it is not repeated as a field.
///
/// Shares, and nothing about premiums: what a position has earned is the
/// difference between what its shares are worth now and what they cost, and both
/// sides of that live in `Pool` (see the note on share price there).
#[account]
#[derive(InitSpace)]
pub struct UnderwriterPosition {
    pub shares: u64,
    /// Amount requested for withdrawal. Set by T032, which also decides what it
    /// stops participating in once requested.
    pub pending_withdraw: u64,
    /// When the requested withdrawal may be completed (FR-019).
    pub unlock_ts: i64,
}
