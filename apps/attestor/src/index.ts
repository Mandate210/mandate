// Attestor worker: watch privileged addresses, compare each privileged
// transaction against the effective declaration, open an incident and attest.
//
// In production every attestor is run by an independent party — this binary
// holds exactly one key. Running several instances locally is how the demo
// produces a quorum (docs/PLAN.md → Межа P1).
export {}
