// One file per instruction, added in Phase 4 in user-story order. Names below are
// the ones the tasks carry, so a task and a file always match (docs/TASKS.md).
//
// Foundation: initialize
// US1 (P1): register_protocol, issue_policy, service_fund_pool (temporary, removed
//           with T036), submit_declaration, revoke_declaration, set_attestor,
//           open_incident, attest, resolve, close_expired_incident
// US2 (P2): deposit, request_withdraw, complete_withdraw
// US3 (P3): register_attestor, sweep_attestors
// US4 (P4): open_policy, pause_new_policies

pub mod attest;
pub mod close_expired_incident;
pub mod initialize;
pub mod issue_policy;
pub mod open_incident;
pub mod register_protocol;
pub mod resolve;
pub mod revoke_declaration;
pub mod service_fund_pool;
pub mod set_attestor;
pub mod submit_declaration;

// The globs are required, not stylistic: `#[derive(Accounts)]` also generates hidden
// `__client_accounts_*` modules, and `#[program]` resolves them at the crate root.
// Which is why each handler is named `handle_<instruction>` rather than `handler` —
// two globs re-exporting the same name is an ambiguity that `clippy -D warnings`
// rejects in CI.
pub use attest::*;
pub use close_expired_incident::*;
pub use initialize::*;
pub use issue_policy::*;
pub use open_incident::*;
pub use register_protocol::*;
pub use resolve::*;
pub use revoke_declaration::*;
pub use service_fund_pool::*;
pub use set_attestor::*;
pub use submit_declaration::*;
