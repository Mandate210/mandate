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
        instructions::initialize::handler(
            ctx,
            declaration_delay,
            attest_window,
            quorum_bps,
            open_bond,
        )
    }
}
