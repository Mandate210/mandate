use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

pub use instructions::*;
/// The one state type an instruction takes as an argument, so it has to resolve at
/// the crate root where `#[program]` looks for it.
pub use state::Verdict;

// Derived from target/deploy/drain_cover-keypair.json by `anchor keys sync`, and
// duplicated in Anchor.toml (both clusters) and .env.example, where nothing
// cross-checks it but tests/config-consistency.test.ts. A wrong id here deploys to,
// or talks to, an address nobody controls — and fails silently, because each file
// is individually valid. `anchor keys sync` only rewrites the configured cluster,
// so the other one is updated by hand.
declare_id!("DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P");

// Every instruction is registered here, which is why instruction tasks cannot run
// in parallel — they all touch this file (docs/TASKS.md).
#[program]
pub mod drain_cover {
    use super::*;

    /// Creates the one Config account for this deployment.
    pub fn initialize(
        ctx: Context<Initialize>,
        declaration_delay: i64,
        attest_window: i64,
        quorum_bps: u16,
        open_bond: u64,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(
            ctx,
            declaration_delay,
            attest_window,
            quorum_bps,
            open_bond,
        )
    }

    /// Registers a covered protocol together with its pool and vault (FR-001).
    pub fn register_protocol(
        ctx: Context<RegisterProtocol>,
        protocol_id: Pubkey,
        authority: Pubkey,
        treasury: Pubkey,
        privileged: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::register_protocol::handle_register_protocol(
            ctx,
            protocol_id,
            authority,
            treasury,
            privileged,
        )
    }

    /// Puts capital in a pool without issuing shares. Temporary — removed in T036,
    /// when the real `deposit` arrives with US2.
    pub fn service_fund_pool(ctx: Context<ServiceFundPool>, amount: u64) -> Result<()> {
        instructions::service_fund_pool::handle_service_fund_pool(ctx, amount)
    }

    /// Issues a policy against a pool and takes its premium (FR-003, FR-005).
    pub fn issue_policy(
        ctx: Context<IssuePolicy>,
        limit: u64,
        retention: u64,
        start_ts: i64,
        end_ts: i64,
        beneficiary: Pubkey,
        premium: u64,
    ) -> Result<()> {
        instructions::issue_policy::handle_issue_policy(
            ctx,
            limit,
            retention,
            start_ts,
            end_ts,
            beneficiary,
            premium,
        )
    }

    /// Declares one permitted privileged operation (FR-006). Effective after
    /// `Config.declaration_delay` (FR-031); a permanent window needs
    /// `moves_funds == false` (FR-035).
    pub fn submit_declaration(
        ctx: Context<SubmitDeclaration>,
        declared_program: Pubkey,
        ix_discriminator: [u8; 8],
        not_before: i64,
        not_after: Option<i64>,
        moves_funds: bool,
    ) -> Result<()> {
        instructions::submit_declaration::handle_submit_declaration(
            ctx,
            declared_program,
            ix_discriminator,
            not_before,
            not_after,
            moves_funds,
        )
    }

    /// Records one attestor's verdict on an open incident (FR-007). One attestor,
    /// one attestation — held by the address itself (FR-009).
    pub fn attest(ctx: Context<Attest>, incident_seq: u64, verdict: Verdict) -> Result<()> {
        instructions::attest::handle_attest(ctx, incident_seq, verdict)
    }

    /// Records a suspected unauthorized privileged action against a policy
    /// (FR-006). The trigger signature is a claim; the bond is what it costs to
    /// make one.
    pub fn open_incident(
        ctx: Context<OpenIncident>,
        policy_seq: u64,
        trigger_sig: [u8; 64],
    ) -> Result<()> {
        instructions::open_incident::handle_open_incident(ctx, policy_seq, trigger_sig)
    }

    /// Settles an incident whose quorum has been reached: pays the beneficiary and
    /// returns the bond, in the same operation that establishes the quorum (FR-010,
    /// FR-012, FR-013).
    pub fn resolve(ctx: Context<Resolve>, incident_seq: u64) -> Result<()> {
        instructions::resolve::handle_resolve(ctx, incident_seq)
    }

    /// Closes an incident whose window ran out without a quorum: no payout, the
    /// capital it froze is released and the bond becomes pool capital (FR-011).
    pub fn close_expired_incident(
        ctx: Context<CloseExpiredIncident>,
        incident_seq: u64,
    ) -> Result<()> {
        instructions::close_expired_incident::handle_close_expired_incident(ctx, incident_seq)
    }

    /// Admits an attestor to the permissive set or removes one (FR-008).
    /// Admission takes effect with the next epoch; removal, at once.
    pub fn set_attestor(
        ctx: Context<SetAttestor>,
        attestor_authority: Pubkey,
        in_set: bool,
    ) -> Result<()> {
        instructions::set_attestor::handle_set_attestor(ctx, attestor_authority, in_set)
    }

    /// Withdraws what a declaration entry permits, with no delay (FR-032).
    /// `narrow_to: None` revokes it; `Some(ts)` shortens its window to end at `ts`.
    pub fn revoke_declaration(
        ctx: Context<RevokeDeclaration>,
        seq: u64,
        narrow_to: Option<i64>,
    ) -> Result<()> {
        instructions::revoke_declaration::handle_revoke_declaration(ctx, seq, narrow_to)
    }
}
