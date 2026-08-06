use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::DrainCoverError;
use crate::state::{
    Config, Incident, IncidentStatus, Policy, Pool, Protocol, CONFIG_SEED, INCIDENT_SEED,
    POLICY_SEED, POOL_SEED,
};

#[derive(Accounts)]
#[instruction(policy_seq: u64)]
pub struct OpenIncident<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// Anyone may open an incident — that is what the bond is for. In practice it is
    /// an attestor that has just seen an undeclared privileged transaction (T027),
    /// but nothing in the program depends on who noticed.
    #[account(mut)]
    pub opener: Signer<'info>,
    #[account(mut, has_one = pool)]
    pub protocol: Account<'info, Protocol>,
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// Bound to this protocol by its seeds: an incident on someone else's policy
    /// would lock capital in a pool that never underwrote it.
    #[account(
        seeds = [POLICY_SEED, protocol.key().as_ref(), &policy_seq.to_le_bytes()],
        bump,
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        init,
        payer = opener,
        space = 8 + Incident::INIT_SPACE,
        seeds = [
            INCIDENT_SEED,
            protocol.key().as_ref(),
            &protocol.next_incident_seq.to_le_bytes(),
        ],
        bump,
    )]
    pub incident: Account<'info, Incident>,
    #[account(mut, token::mint = config.asset_mint, token::authority = opener)]
    pub bond_source: Account<'info, TokenAccount>,
    /// The bond rests in the pool's vault until the incident settles: refunded from
    /// there if the quorum confirms, forfeited to the pool if it does not. It is
    /// deliberately **not** added to `Pool::total_assets` — capital that may go back
    /// to the opener must not count as capacity to underwrite. The vault therefore
    /// holds `total_assets` plus the bonds of open incidents.
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Conditions under which an incident could not lead anywhere, and the deadline it
/// gets if it can.
///
/// **An empty attestor set is the dangerous one.** Quorum is a share of the set
/// (FR-010), and a share of nothing is nothing — an incident opened against an empty
/// set would clear its bar with no attestations at all. Refused here rather than at
/// resolve, where the bond would already have been paid and the capital already
/// frozen.
///
/// **A policy that is not in force cannot pay** (FR-016), so opening against one only
/// freezes pool capital and burns a bond.
pub fn validate_open(
    attestor_count: u16,
    policy_in_force: bool,
    opened_at: i64,
    attest_window: i64,
) -> Result<i64> {
    require!(attestor_count > 0, DrainCoverError::AttestorSetEmpty);
    require!(policy_in_force, DrainCoverError::PolicyNotActive);

    opened_at
        .checked_add(attest_window)
        .ok_or(DrainCoverError::MathOverflow.into())
}

pub fn handle_open_incident(
    ctx: Context<OpenIncident>,
    _policy_seq: u64,
    trigger_sig: [u8; 64],
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let config = &ctx.accounts.config;

    let deadline = validate_open(
        config.attestor_count,
        ctx.accounts.policy.is_in_force(now),
        now,
        config.attest_window,
    )?;

    transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bond_source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.opener.to_account_info(),
            },
        ),
        config.open_bond,
    )?;

    let pool = &mut ctx.accounts.pool;
    // Withdrawals are blocked while a pool has an open incident (FR-019), which is
    // why every path out of an incident — payout or expiry — has to decrement this.
    pool.open_incidents = pool
        .open_incidents
        .checked_add(1)
        .ok_or(DrainCoverError::MathOverflow)?;

    ctx.accounts.incident.set_inner(Incident {
        policy: ctx.accounts.policy.key(),
        trigger_sig,
        opener: ctx.accounts.opener.key(),
        bond: config.open_bond,
        opened_at: now,
        opened_epoch: clock.epoch,
        deadline,
        // The denominator is fixed here, not read again at resolve: removing an
        // attestor mid-window would otherwise lower the bar an incident has to clear.
        set_size: config.attestor_count,
        votes_unauthorized: 0,
        votes_authorized: 0,
        status: IncidentStatus::Open,
        payout: 0,
        shortfall: 0,
    });

    let protocol = &mut ctx.accounts.protocol;
    protocol.next_incident_seq = protocol
        .next_incident_seq
        .checked_add(1)
        .ok_or(DrainCoverError::MathOverflow)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;
    const WINDOW: i64 = 2 * 3_600;

    #[test]
    fn returns_the_deadline_the_window_gives_it() {
        assert_eq!(validate_open(3, true, NOW, WINDOW).unwrap(), NOW + WINDOW);
    }

    #[test]
    fn rejects_an_empty_attestor_set() {
        assert!(validate_open(0, true, NOW, WINDOW).is_err());
    }

    #[test]
    fn rejects_a_policy_that_is_not_in_force() {
        assert!(validate_open(3, false, NOW, WINDOW).is_err());
    }

    #[test]
    fn rejects_a_deadline_that_would_overflow() {
        assert!(validate_open(3, true, i64::MAX - 1, WINDOW).is_err());
    }
}
