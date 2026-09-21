use anchor_lang::prelude::*;

use crate::errors::DrainCoverError;
use crate::state::{
    trigger_seeds, Attestation, Attestor, Incident, IncidentStatus, Protocol, Verdict,
    ATTESTATION_SEED, ATTESTOR_SEED, INCIDENT_SEED,
};

#[derive(Accounts)]
pub struct Attest<'info> {
    pub protocol: Account<'info, Protocol>,
    /// Verified against the signature it stores: the account is only at this address
    /// if `open_incident` put it there for exactly this trigger and this protocol, so
    /// no argument is needed to name it — the address is the argument.
    #[account(
        mut,
        seeds = [
            INCIDENT_SEED,
            protocol.key().as_ref(),
            trigger_seeds(&incident.trigger_sig)[0],
            trigger_seeds(&incident.trigger_sig)[1],
        ],
        bump,
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

pub fn handle_attest(ctx: Context<Attest>, verdict: Verdict) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let incident = &mut ctx.accounts.incident;

    validate_attest(
        incident.status,
        incident.deadline,
        now,
        ctx.accounts.attestor.is_member_at(incident.opened_epoch),
    )?;

    // Tallied here rather than counted from the attestation accounts at resolve: the
    // program cannot enumerate PDAs, and a tally that has to be assembled by the
    // caller is a tally the caller can misreport.
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

    ctx.accounts.attestation.set_inner(Attestation {
        verdict,
        submitted_at: now,
    });

    Ok(())
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
}
