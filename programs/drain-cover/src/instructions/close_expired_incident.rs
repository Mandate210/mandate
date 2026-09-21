use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::DrainCoverError;
use crate::instructions::resolve::quorum_threshold;
use crate::state::{
    trigger_seeds, Config, Incident, IncidentStatus, Policy, Pool, Protocol, CONFIG_SEED,
    INCIDENT_SEED, POOL_SEED,
};

#[derive(Accounts)]
pub struct CloseExpiredIncident<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = pool)]
    pub protocol: Account<'info, Protocol>,
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// Read, never written: closing without a payout leaves the cover exactly as it
    /// was. It is here because whether `resolve` could still pay this incident
    /// depends on it (FR-016).
    pub policy: Account<'info, Policy>,
    /// Bound to `protocol` by seeds derived from its own stored signature, as in
    /// `resolve`: nothing but the address names the incident, which is what lets a
    /// sweeper close whatever it finds by listing accounts (T071).
    #[account(
        mut,
        seeds = [
            INCIDENT_SEED,
            protocol.key().as_ref(),
            trigger_seeds(&incident.trigger_sig)[0],
            trigger_seeds(&incident.trigger_sig)[1],
        ],
        bump,
        has_one = policy,
    )]
    pub incident: Account<'info, Incident>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    /// Only paid when the quorum confirmed the incident, but required in both cases:
    /// an instruction whose account list depends on a tally is one a caller can get
    /// wrong, and the runtime would then refuse the transaction rather than the
    /// program refusing the operation.
    #[account(
        mut,
        token::mint = config.asset_mint,
        token::authority = incident.opener,
    )]
    pub opener_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // No signer, for the same reason as `resolve`: this is the only thing that
    // releases capital an incident froze (FR-019), so nobody may be in a position to
    // withhold it.
}

/// Whether an incident may be closed with no payout (FR-011).
///
/// Both refusals protect a path that can still pay. **The deadline is strict** —
/// `attest` counts an attestation landing in the deadline second as inside the window
/// (T019), so closing may only start the second after; reading the boundary two ways
/// would let an incident be closed while an attestation for it is still admissible.
/// **And an incident `resolve` would settle goes there instead**, so that closing can
/// never be raced ahead of a payout the quorum has already decided.
///
/// The pairing is deliberate: quorum alone does not keep an incident open, because a
/// policy that fell out of force pays nothing (FR-016) and its incident would
/// otherwise freeze the pool's capital forever.
pub fn validate_close(
    status: IncidentStatus,
    deadline: i64,
    now: i64,
    quorum_reached: bool,
    policy_in_force: bool,
) -> Result<()> {
    require!(
        status == IncidentStatus::Open,
        DrainCoverError::IncidentNotOpen
    );
    require!(now > deadline, DrainCoverError::IncidentDeadlineNotReached);
    require!(
        !(quorum_reached && policy_in_force),
        DrainCoverError::IncidentPayable
    );
    Ok(())
}

pub fn handle_close_expired_incident(ctx: Context<CloseExpiredIncident>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let needed = quorum_threshold(
        ctx.accounts.incident.set_size,
        ctx.accounts.config.quorum_bps,
    );
    let quorum_reached = ctx.accounts.incident.votes_unauthorized >= needed;

    validate_close(
        ctx.accounts.incident.status,
        ctx.accounts.incident.deadline,
        now,
        quorum_reached,
        ctx.accounts.policy.is_in_force(now),
    )?;

    let bond = ctx.accounts.incident.bond;

    // The bond follows the quorum, not the payout: it is what a claim costs to make,
    // and a claim the set confirmed was not a false one — even when the policy had
    // run out by the time anyone came to settle it. Unconfirmed, it stays where it
    // already is and becomes pool capital, which is what makes a groundless incident
    // cost its opener something.
    if quorum_reached {
        if bond > 0 {
            let protocol_key = ctx.accounts.protocol.key();
            let pool_seeds: &[&[u8]] =
                &[POOL_SEED, protocol_key.as_ref(), &[ctx.accounts.pool.bump]];

            transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.opener_token.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[pool_seeds],
                ),
                bond,
            )?;
        }
    } else {
        // No transfer: the bond has been sitting in the vault since the incident
        // opened, outside `total_assets` (T018). Counting it in is the whole of
        // forfeiting it, and it keeps the vault invariant — balance equals
        // `total_assets` plus the bonds of open incidents — true on both sides.
        ctx.accounts.pool.total_assets = ctx
            .accounts
            .pool
            .total_assets
            .checked_add(bond)
            .ok_or(DrainCoverError::MathOverflow)?;
    }

    // The reservation this incident placed on the pool's capital is released here and
    // only here (FR-019); `locked_limit` is not touched, because the policy keeps its
    // cover and nothing was paid against it.
    ctx.accounts.pool.open_incidents = ctx
        .accounts
        .pool
        .open_incidents
        .checked_sub(1)
        .ok_or(DrainCoverError::MathOverflow)?;

    // The account stays, with its tally and its trigger signature, because the trail
    // has to survive the incident (FR-011, SC-007).
    ctx.accounts.incident.status = IncidentStatus::ClosedNoPayout;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEADLINE: i64 = 1_000_000;

    #[test]
    fn closes_an_incident_the_window_left_behind() {
        assert!(validate_close(IncidentStatus::Open, DEADLINE, DEADLINE + 1, false, true).is_ok());
    }

    #[test]
    fn refuses_before_the_deadline_has_passed() {
        assert!(validate_close(IncidentStatus::Open, DEADLINE, DEADLINE - 1, false, true).is_err());
        // The deadline second belongs to the attestation window, so it is still too
        // early here — the same boundary `validate_attest` reads.
        assert!(validate_close(IncidentStatus::Open, DEADLINE, DEADLINE, false, true).is_err());
    }

    #[test]
    fn refuses_an_incident_that_resolve_would_still_pay() {
        assert!(validate_close(IncidentStatus::Open, DEADLINE, DEADLINE + 1, true, true).is_err());
    }

    #[test]
    fn closes_a_confirmed_incident_whose_policy_is_no_longer_in_force() {
        // Nothing else can end it: `resolve` refuses a policy out of force (FR-016),
        // and the capital would stay frozen for good.
        assert!(validate_close(IncidentStatus::Open, DEADLINE, DEADLINE + 1, true, false).is_ok());
    }

    #[test]
    fn refuses_an_incident_that_is_already_settled() {
        assert!(
            validate_close(IncidentStatus::PaidOut, DEADLINE, DEADLINE + 1, false, true).is_err()
        );
        assert!(validate_close(
            IncidentStatus::ClosedNoPayout,
            DEADLINE,
            DEADLINE + 1,
            false,
            true
        )
        .is_err());
    }
}
