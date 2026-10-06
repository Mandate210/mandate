use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::DrainCoverError;
use crate::events::IncidentSettled;
use crate::settlement::{
    ensure_token_account, pay_from_vault, quorum_threshold, settle_payout, TokenAccountFor,
};
use crate::state::{
    trigger_seeds, Attestation, Attestor, Config, Incident, IncidentStatus, Policy, PolicyStatus,
    Pool, Protocol, Verdict, ATTESTATION_SEED, ATTESTOR_SEED, CONFIG_SEED, INCIDENT_SEED,
    POOL_SEED,
};

#[event_cpi]
#[derive(Accounts)]
pub struct Attest<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = pool)]
    pub protocol: Account<'info, Protocol>,
    /// Verified against the signature it stores: the account is only at this address
    /// if `open_incident` put it there for exactly this trigger and this protocol, so
    /// no argument is needed to name it — the address is the argument. `has_one`
    /// binds the policy the incident recorded when it opened, which is not up for
    /// revision at settlement.
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
    /// Signs and pays for its own attestation. Nothing else in the program can
    /// create one, so the record is a statement by the attestor and by nobody else.
    #[account(mut)]
    pub attestor_authority: Signer<'info>,
    /// Derived from the signer, so the seeds are the whole binding: there is no way
    /// to present someone else's membership.
    #[account(seeds = [ATTESTOR_SEED, attestor_authority.key().as_ref()], bump)]
    pub attestor: Account<'info, Attestor>,
    /// FR-009 is the address itself: `(incident, attestor)` derives one account, so a
    /// second attestation from the same attestor fails in the runtime before any of
    /// this code runs. No counter, no list, nothing to get wrong.
    #[account(
        init,
        payer = attestor_authority,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [
            ATTESTATION_SEED,
            incident.key().as_ref(),
            attestor_authority.key().as_ref(),
        ],
        bump,
    )]
    pub attestation: Account<'info, Attestation>,

    // ── What the deciding vote settles with (FR-012) ─────────────────────────
    //
    // Required on every attestation, not only the deciding one. No attestor can know
    // for certain that its vote will be the one to complete the quorum — another may
    // land in the same slot — and an account list that depended on the tally would be
    // one a caller could get wrong, failing exactly the vote that matters.
    #[account(mut, seeds = [POOL_SEED, protocol.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub policy: Account<'info, Policy>,
    #[account(mut, address = pool.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = config.asset_mint)]
    pub asset_mint: Account<'info, Mint>,
    /// CHECK: only its address is used, as the owner of the account the payout goes
    /// to — and the address is the one the policy fixed at issuance (FR-004).
    #[account(address = policy.beneficiary)]
    pub beneficiary: UncheckedAccount<'info>,
    /// CHECK: the beneficiary's associated account for the settlement asset, and no
    /// other — nobody chooses where a payout goes. Unchecked because it may not exist
    /// yet: the deciding vote opens it (`settlement::ensure_token_account`).
    #[account(
        mut,
        address = get_associated_token_address(&policy.beneficiary, &config.asset_mint),
    )]
    pub beneficiary_token: UncheckedAccount<'info>,
    /// CHECK: only its address is used, as the owner of the account the bond goes
    /// back to; it is the opener the incident recorded.
    #[account(address = incident.opener)]
    pub opener: UncheckedAccount<'info>,
    /// CHECK: the opener's associated account for the settlement asset, opened by the
    /// deciding vote if it has to be, as above.
    #[account(
        mut,
        address = get_associated_token_address(&incident.opener, &config.asset_mint),
    )]
    pub opener_token: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// An attestation counts only inside the window, on an open incident, and from a
/// member of the set the incident opened with.
///
/// The deadline is inclusive: an attestation landing in the same second the window
/// closes is on time. It matters that this is decided here and once — a boundary
/// read differently by different code paths is how two attestors reach two verdicts
/// about the same chain state.
pub fn validate_attest(
    status: IncidentStatus,
    deadline: i64,
    now: i64,
    is_member: bool,
) -> Result<()> {
    require!(
        status == IncidentStatus::Open,
        DrainCoverError::IncidentNotOpen
    );
    require!(now <= deadline, DrainCoverError::AttestationWindowClosed);
    require!(is_member, DrainCoverError::AttestorNotActive);
    Ok(())
}

