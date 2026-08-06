use anchor_lang::prelude::*;

pub const INCIDENT_SEED: &[u8] = b"incident";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum IncidentStatus {
    Open,
    /// Quorum reached, funds sent. Final and irreversible (FR-012).
    PaidOut,
    /// Closed with no payout: the deadline passed without quorum, or the policy
    /// was not active when the decision was taken (FR-016).
    ClosedNoPayout,
}

impl Space for IncidentStatus {
    /// Borsh writes the variant index as one byte.
    const INIT_SPACE: usize = 1;
}

/// A recorded suspicion of an unauthorized privileged action.
///
/// The program cannot read another protocol's past transaction, so `trigger_sig`
/// enters as a *claim* by whoever opened the incident. What makes it evidence is
/// independent attestors agreeing (FR-007…FR-010).
///
/// Every field here is paid for in rent and fees on each incident, which SC-008
/// caps at 1 USD — so this account carries no reserve fields.
#[account]
#[derive(InitSpace)]
pub struct Incident {
    pub policy: Pubkey,
    /// The triggering transaction, kept in full so the public trail can be
    /// replayed straight from an RPC node (FR-011, SC-007).
    pub trigger_sig: [u8; 64],
    /// Refunded if the quorum confirms the incident, forfeited to the pool if it
    /// does not.
    pub opener: Pubkey,
    pub bond: u64,
    pub opened_at: i64,
    /// Epoch the incident opened in. FR-008 admits an attestation only from a
    /// member of the set *as it stood when the incident opened*, so membership is
    /// judged against this epoch and not against the one the attestation lands in —
    /// otherwise an attestor admitted afterwards could vote on it.
    pub opened_epoch: u64,
    /// `opened_at + Config::attest_window`.
    pub deadline: i64,
    /// Size of the attestor set at the moment of opening, and therefore the
    /// denominator of this incident's quorum. Snapshotted so the bar cannot move
    /// while attestations are being collected.
    pub set_size: u16,
    /// Attestations classifying the action as unauthorized, and as authorized.
    /// Named for the classification rather than for/against, because a quorum is
    /// counted on one specific verdict (FR-010).
    pub votes_unauthorized: u16,
    pub votes_authorized: u16,
    pub status: IncidentStatus,
    pub payout: u64,
    /// Amount owed but unpayable because the pool ran short. Recorded rather than
    /// carried forward: the trail has to state what was not paid (FR-013).
    pub shortfall: u64,
}
