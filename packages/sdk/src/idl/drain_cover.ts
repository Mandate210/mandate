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
    {
      name: 'issuePolicy'
      docs: ['Issues a policy against a pool and takes its premium (FR-003, FR-005).']
      discriminator: [126, 159, 34, 92, 118, 55, 15, 196]
      accounts: [
        {
          name: 'config'
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
            'Issuance is a service operation in P1. US4 hands it to the protocol itself,',
            'with a premium quote instead of an amount chosen by the caller (FR-025).',
          ]
          writable: true
          signer: true
          relations: ['config']
        },
        {
          name: 'protocol'
          writable: true
        },
        {
          name: 'pool'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [112, 111, 111, 108]
              },
              {
                kind: 'account'
                path: 'protocol'
              },
            ]
          }
          relations: ['protocol']
        },
        {
          name: 'policy'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [112, 111, 108, 105, 99, 121]
              },
              {
                kind: 'account'
                path: 'protocol'
              },
              {
                kind: 'account'
                path: 'protocol.next_policy_seq'
                account: 'protocol'
              },
            ]
          }
        },
        {
          name: 'vault'
          writable: true
        },
        {
          name: 'premiumSource'
          writable: true
        },
        {
          name: 'tokenProgram'
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
        },
        {
          name: 'systemProgram'
          address: '11111111111111111111111111111111'
        },
      ]
      args: [
        {
          name: 'limit'
          type: 'u64'
        },
        {
          name: 'retention'
          type: 'u64'
        },
        {
          name: 'startTs'
          type: 'i64'
        },
        {
          name: 'endTs'
          type: 'i64'
        },
        {
          name: 'beneficiary'
          type: 'pubkey'
        },
        {
          name: 'premium'
          type: 'u64'
        },
      ]
    },
    {
      name: 'registerProtocol'
      docs: ['Registers a covered protocol together with its pool and vault (FR-001).']
      discriminator: [63, 107, 156, 136, 249, 231, 183, 65]
      accounts: [
        {
          name: 'config'
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
            'Registration is a service operation in P1, like the attestor list (FR-008).',
            'Self-service in US4 covers policies, not registration.',
          ]
          writable: true
          signer: true
          relations: ['config']
        },
        {
          name: 'protocol'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [112, 114, 111, 116, 111, 99, 111, 108]
              },
              {
                kind: 'arg'
                path: 'protocolId'
              },
            ]
          }
        },
        {
          name: 'pool'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [112, 111, 111, 108]
              },
              {
                kind: 'account'
                path: 'protocol'
              },
            ]
          }
        },
        {
          name: 'vault'
          docs: [
            'Owned by the pool PDA, so nothing can move capital out without the program',
            'signing for it. One vault per pool is what makes isolation structural rather',
            'than a rule to be enforced (FR-002).',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'pool'
              },
              {
                kind: 'const'
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169,
                ]
              },
              {
                kind: 'account'
                path: 'assetMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'assetMint'
          docs: [
            'Constrained to `Config.asset_mint` by `has_one` above: a pool holding some',
            'other token could never pay a policy denominated in the settlement asset',
            '(FR-014).',
          ]
          relations: ['config']
        },
        {
          name: 'tokenProgram'
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
        },
        {
          name: 'associatedTokenProgram'
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
        },
        {
          name: 'systemProgram'
          address: '11111111111111111111111111111111'
        },
      ]
      args: [
        {
          name: 'protocolId'
          type: 'pubkey'
        },
        {
          name: 'authority'
          type: 'pubkey'
        },
        {
          name: 'treasury'
          type: 'pubkey'
        },
        {
          name: 'privileged'
          type: {
            vec: 'pubkey'
          }
        },
      ]
    },
    {
      name: 'revokeDeclaration'
      docs: [
        'Withdraws what a declaration entry permits, with no delay (FR-032).',
        '`narrow_to: None` revokes it; `Some(ts)` shortens its window to end at `ts`.',
      ]
      discriminator: [45, 84, 227, 180, 193, 110, 129, 74]
      accounts: [
        {
          name: 'protocol'
        },
        {
          name: 'authority'
          signer: true
          relations: ['protocol']
        },
        {
          name: 'entry'
          docs: [
            'The entry carries no protocol field, so the seeds are what tie it to this',
            "protocol — without them one protocol's authority could revoke another's",
            'declaration, and revocation is the one operation nobody has to wait for.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [100, 101, 99, 108]
              },
              {
                kind: 'account'
                path: 'protocol'
              },
              {
                kind: 'arg'
                path: 'seq'
              },
            ]
          }
        },
      ]
      args: [
        {
          name: 'seq'
          type: 'u64'
        },
        {
          name: 'narrowTo'
          type: {
            option: 'i64'
          }
        },
      ]
    },
    {
      name: 'serviceFundPool'
      docs: [
        'Puts capital in a pool without issuing shares. Temporary — removed in T036,',
        'when the real `deposit` arrives with US2.',
      ]
      discriminator: [119, 70, 230, 33, 12, 78, 63, 35]
      accounts: [
        {
          name: 'config'
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
          signer: true
          relations: ['config']
        },
        {
          name: 'protocol'
          docs: [
            'CHECK is unnecessary: the pool PDA is derived from this protocol, so a pool',
            'that does not belong to it cannot be passed.',
          ]
        },
        {
          name: 'pool'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [112, 111, 111, 108]
              },
              {
                kind: 'account'
                path: 'protocol'
              },
            ]
          }
        },
        {
          name: 'vault'
          writable: true
        },
        {
          name: 'source'
          writable: true
        },
        {
          name: 'tokenProgram'
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
        },
      ]
      args: [
        {
          name: 'amount'
          type: 'u64'
        },
      ]
    },
    {
      name: 'submitDeclaration'
      docs: [
        'Declares one permitted privileged operation (FR-006). Effective after',
        '`Config.declaration_delay` (FR-031); a permanent window needs',
        '`moves_funds == false` (FR-035).',
      ]
      discriminator: [126, 157, 76, 72, 36, 163, 171, 202]
      accounts: [
        {
          name: 'config'
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
          name: 'protocol'
          docs: [
            "A declaration is the protocol's statement about its own operations, so the",
            'admin has no part in it — unlike registration or issuance, which are service',
            'operations in P1. `has_one` is the whole authorisation check.',
          ]
          writable: true
        },
        {
          name: 'authority'
          docs: [
            'Pays for the entry as well as signing it: the protocol carries the cost of',
            'its own declaration, and one signer is one fewer way for a caller to get the',
            'accounts wrong.',
          ]
          writable: true
          signer: true
          relations: ['protocol']
        },
        {
          name: 'entry'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [100, 101, 99, 108]
              },
              {
                kind: 'account'
                path: 'protocol'
              },
              {
                kind: 'account'
                path: 'protocol.next_declaration_seq'
                account: 'protocol'
              },
            ]
          }
        },
        {
          name: 'systemProgram'
          address: '11111111111111111111111111111111'
        },
      ]
      args: [
        {
          name: 'declaredProgram'
          type: 'pubkey'
        },
        {
          name: 'ixDiscriminator'
          type: {
            array: ['u8', 8]
          }
        },
        {
          name: 'notBefore'
          type: 'i64'
        },
        {
          name: 'notAfter'
          type: {
            option: 'i64'
          }
        },
        {
          name: 'movesFunds'
          type: 'bool'
        },
      ]
    },
  ]
  accounts: [
    {
      name: 'config'
      discriminator: [155, 12, 170, 224, 30, 250, 204, 130]
    },
    {
      name: 'declarationEntry'
      discriminator: [220, 182, 175, 15, 201, 252, 185, 113]
    },
    {
      name: 'policy'
      discriminator: [222, 135, 7, 163, 235, 177, 33, 68]
    },
    {
      name: 'pool'
      discriminator: [241, 154, 109, 4, 17, 177, 109, 188]
    },
    {
      name: 'protocol'
      discriminator: [45, 39, 101, 43, 115, 72, 131, 40]
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
    {
      code: 6017
      name: 'noPrivilegedAddresses'
      msg: 'A covered protocol needs at least one privileged address'
    },
    {
      code: 6018
      name: 'duplicatePrivilegedAddress'
      msg: 'Privileged address appears twice'
    },
    {
      code: 6019
      name: 'amountMustBePositive'
      msg: 'Amount must be positive'
    },
    {
      code: 6020
      name: 'invalidPolicyTerms'
      msg: 'Policy limit and period must be positive and ordered'
    },
    {
      code: 6021
      name: 'retentionAtOrAboveLimit'
      msg: 'Retention at or above the limit would make the cover nominal'
    },
    {
      code: 6022
      name: 'policyEndsInThePast'
      msg: 'Policy period has already ended'
    },
    {
      code: 6023
      name: 'premiumRequired'
      msg: 'Policy premium must be paid at issuance'
    },
    {
      code: 6024
      name: 'declarationExpiresBeforeEffective'
      msg: 'Declaration window closes before the entry takes effect'
    },
    {
      code: 6025
      name: 'declarationWindowNotNarrower'
      msg: 'A revised declaration window must be narrower than the one it replaces'
    },
    {
      code: 6026
      name: 'narrowedWindowEndsInThePast'
      msg: 'A narrowed declaration window may not end in the past'
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
    {
      name: 'declarationEntry'
      docs: [
        "One entry of a protocol's declaration of permitted privileged operations",
        '(FR-006). A privileged transaction that matches no effective entry is what',
        'opens an incident — nothing about how the transaction looks enters into it.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'programId'
            docs: [
              'Program the declared instruction belongs to. Together with the',
              'discriminator this is machine equality, not a heuristic — which is what',
              'lets independent attestors reach the same verdict (docs/PLAN.md → R-2).',
            ]
            type: 'pubkey'
          },
          {
            name: 'ixDiscriminator'
            type: {
              array: ['u8', 8]
            }
          },
          {
            name: 'notBefore'
            type: 'i64'
          },
          {
            name: 'notAfter'
            docs: [
              '`None` means a permanent entry: effective with no upper bound. Permitted',
              'only when `moves_funds` is false (FR-035).',
            ]
            type: {
              option: 'i64'
            }
          },
          {
            name: 'movesFunds'
            docs: [
              'Declared by the protocol, because the program cannot tell from a',
              'discriminator whether the instruction moves funds. A false label buys',
              'nothing: the entry is still new, so `declaration_delay` applies to it and',
              'a revocation lands immediately (docs/PLAN.md → R-9).',
            ]
            type: 'bool'
          },
          {
            name: 'submittedAt'
            type: 'i64'
          },
          {
            name: 'effectiveAt'
            docs: [
              '`submitted_at + Config::declaration_delay` (FR-031). An operation executed',
              'before this counts as undeclared.',
            ]
            type: 'i64'
          },
          {
            name: 'revokedAt'
            docs: ['Revocation and narrowing take effect at once, with no delay (FR-032).']
            type: {
              option: 'i64'
            }
          },
        ]
      }
    },
    {
      name: 'policy'
      docs: ['A cover agreement between one covered protocol and its pool (FR-003).']
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'limit'
            docs: [
              'Cover limit. The payout is derived from this and `retention`, never from',
              'the amount actually drained (FR-013).',
            ]
            type: 'u64'
          },
          {
            name: 'retention'
            docs: [
              'Part of the limit that is never paid, under any circumstance. It makes a',
              'self-staged incident lose money arithmetically, without anyone having to',
              'judge intent (FR-033).',
            ]
            type: 'u64'
          },
          {
            name: 'remainingLimit'
            docs: ['What is left of the limit after previous payouts (FR-015).']
            type: 'u64'
          },
          {
            name: 'startTs'
            type: 'i64'
          },
          {
            name: 'endTs'
            type: 'i64'
          },
          {
            name: 'premiumPaid'
            type: 'u64'
          },
          {
            name: 'beneficiary'
            docs: ['Fixed at issuance and immovable while an incident is open (FR-004).']
            type: 'pubkey'
          },
          {
            name: 'status'
            type: {
              defined: {
                name: 'policyStatus'
              }
            }
          },
        ]
      }
    },
    {
      name: 'policyStatus'
      type: {
        kind: 'enum'
        variants: [
          {
            name: 'pending'
          },
          {
            name: 'active'
          },
          {
            name: 'expired'
          },
          {
            name: 'exhausted'
          },
        ]
      }
    },
    {
      name: 'pool'
      docs: [
        'Capital underwriting exactly one covered protocol, and the only source of its',
        'payouts (FR-002). Isolation is structural: each pool owns its own vault, so',
        'there is no shared store to draw from by mistake.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'vault'
            docs: ['Token account holding the capital, owned by this PDA.']
            type: 'pubkey'
          },
          {
            name: 'totalAssets'
            type: 'u64'
          },
          {
            name: 'totalShares'
            type: 'u64'
          },
          {
            name: 'lockedLimit'
            docs: [
              'Sum of the limits of active policies. Capital below this line cannot be',
              'withdrawn (FR-020).',
            ]
            type: 'u64'
          },
          {
            name: 'openIncidents'
            docs: ['Withdrawals are blocked while this is non-zero (FR-019).']
            type: 'u32'
          },
          {
            name: 'accPremiumPerShare'
            docs: [
              'Premium per share, scaled by `PREMIUM_ACC_SCALE`. An underwriter earns',
              'the difference against its own checkpoint, which makes time-in-pool',
              'implicit: nothing accrued before the deposit is claimable (FR-018).',
            ]
            type: 'u128'
          },
          {
            name: 'bump'
            docs: [
              'Stored rather than recomputed: the pool signs every transfer out of its',
              'vault, and rederiving the bump on each of those costs compute for a value',
              'that never changes.',
            ]
            type: 'u8'
          },
        ]
      }
    },
    {
      name: 'protocol'
      docs: [
        'A covered protocol and the privileged addresses whose actions are the subject',
        'of the cover (FR-001).',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'authority'
            docs: [
              'Submits and revokes declaration entries. Compromising it does not by',
              'itself produce a payout: a new entry still waits out `declaration_delay`.',
            ]
            type: 'pubkey'
          },
          {
            name: 'treasury'
            docs: [
              'Treasury of the covered protocol. A policy fixes its own beneficiary at',
              'issuance (FR-004); this is the default offered there.',
            ]
            type: 'pubkey'
          },
          {
            name: 'privileged'
            type: {
              vec: 'pubkey'
            }
          },
          {
            name: 'pool'
            docs: [
              'The one pool that underwrites this protocol. Pools are never shared, so',
              "capital cannot be spent on another protocol's incident (FR-002).",
            ]
            type: 'pubkey'
          },
          {
            name: 'newPoliciesPaused'
            docs: ['Stops new policies for this protocol only (FR-028).']
            type: 'bool'
          },
          {
            name: 'nextPolicySeq'
            docs: [
              'Policies, declaration entries and incidents are addressed by',
              '`(protocol, seq)`, so the sequence needs a monotonic source. Keeping the',
              'counters here rather than in `Config` keeps protocols independent: two',
              'registrations never contend for the same number, and a busy protocol does',
              "not push another one's addresses around.",
            ]
            type: 'u64'
          },
          {
            name: 'nextDeclarationSeq'
            type: 'u64'
          },
          {
            name: 'nextIncidentSeq'
            type: 'u64'
          },
        ]
      }
    },
  ]
}
