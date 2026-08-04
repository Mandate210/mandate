/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/drain_cover.json`.
 */
export type DrainCover = {
  address: 'DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P'
  metadata: {
    name: 'drainCover'
    version: '0.1.0'
    spec: '0.1.0'
    description: "Parametric cover against unauthorized use of a protocol's privileged admin access"
  }
  instructions: [
    {
      name: 'initialize'
      docs: ['Creates the one Config account for this deployment.']
      discriminator: [175, 175, 109, 31, 13, 152, 155, 237]
      accounts: [
        {
          name: 'config'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [99, 111, 110, 102, 105, 103]
              },
            ]
          }
        },
        {
          name: 'admin'
          docs: [
            'Pays for the account and becomes the admin. Whoever runs this owns the',
            'service operations, so on a real deployment it is not a personal key —',
            'see R-1 on the same problem with the upgrade authority.',
          ]
          writable: true
          signer: true
        },
        {
          name: 'assetMint'
          docs: [
            'Typed as a mint so a wrong account cannot be installed as the settlement',
            'asset. Decimals are deliberately not constrained: amounts are stored in',
            "this asset's base units and never converted (FR-014).",
          ]
        },
        {
          name: 'systemProgram'
          address: '11111111111111111111111111111111'
        },
      ]
      args: [
        {
          name: 'declarationDelay'
          type: 'i64'
        },
        {
          name: 'attestWindow'
          type: 'i64'
        },
        {
          name: 'quorumBps'
          type: 'u16'
        },
        {
          name: 'openBond'
          type: 'u64'
        },
      ]
    },
  ]
  accounts: [
    {
      name: 'config'
      discriminator: [155, 12, 170, 224, 30, 250, 204, 130]
    },
  ]
  errors: [
    {
      code: 6000
      name: 'declarationNotEffective'
      msg: 'Declaration entry is not yet effective'
    },
    {
      code: 6001
      name: 'attestorNotActive'
      msg: 'Attestor is not in the active set for this incident'
    },
    {
      code: 6002
      name: 'attestationWindowClosed'
      msg: 'Attestation window for this incident has closed'
    },
    {
      code: 6003
      name: 'policyNotActive'
      msg: 'Policy is not active'
    },
    {
      code: 6004
      name: 'capitalLocked'
      msg: 'Pool capital is locked by active policies'
    },
    {
      code: 6005
      name: 'withdrawalBlockedByIncident'
      msg: 'Withdrawal is blocked while the pool has an open incident'
    },
    {
      code: 6006
      name: 'permanentWindowNotAllowed'
      msg: 'A permanent declaration entry is only allowed for operations that move no funds'
    },
    {
      code: 6007
      name: 'invalidDeclarationWindow'
      msg: 'Declaration window ends before it begins'
    },
    {
      code: 6008
      name: 'declarationRevoked'
      msg: 'Declaration entry has been revoked'
    },
    {
      code: 6009
      name: 'tooManyPrivilegedAddresses'
      msg: 'Privileged address list is full'
    },
    {
      code: 6010
      name: 'incidentNotOpen'
      msg: 'Incident is not open'
    },
    {
      code: 6011
      name: 'quorumNotReached'
      msg: 'Quorum has not been reached'
    },
    {
      code: 6012
      name: 'limitExceedsFreeCapital'
      msg: "Requested limit exceeds the pool's free capital"
    },
    {
      code: 6013
      name: 'newPoliciesPaused'
      msg: 'New policies are paused'
    },
    {
      code: 6014
      name: 'mathOverflow'
      msg: 'Arithmetic overflow'
    },
    {
      code: 6015
      name: 'invalidQuorum'
      msg: 'Quorum must be above zero and at most 10000 basis points'
    },
    {
      code: 6016
      name: 'invalidDuration'
      msg: 'Duration must be positive'
    },
  ]
  types: [
    {
      name: 'config'
      docs: ['Protocol-wide parameters. Exactly one per deployment.']
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'admin'
            docs: [
              'Manages the attestor set while it is permissive (FR-008) and holds the',
              'service operations of US1. Not a party to any payout decision.',
            ]
            type: 'pubkey'
          },
          {
            name: 'assetMint'
            docs: [
              'The single dollar-denominated asset every pool, limit, premium and payout',
              'is expressed in (FR-014). There is no second asset and no conversion, so',
              'no price oracle exists anywhere in the program.',
            ]
            type: 'pubkey'
          },
          {
            name: 'declarationDelay'
            docs: [
              'Seconds between submitting a declaration entry and it taking effect',
              '(FR-031). This delay is the whole defence against a compromised admin',
              'declaring its own operation and executing it before the team notices, so',
              'shortening it trades away the guarantee, not just latency.',
            ]
            type: 'i64'
          },
          {
            name: 'attestWindow'
            docs: [
              'Seconds an incident collects attestations before it closes without a',
              'payout. Without a deadline a frivolous incident would freeze the pool for',
              'good, because FR-019 blocks withdrawals while one is open.',
            ]
            type: 'i64'
          },
          {
            name: 'quorumBps'
            docs: [
              'Share of the active set that must classify an incident as unauthorized',
              'for the payout to fire (FR-010), in basis points.',
            ]
            type: 'u16'
          },
          {
            name: 'openBond'
            docs: ['Bond the opener of an incident locks against frivolous openings.']
            type: 'u64'
          },
          {
            name: 'paused'
            docs: [
              'Stops new policies across every pool. Payouts on active policies are',
              'deliberately unaffected (FR-028).',
            ]
            type: 'bool'
          },
        ]
      }
    },
  ]
}
