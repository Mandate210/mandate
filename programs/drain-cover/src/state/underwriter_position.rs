use anchor_lang::prelude::*;

pub const POSITION_SEED: &[u8] = b"position";

/// One underwriter's stake in one pool (FR-017). The owner is in the PDA seeds,
/// so it is not repeated as a field.
#[account]
#[derive(InitSpace)]
pub struct UnderwriterPosition {
    pub shares: u64,
    /// Value of `Pool::acc_premium_per_share` the last time premiums were settled
    /// for this position.
    pub premium_checkpoint: u128,
    /// Amount requested for withdrawal and no longer earning premiums.
    pub pending_withdraw: u64,
    /// When the requested withdrawal may be completed (FR-019).
    pub unlock_ts: i64,
}
