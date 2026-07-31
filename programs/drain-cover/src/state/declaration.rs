use anchor_lang::prelude::*;

pub const DECLARATION_SEED: &[u8] = b"decl";

/// One entry of a protocol's declaration of permitted privileged operations
/// (FR-006). A privileged transaction that matches no effective entry is what
/// opens an incident — nothing about how the transaction looks enters into it.
#[account]
#[derive(InitSpace)]
pub struct DeclarationEntry {
    /// Program the declared instruction belongs to. Together with the
    /// discriminator this is machine equality, not a heuristic — which is what
    /// lets independent attestors reach the same verdict (docs/PLAN.md → R-2).
    pub program_id: Pubkey,
    pub ix_discriminator: [u8; 8],
    pub not_before: i64,
    /// `None` means a permanent entry: effective with no upper bound. Permitted
    /// only when `moves_funds` is false (FR-035).
    pub not_after: Option<i64>,
    /// Declared by the protocol, because the program cannot tell from a
    /// discriminator whether the instruction moves funds. A false label buys
    /// nothing: the entry is still new, so `declaration_delay` applies to it and
    /// a revocation lands immediately (docs/PLAN.md → R-9).
    pub moves_funds: bool,
    pub submitted_at: i64,
    /// `submitted_at + Config::declaration_delay` (FR-031). An operation executed
    /// before this counts as undeclared.
    pub effective_at: i64,
    /// Revocation and narrowing take effect at once, with no delay (FR-032).
    pub revoked_at: Option<i64>,
}
