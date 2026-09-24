use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::DrainCoverError;
use crate::state::{Config, Pool, Protocol, CONFIG_SEED, POOL_SEED, PRIVILEGED_MAX, PROTOCOL_SEED};

#[derive(Accounts)]
#[instruction(protocol_id: Pubkey)]
pub struct RegisterProtocol<'info> {
    #[account(seeds = [CONFIG_SEED], bump, has_one = admin, has_one = asset_mint)]
    pub config: Account<'info, Config>,
    /// Registration is a service operation in P1, like the attestor list (FR-008).
    /// Self-service in US4 covers policies, not registration.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Protocol::INIT_SPACE,
        seeds = [PROTOCOL_SEED, protocol_id.as_ref()],
        bump,
    )]
    pub protocol: Account<'info, Protocol>,
    #[account(
        init,
        payer = admin,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, protocol.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,
    /// Owned by the pool PDA, so nothing can move capital out without the program
    /// signing for it. One vault per pool is what makes isolation structural rather
    /// than a rule to be enforced (FR-002).
    #[account(
        init,
        payer = admin,
        associated_token::mint = asset_mint,
        associated_token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// Constrained to `Config.asset_mint` by `has_one` above: a pool holding some
    /// other token could never pay a policy denominated in the settlement asset
    /// (FR-014).
    pub asset_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// A cover whose subject cannot be observed is not a cover, and a duplicate is a
/// mistake in the caller rather than a harmless one: the list is what every
/// attestor watches, and it is capped, so a repeat quietly costs a slot.
pub fn validate_privileged(privileged: &[Pubkey]) -> Result<()> {
    require!(
        !privileged.is_empty(),
        DrainCoverError::NoPrivilegedAddresses
    );
    require!(
        privileged.len() <= PRIVILEGED_MAX,
        DrainCoverError::TooManyPrivilegedAddresses
    );

    for (index, address) in privileged.iter().enumerate() {
        require!(
            !privileged[..index].contains(address),
            DrainCoverError::DuplicatePrivilegedAddress
        );
    }

    Ok(())
}

pub fn handle_register_protocol(
    ctx: Context<RegisterProtocol>,
    _protocol_id: Pubkey,
    authority: Pubkey,
    treasury: Pubkey,
    privileged: Vec<Pubkey>,
) -> Result<()> {
    validate_privileged(&privileged)?;

    ctx.accounts.protocol.set_inner(Protocol {
        authority,
        treasury,
        privileged,
        pool: ctx.accounts.pool.key(),
        new_policies_paused: false,
        next_policy_seq: 0,
        next_declaration_seq: 0,
        incident_count: 0,
    });

    ctx.accounts.pool.set_inner(Pool {
        vault: ctx.accounts.vault.key(),
        total_assets: 0,
        total_shares: 0,
        locked_limit: 0,
        open_incidents: 0,
        bump: ctx.bumps.pool,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(count: usize) -> Vec<Pubkey> {
        (0..count).map(|_| Pubkey::new_unique()).collect()
    }

    #[test]
    fn accepts_a_distinct_list() {
        assert!(validate_privileged(&keys(1)).is_ok());
        assert!(validate_privileged(&keys(PRIVILEGED_MAX)).is_ok());
    }

    #[test]
    fn rejects_an_empty_list() {
        assert!(validate_privileged(&[]).is_err());
    }

    #[test]
    fn rejects_more_than_the_cap() {
        assert!(validate_privileged(&keys(PRIVILEGED_MAX + 1)).is_err());
    }

    #[test]
    fn rejects_a_repeat() {
        let mut list = keys(3);
        list.push(list[0]);
        assert!(validate_privileged(&list).is_err());
    }
}
