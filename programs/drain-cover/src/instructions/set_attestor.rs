use anchor_lang::prelude::*;

use crate::errors::DrainCoverError;
use crate::state::{Attestor, Config, ATTESTOR_SEED, CONFIG_SEED};

#[derive(Accounts)]
#[instruction(attestor_authority: Pubkey)]
pub struct SetAttestor<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// The set is a permissive list in P1 (FR-008), so admitting and removing are
    /// service operations. US3 replaces how the set is formed — stake instead of
    /// this list (FR-021, T041) — and leaves everything downstream of it alone.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// `init_if_needed` because this is an upsert, not a creation: an attestor
    /// removed by mistake has to be able to come back, and the account is where the
    /// record of their agreements lives. The usual re-initialization hazard does not
    /// apply — the handler writes membership and nothing else, so a second admission
    /// cannot reset a history or, from US3, a stake. Only the admin can call it, and
    /// the address is derived from the authority it is about.
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + Attestor::INIT_SPACE,
        seeds = [ATTESTOR_SEED, attestor_authority.as_ref()],
        bump,
    )]
    pub attestor: Account<'info, Attestor>,
    pub system_program: Program<'info, System>,
}

/// `in_set: true` admits, `false` removes. Both are refused if they would not change
/// anything: a repeated admission would push `active_from_epoch` forward and silently
/// disarm an attestor the admin believes is voting.
pub fn handle_set_attestor(
    ctx: Context<SetAttestor>,
    attestor_authority: Pubkey,
    in_set: bool,
) -> Result<()> {
    let epoch = Clock::get()?.epoch;
    let attestor = &mut ctx.accounts.attestor;
    let config = &mut ctx.accounts.config;

    require!(
        attestor.in_set != in_set,
        if in_set {
            DrainCoverError::AttestorAlreadyInSet
        } else {
            DrainCoverError::AttestorNotInSet
        }
    );

    if in_set {
        attestor.authority = attestor_authority;
        // FR-008. Voting rights start with the next epoch, and an epoch is far
        // longer than the attestation window, so the set that decides an incident is
        // fixed before that incident exists. Without it the admin — or whoever takes
        // the admin key — could pack the set while attestations are being collected.
        attestor.active_from_epoch = epoch.checked_add(1).ok_or(DrainCoverError::MathOverflow)?;
        attestor.in_set = true;
        // `stake`, `agreed` and `disagreed` are deliberately untouched: zero on a
        // fresh account, preserved on a returning one.
        config.attestor_count = config
            .attestor_count
            .checked_add(1)
            .ok_or(DrainCoverError::MathOverflow)?;
    } else {
        // Removal takes effect at once, so the count and the right to attest stay in
        // step and the quorum denominator is never larger than the set that can
        // actually vote. Admission is the asymmetric one, and asymmetric the safe
        // way: for one epoch a newcomer is counted but cannot vote, which makes
        // quorum harder to reach, never easier.
        attestor.in_set = false;
        config.attestor_count = config
            .attestor_count
            .checked_sub(1)
            .ok_or(DrainCoverError::MathOverflow)?;
    }

    Ok(())
}
