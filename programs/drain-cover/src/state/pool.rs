use anchor_lang::prelude::*;

pub const POOL_SEED: &[u8] = b"pool";

/// Capital underwriting exactly one covered protocol, and the only source of its
/// payouts (FR-002). Isolation is structural: each pool owns its own vault, so
/// there is no shared store to draw from by mistake.
///
/// **A share is a claim on a fraction of `total_assets`, not on a fixed amount.**
/// Everything that moves capital moves the value of a share with it: a premium
/// raises it (FR-018), a payout lowers it (FR-015). That is what makes both
/// proportional to holding and to time in the pool without a second ledger —
/// nothing accrued before a deposit is claimable, because the deposit was priced
/// against a pool that already held it.
///
/// An earlier design carried premiums separately in an `acc_premium_per_share`
/// accumulator while `issue_policy` also credited them to `total_assets`, which
/// counted every premium twice: the pool would have owed more than it held. The
/// accumulator cannot be the answer on its own either — a pool that pays claims
/// has to be able to lose principal, and a share priced at a fixed amount has
/// nowhere to record that loss.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Token account holding the capital, owned by this PDA.
    pub vault: Pubkey,
    /// What the pool owns, as the program recorded it — never the vault balance.
    /// A stray transfer into the vault must not become backing for a policy, and
    /// open incidents' bonds sit in the vault outside this number (T018).
    pub total_assets: u64,
    pub total_shares: u64,
    /// Sum of the limits of active policies. Capital below this line cannot be
    /// withdrawn (FR-020).
    pub locked_limit: u64,
    /// Withdrawals are blocked while this is non-zero (FR-019).
    pub open_incidents: u32,
    /// Stored rather than recomputed: the pool signs every transfer out of its
    /// vault, and rederiving the bump on each of those costs compute for a value
    /// that never changes.
    pub bump: u8,
}
