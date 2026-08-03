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

pub mod initialize;

pub use initialize::*;
