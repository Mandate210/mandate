use anchor_lang::prelude::*;

pub const POOL_SEED: &[u8] = b"pool";

/// Scaling factor for the premium accumulator. Premiums are divided by the share
/// supply, so the quotient has to be carried at higher precision than the amounts
/// themselves or SC-010 (0.1% over 50 operations) is unreachable.
pub const PREMIUM_ACC_SCALE: u128 = 1_000_000_000_000;

/// Capital underwriting exactly one covered protocol, and the only source of its
/// payouts (FR-002). Isolation is structural: each pool owns its own vault, so
/// there is no shared store to draw from by mistake.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Token account holding the capital, owned by this PDA.
    pub vault: Pubkey,
    pub total_assets: u64,
    pub total_shares: u64,
    /// Sum of the limits of active policies. Capital below this line cannot be
    /// withdrawn (FR-020).
    pub locked_limit: u64,
    /// Withdrawals are blocked while this is non-zero (FR-019).
    pub open_incidents: u32,
    /// Premium per share, scaled by `PREMIUM_ACC_SCALE`. An underwriter earns
    /// the difference against its own checkpoint, which makes time-in-pool
    /// implicit: nothing accrued before the deposit is claimable (FR-018).
    pub acc_premium_per_share: u128,
    /// Stored rather than recomputed: the pool signs every transfer out of its
    /// vault, and rederiving the bump on each of those costs compute for a value
    /// that never changes.
    pub bump: u8,
}
