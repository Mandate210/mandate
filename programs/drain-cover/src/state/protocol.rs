use anchor_lang::prelude::*;

pub const PROTOCOL_SEED: &[u8] = b"protocol";

/// Upper bound on watched privileged addresses per protocol. The list is stored
/// inline rather than in child accounts because it is read on every comparison
/// and changes rarely (docs/SPEC.md → Припущення); 16 keeps the account under
/// two thirds of a kilobyte.
pub const PRIVILEGED_MAX: usize = 16;

/// A covered protocol and the privileged addresses whose actions are the subject
/// of the cover (FR-001).
#[account]
#[derive(InitSpace)]
pub struct Protocol {
    /// Submits and revokes declaration entries. Compromising it does not by
    /// itself produce a payout: a new entry still waits out `declaration_delay`.
    pub authority: Pubkey,
    /// Treasury of the covered protocol. A policy fixes its own beneficiary at
    /// issuance (FR-004); this is the default offered there.
    pub treasury: Pubkey,
    #[max_len(PRIVILEGED_MAX)]
    pub privileged: Vec<Pubkey>,
    /// The one pool that underwrites this protocol. Pools are never shared, so
    /// capital cannot be spent on another protocol's incident (FR-002).
    pub pool: Pubkey,
    /// Stops new policies for this protocol only (FR-028).
    pub new_policies_paused: bool,
    /// Policies and declaration entries are addressed by `(protocol, seq)`, so the
    /// sequence needs a monotonic source. Keeping the counters here rather than in
    /// `Config` keeps protocols independent: two registrations never contend for
    /// the same number, and a busy protocol does not push another one's addresses
    /// around.
    pub next_policy_seq: u64,
    pub next_declaration_seq: u64,
    /// Incidents opened against this protocol, ever. Not an address source — an
    /// incident is addressed by its trigger (`trigger_seeds`) — but it lets a reader
    /// check «exactly this many were opened» without enumerating program accounts,
    /// which is what the end-to-end scenario does to prove the control case opened
    /// nothing. Same slot and width as the sequence counter it replaced, so the
    /// layout is the one already deployed.
    pub incident_count: u64,
}
