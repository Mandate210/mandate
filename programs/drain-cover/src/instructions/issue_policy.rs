use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::errors::DrainCoverError;
use crate::state::{
    Config, Policy, PolicyStatus, Pool, Protocol, CONFIG_SEED, POLICY_SEED, POOL_SEED,
};

#[derive(Accounts)]
pub struct IssuePolicy<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// Issuance is a service operation in P1. US4 hands it to the protocol itself,
    /// with a premium quote instead of an amount chosen by the caller (FR-025).
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, has_one = pool)]
    pub protocol: Account<'info, Protocol>,
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = admin,
        space = 8 + Policy::INIT_SPACE,
        seeds = [POLICY_SEED, protocol.key().as_ref(), &protocol.next_policy_seq.to_le_bytes()],
        bump,
    )]
    pub policy: Account<'info, Policy>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.asset_mint, token::authority = admin)]
    pub premium_source: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Terms that would make the policy meaningless are refused rather than stored.
///
/// A retention at or above the limit is the interesting one: the payout is the limit
/// less the retention (FR-013), so such a policy could never pay anything while still
/// locking pool capital and looking like cover. FR-033 wants the retention to make a
/// self-staged incident unprofitable, not to make the cover nominal.
pub fn validate_terms(
    limit: u64,
    retention: u64,
    start_ts: i64,
    end_ts: i64,
    premium: u64,
    now: i64,
) -> Result<()> {
    require!(limit > 0, DrainCoverError::InvalidPolicyTerms);
    require!(end_ts > start_ts, DrainCoverError::InvalidPolicyTerms);
    require!(retention < limit, DrainCoverError::RetentionAtOrAboveLimit);
    require!(end_ts > now, DrainCoverError::PolicyEndsInThePast);
    // FR-005: a policy is only active once the premium is paid, and here it is paid in
    // the same transaction. Zero would create cover nobody bought.
    require!(premium > 0, DrainCoverError::PremiumRequired);
    Ok(())
}

pub fn handle_issue_policy(
    ctx: Context<IssuePolicy>,
    limit: u64,
    retention: u64,
    start_ts: i64,
    end_ts: i64,
    beneficiary: Pubkey,
    premium: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    validate_terms(limit, retention, start_ts, end_ts, premium, now)?;

    require!(
        !ctx.accounts.config.paused,
        DrainCoverError::NewPoliciesPaused
    );
    require!(
        !ctx.accounts.protocol.new_policies_paused,
        DrainCoverError::NewPoliciesPaused
    );

    // FR-027 against the capital held before this premium, then the lock and the
    // premium together — see `Pool::underwrite`. Booked before the transfer so a
    // refusal costs no CPI; a failed transfer rolls the booking back with it.
    ctx.accounts.pool.underwrite(limit, premium)?;

    transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.premium_source.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.admin.to_account_info(),
            },
        ),
        premium,
    )?;

    ctx.accounts.policy.set_inner(Policy {
        limit,
        retention,
        remaining_limit: limit,
        start_ts,
        end_ts,
        premium_paid: premium,
        beneficiary,
        status: if now >= start_ts {
            PolicyStatus::Active
        } else {
            PolicyStatus::Pending
        },
    });

    let protocol = &mut ctx.accounts.protocol;
    protocol.next_policy_seq = protocol
        .next_policy_seq
        .checked_add(1)
        .ok_or(DrainCoverError::MathOverflow)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000;

    #[test]
    fn accepts_sane_terms() {
        assert!(validate_terms(1_000, 200, NOW, NOW + 100, 10, NOW).is_ok());
        // A retention of zero is allowed: FR-033 fixes the amount at issuance without
        // demanding it be non-zero, and the deterrent is a pricing decision.
        assert!(validate_terms(1_000, 0, NOW, NOW + 100, 10, NOW).is_ok());
        // Future start dates are allowed; the policy is simply not in force yet.
        assert!(validate_terms(1_000, 200, NOW + 50, NOW + 100, 10, NOW).is_ok());
    }

    #[test]
    fn rejects_a_zero_limit() {
        assert!(validate_terms(0, 0, NOW, NOW + 100, 10, NOW).is_err());
    }

    #[test]
    fn rejects_a_retention_that_leaves_nothing_payable() {
        assert!(validate_terms(1_000, 1_000, NOW, NOW + 100, 10, NOW).is_err());
        assert!(validate_terms(1_000, 1_001, NOW, NOW + 100, 10, NOW).is_err());
    }

    #[test]
    fn rejects_an_inverted_or_empty_period() {
        assert!(validate_terms(1_000, 200, NOW + 100, NOW, 10, NOW).is_err());
        assert!(validate_terms(1_000, 200, NOW, NOW, 10, NOW).is_err());
    }

    #[test]
    fn rejects_a_period_that_has_already_ended() {
        assert!(validate_terms(1_000, 200, NOW - 100, NOW - 1, 10, NOW).is_err());
    }

    #[test]
    fn rejects_an_unpaid_premium() {
        assert!(validate_terms(1_000, 200, NOW, NOW + 100, 0, NOW).is_err());
    }
}
