use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::DrainCoverError;
use crate::instructions::initialize::BPS_DENOMINATOR;
use crate::state::{
    Config, Incident, IncidentStatus, Policy, PolicyStatus, Pool, Protocol, CONFIG_SEED,
    INCIDENT_SEED, POOL_SEED,
};

#[derive(Accounts)]
#[instruction(incident_seq: u64)]
pub struct Resolve<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = pool)]
    pub protocol: Account<'info, Protocol>,
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// Bound to the incident by `has_one`: the incident recorded which policy it was
    /// about when it opened, and that is not up for revision at settlement.
    #[account(mut)]
    pub policy: Account<'info, Policy>,
    #[account(
        mut,
        seeds = [
            INCIDENT_SEED,
            protocol.key().as_ref(),
            &incident_seq.to_le_bytes(),
        ],
        bump,
        has_one = policy,
    )]
    pub incident: Account<'info, Incident>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    /// Owned by the beneficiary the policy fixed at issuance (FR-004), so nobody can
    /// redirect a payout by presenting a different account here.
    #[account(
        mut,
        token::mint = config.asset_mint,
        token::authority = policy.beneficiary,
    )]
    pub beneficiary_token: Account<'info, TokenAccount>,
    /// The bond goes back to whoever opened the incident, because the quorum
    /// confirmed it.
    #[account(
        mut,
        token::mint = config.asset_mint,
        token::authority = incident.opener,
    )]
    pub opener_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // No signer. Settlement is mechanical and public: FR-012 wants the payout to
    // follow the quorum with no confirmation step, so anyone may push it through and
    // nobody can hold it back.
}

/// Attestations classifying the action as unauthorized that this incident needs
/// (FR-010), rounded up.
///
/// Rounded up because rounding down would let a quorum be cleared by less than the
/// share it asks for: at a set of 3 and 6000 bps, 1.8 attestations rounded down is 1,
/// and a single attestor would decide a payout. The denominator is the set size the
/// incident recorded when it opened, never the current one.
pub fn quorum_threshold(set_size: u16, quorum_bps: u16) -> u16 {
    // u32 throughout: the largest product here is 65535 * 10000, which overflows u16
    // long before it overflows u32. The result is at most `set_size`, because
    // `quorum_bps` is capped at 10000 when the config is created.
    let needed = (u32::from(set_size) * u32::from(quorum_bps)).div_ceil(u32::from(BPS_DENOMINATOR));
    needed as u16
}

/// Splits what is owed into what the pool can pay now and what it cannot (FR-013).
///
/// The shortfall is recorded, not carried: the trail has to state what was not paid,
/// and the policy keeps that part of its limit for a later incident rather than the
/// pool taking on a debt it would settle out of some future underwriter's capital.
pub fn settle_payout(owed: u64, available: u64) -> (u64, u64) {
    let payout = owed.min(available);
    (payout, owed - payout)
}

pub fn handle_resolve(ctx: Context<Resolve>, _incident_seq: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(
        ctx.accounts.incident.status == IncidentStatus::Open,
        DrainCoverError::IncidentNotOpen
    );
    // FR-016 asks about the moment of the decision, which is this instruction — not
    // when the incident opened and not when the attestations arrived. A policy that
    // has run out or expired in the meantime pays nothing; the incident then waits
    // for its deadline and closes through close_expired_incident.
    require!(
        ctx.accounts.policy.is_in_force(now),
        DrainCoverError::PolicyNotActive
    );

    let needed = quorum_threshold(
        ctx.accounts.incident.set_size,
        ctx.accounts.config.quorum_bps,
    );
    require!(
        ctx.accounts.incident.votes_unauthorized >= needed,
        DrainCoverError::QuorumNotReached
    );

    // T038 wedges the attestor accounting in here — reward for agreeing with the
    // decision, slashing for contradicting it — which is why the count above and the
    // transfer below are separate steps rather than one function.

    let (payout, shortfall) = settle_payout(
        ctx.accounts.policy.payable(),
        ctx.accounts.pool.total_assets,
    );
    let bond = ctx.accounts.incident.bond;

    let protocol_key = ctx.accounts.protocol.key();
    let pool_seeds: &[&[u8]] = &[POOL_SEED, protocol_key.as_ref(), &[ctx.accounts.pool.bump]];
    let signer = &[pool_seeds];

    if payout > 0 {
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.beneficiary_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;
    }

    if bond > 0 {
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.opener_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer,
            ),
            bond,
        )?;
    }

    let pool = &mut ctx.accounts.pool;
    let policy = &mut ctx.accounts.policy;

    // FR-015: the limit and the pool's capital fall by the same amount, so what was
    // paid cannot be counted twice — once as cover still available and once as
    // capital still deployable.
    pool.total_assets = pool
        .total_assets
        .checked_sub(payout)
        .ok_or(DrainCoverError::MathOverflow)?;
    pool.locked_limit = pool
        .locked_limit
        .checked_sub(payout)
        .ok_or(DrainCoverError::MathOverflow)?;
    pool.open_incidents = pool
        .open_incidents
        .checked_sub(1)
        .ok_or(DrainCoverError::MathOverflow)?;

    policy.remaining_limit = policy
        .remaining_limit
        .checked_sub(payout)
        .ok_or(DrainCoverError::MathOverflow)?;
    // Only the paid part reduces the cover. The unpaid remainder stays with the
    // policy: the pool running short is not a claim the protocol spent.
    if policy.payable() == 0 {
        policy.status = PolicyStatus::Exhausted;
        // What is left is the retention, which is never payable — the pool has
        // nothing more to back here and the reservation is released.
        pool.locked_limit = pool
            .locked_limit
            .checked_sub(policy.remaining_limit)
            .ok_or(DrainCoverError::MathOverflow)?;
    }

    let incident = &mut ctx.accounts.incident;
    incident.payout = payout;
    incident.shortfall = shortfall;
    // Final and irreversible (FR-012). Nothing in the program moves an incident out
    // of a settled state, which is what makes the status safe to read as a decision.
    incident.status = IncidentStatus::PaidOut;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_the_quorum_up() {
        // 60% of 3 is 1.8 — two attestations, not one.
        assert_eq!(quorum_threshold(3, 6_000), 2);
        assert_eq!(quorum_threshold(5, 6_000), 3);
        assert_eq!(quorum_threshold(4, 6_000), 3);
    }

    #[test]
    fn asks_the_whole_set_at_unanimity_and_at_least_one_otherwise() {
        assert_eq!(quorum_threshold(7, BPS_DENOMINATOR), 7);
        // A single attestor is the floor: the share is above zero, so somebody has
        // to say so.
        assert_eq!(quorum_threshold(100, 1), 1);
    }

    #[test]
    fn never_asks_for_more_than_the_set() {
        assert_eq!(quorum_threshold(u16::MAX, BPS_DENOMINATOR), u16::MAX);
    }

    #[test]
    fn pays_everything_owed_when_the_pool_can() {
        assert_eq!(settle_payout(800, 1_000), (800, 0));
        assert_eq!(settle_payout(800, 800), (800, 0));
    }

    #[test]
    fn records_what_the_pool_cannot_pay() {
        assert_eq!(settle_payout(800, 500), (500, 300));
        assert_eq!(settle_payout(800, 0), (0, 800));
    }
}