/// What a vote leaves the incident to do.
#[derive(Debug, PartialEq, Eq)]
pub enum AfterVote {
    /// Below the quorum: the incident keeps collecting attestations.
    Wait,
    /// This vote completed the quorum and the policy covers the moment: pay (FR-012).
    Pay,
    /// This vote completed the quorum, but the policy is not in force at the moment
    /// of the decision (FR-016). The decision is final, so the incident closes now
    /// rather than freezing the pool's capital until its deadline — a policy past its
    /// end or exhausted cannot come back into force.
    CloseUnpaid,
}

/// The decision a vote completes, if any.
///
/// Only an `unauthorized` vote can complete the quorum (FR-010): `authorized` is never
/// counted towards it. `votes_unauthorized` is the tally **including** this vote, and
/// an incident at quorum is settled by the vote that put it there, so a later vote
/// never finds one still open.
pub fn after_vote(
    verdict: Verdict,
    votes_unauthorized: u16,
    needed: u16,
    policy_in_force: bool,
) -> AfterVote {
    if verdict != Verdict::Unauthorized || votes_unauthorized < needed {
        AfterVote::Wait
    } else if policy_in_force {
        AfterVote::Pay
    } else {
        AfterVote::CloseUnpaid
    }
}

pub fn handle_attest(ctx: Context<Attest>, verdict: Verdict) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    {
        let incident = &mut ctx.accounts.incident;
        validate_attest(
            incident.status,
            incident.deadline,
            now,
            ctx.accounts.attestor.is_member_at(incident.opened_epoch),
        )?;

        // Tallied here rather than counted from the attestation accounts at
        // settlement: the program cannot enumerate PDAs, and a tally that has to be
        // assembled by the caller is a tally the caller can misreport.
        match verdict {
            Verdict::Unauthorized => {
                incident.votes_unauthorized = incident
                    .votes_unauthorized
                    .checked_add(1)
                    .ok_or(DrainCoverError::MathOverflow)?
            }
            Verdict::Authorized => {
                incident.votes_authorized = incident
                    .votes_authorized
                    .checked_add(1)
                    .ok_or(DrainCoverError::MathOverflow)?
            }
        }
    }

    ctx.accounts.attestation.set_inner(Attestation {
        verdict,
        submitted_at: now,
    });

    let needed = quorum_threshold(
        ctx.accounts.incident.set_size,
        ctx.accounts.config.quorum_bps,
    );
    // FR-016 asks about the moment of the decision, which is this vote — not when
    // the incident opened and not when the earlier attestations arrived.
    let pay = match after_vote(
        verdict,
        ctx.accounts.incident.votes_unauthorized,
        needed,
        ctx.accounts.policy.is_in_force(now),
    ) {
        AfterVote::Wait => return Ok(()),
        AfterVote::Pay => true,
        AfterVote::CloseUnpaid => false,
    };

    let settled = settle(ctx.accounts, pay)?;
    emit_cpi!(settled);
    Ok(())
}

