use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";

/// Protocol-wide parameters. Exactly one per deployment.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Manages the attestor set while it is permissive (FR-008) and holds the
    /// service operations of US1. Not a party to any payout decision.
    pub admin: Pubkey,
    /// The single dollar-denominated asset every pool, limit, premium and payout
    /// is expressed in (FR-014). There is no second asset and no conversion, so
    /// no price oracle exists anywhere in the program.
    pub asset_mint: Pubkey,
    /// Seconds between submitting a declaration entry and it taking effect
    /// (FR-031). This delay is the whole defence against a compromised admin
    /// declaring its own operation and executing it before the team notices, so
    /// shortening it trades away the guarantee, not just latency.
    pub declaration_delay: i64,
    /// Seconds an incident collects attestations before it closes without a
    /// payout. Without a deadline a frivolous incident would freeze the pool for
    /// good, because FR-019 blocks withdrawals while one is open.
    pub attest_window: i64,
    /// Share of the active set that must classify an incident as unauthorized
    /// for the payout to fire (FR-010), in basis points.
    pub quorum_bps: u16,
    /// Bond the opener of an incident locks against frivolous openings.
    pub open_bond: u64,
    /// Stops new policies across every pool. Payouts on active policies are
    /// deliberately unaffected (FR-028).
    pub paused: bool,
}
