use anchor_lang::prelude::*;

use crate::state::IncidentStatus;

/// The decision on an incident, stated by the transaction that took it (T078).
///
/// Emitted by the vote that completes the quorum, through a CPI into this program
/// (`emit_cpi!`) rather than into the logs: an RPC may truncate logs, while an inner
/// instruction is part of the transaction's record like any other — the indexer, a
/// third party replaying the decision (SC-007) and an explorer all find it in the same
/// place they find the vote itself. Without it the settling vote is indistinguishable
/// from the ones before it: `attest` is the instruction either way.
#[event]
pub struct IncidentSettled {
    pub incident: Pubkey,
    /// `PaidOut`, or `ClosedNoPayout` when the policy was out of force (FR-016).
    pub status: IncidentStatus,
    pub payout: u64,
    /// What the pool could not pay (FR-013).
    pub shortfall: u64,
    /// Back to the opener: the quorum confirmed the claim.
    pub bond_returned: u64,
}
