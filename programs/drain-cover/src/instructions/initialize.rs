use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::DrainCoverError;
use crate::state::{Config, CONFIG_SEED};

/// Upper bound of a basis-point share.
pub const BPS_DENOMINATOR: u16 = 10_000;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    /// Pays for the account and becomes the admin. Whoever runs this owns the
    /// service operations, so on a real deployment it is not a personal key —
    /// see R-1 on the same problem with the upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// Typed as a mint so a wrong account cannot be installed as the settlement
    /// asset. Decimals are deliberately not constrained: amounts are stored in
    /// this asset's base units and never converted (FR-014).
    pub asset_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

/// Rejects parameters that would leave the system unable to do its job.
///
/// A zero quorum is the one that matters: the payout fires when the unauthorized
/// share reaches the quorum (FR-010), so at zero the very first attestation — or
/// none at all — would clear the bar. The delays matter for the same reason in
/// slower motion: without a declaration delay, a compromised admin declares its
/// own operation and executes it in the same breath (FR-031), and without an
/// attestation window an incident never closes and the pool stays frozen
/// (FR-019).
pub fn validate_params(declaration_delay: i64, attest_window: i64, quorum_bps: u16) -> Result<()> {
    require!(
        quorum_bps > 0 && quorum_bps <= BPS_DENOMINATOR,
        DrainCoverError::InvalidQuorum
    );
    require!(declaration_delay > 0, DrainCoverError::InvalidDuration);
    require!(attest_window > 0, DrainCoverError::InvalidDuration);
    Ok(())
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    declaration_delay: i64,
    attest_window: i64,
    quorum_bps: u16,
    open_bond: u64,
) -> Result<()> {
    validate_params(declaration_delay, attest_window, quorum_bps)?;

    ctx.accounts.config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        declaration_delay,
        attest_window,
        quorum_bps,
        attestor_count: 0,
        open_bond,
        paused: false,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;

    #[test]
    fn accepts_sane_parameters() {
        assert!(validate_params(DAY, DAY, 6_000).is_ok());
        // Unanimity is a legitimate choice, so the top of the range is inclusive.
        assert!(validate_params(1, 1, BPS_DENOMINATOR).is_ok());
    }

    #[test]
    fn rejects_a_quorum_of_zero() {
        assert!(validate_params(DAY, DAY, 0).is_err());
    }

    #[test]
    fn rejects_a_quorum_above_one_hundred_percent() {
        assert!(validate_params(DAY, DAY, BPS_DENOMINATOR + 1).is_err());
    }

    #[test]
    fn rejects_non_positive_durations() {
        assert!(validate_params(0, DAY, 6_000).is_err());
        assert!(validate_params(-1, DAY, 6_000).is_err());
        assert!(validate_params(DAY, 0, 6_000).is_err());
        assert!(validate_params(DAY, -1, 6_000).is_err());
    }
}