/// Settles the incident the quorum just decided: the payout if the policy covers the
/// moment, the bond back to the opener either way, the reservation released.
///
/// T038 wedges the attestor accounting in here — reward for agreeing with the
/// decision, slashing for contradicting it.
fn settle(accounts: &mut Attest, pay: bool) -> Result<IncidentSettled> {
    let (payout, shortfall) = if pay {
        settle_payout(accounts.policy.payable(), accounts.pool.total_assets)
    } else {
        (0, 0)
    };
    // The bond follows the quorum, not the payout: a claim the set confirmed was not
    // a false one, even when the policy could no longer pay.
    let bond = accounts.incident.bond;

    let protocol = accounts.protocol.key();
    let pool_bump = accounts.pool.bump;
    let payer = accounts.attestor_authority.to_account_info();
    let mint = accounts.asset_mint.to_account_info();
    let system_program = accounts.system_program.to_account_info();
    let token_program = accounts.token_program.to_account_info();
    let associated_token_program = accounts.associated_token_program.to_account_info();
    let vault = accounts.vault.to_account_info();
    let pool_info = accounts.pool.to_account_info();

    for (amount, owner, token_account) in [
        (
            payout,
            accounts.beneficiary.to_account_info(),
            accounts.beneficiary_token.to_account_info(),
        ),
        (
            bond,
            accounts.opener.to_account_info(),
            accounts.opener_token.to_account_info(),
        ),
    ] {
        if amount == 0 {
            continue;
        }
        ensure_token_account(TokenAccountFor {
            payer: &payer,
            token_account: &token_account,
            owner: &owner,
            mint: &mint,
            system_program: &system_program,
            token_program: &token_program,
            associated_token_program: &associated_token_program,
        })?;
        pay_from_vault(
            &token_program,
            &vault,
            &token_account,
            &pool_info,
            &protocol,
            pool_bump,
            amount,
        )?;
    }

    let pool = &mut accounts.pool;
    let policy = &mut accounts.policy;
    let incident = &mut accounts.incident;

    // The reservation this incident placed on the pool's capital ends with it (FR-019).
    pool.open_incidents = pool
        .open_incidents
        .checked_sub(1)
        .ok_or(DrainCoverError::MathOverflow)?;

    if !pay {
        // The account stays, with its tally and its trigger signature, because the
        // trail has to survive the incident (FR-011, SC-007).
        incident.status = IncidentStatus::ClosedNoPayout;
        return Ok(IncidentSettled {
            incident: incident.key(),
            status: incident.status,
            payout: 0,
            shortfall: 0,
            bond_returned: bond,
        });
    }

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

    incident.payout = payout;
    incident.shortfall = shortfall;
    // Final and irreversible (FR-012). Nothing in the program moves an incident out
    // of a settled state, which is what makes the status safe to read as a decision.
    incident.status = IncidentStatus::PaidOut;

    Ok(IncidentSettled {
        incident: incident.key(),
        status: incident.status,
        payout,
        shortfall,
        bond_returned: bond,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEADLINE: i64 = 1_000_000;

    #[test]
    fn accepts_a_member_inside_the_window() {
        assert!(validate_attest(IncidentStatus::Open, DEADLINE, DEADLINE - 1, true).is_ok());
        // The deadline second still counts.
        assert!(validate_attest(IncidentStatus::Open, DEADLINE, DEADLINE, true).is_ok());
    }

    #[test]
    fn rejects_an_attestation_after_the_deadline() {
        assert!(validate_attest(IncidentStatus::Open, DEADLINE, DEADLINE + 1, true).is_err());
    }

    #[test]
    fn rejects_a_non_member() {
        assert!(validate_attest(IncidentStatus::Open, DEADLINE, DEADLINE - 1, false).is_err());
    }

    #[test]
    fn rejects_an_incident_that_is_already_settled() {
        assert!(validate_attest(IncidentStatus::PaidOut, DEADLINE, DEADLINE - 1, true).is_err());
        assert!(
            validate_attest(IncidentStatus::ClosedNoPayout, DEADLINE, DEADLINE - 1, true).is_err()
        );
    }

    #[test]
    fn waits_below_the_quorum() {
        assert_eq!(
            after_vote(Verdict::Unauthorized, 1, 2, true),
            AfterVote::Wait
        );
    }

    #[test]
    fn pays_on_the_vote_that_completes_the_quorum() {
        assert_eq!(
            after_vote(Verdict::Unauthorized, 2, 2, true),
            AfterVote::Pay
        );
    }

    #[test]
    fn closes_unpaid_when_the_policy_is_out_of_force_at_the_decision() {
        assert_eq!(
            after_vote(Verdict::Unauthorized, 2, 2, false),
            AfterVote::CloseUnpaid
        );
    }

    #[test]
    fn never_decides_on_an_authorized_vote() {
        // Even with the unauthorized tally at the bar already — which a settled
        // incident would have refused anyway — `authorized` is not what decides.
        assert_eq!(after_vote(Verdict::Authorized, 2, 2, true), AfterVote::Wait);
    }
}
