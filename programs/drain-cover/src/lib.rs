use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

pub use instructions::*;

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
}
