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
    /// Shares requested for withdrawal — a count of shares, not an amount of the
    /// asset, because the price is taken when the withdrawal completes (T033).
    /// They stay in `shares` meanwhile and keep both earning and bearing losses:
    /// the capital behind them is still backing policies. Zero means no request.
    pub pending_withdraw: u64,
    /// When the requested withdrawal may be completed (FR-019). Meaningless while
    /// `pending_withdraw` is zero.
    pub unlock_ts: i64,
}
