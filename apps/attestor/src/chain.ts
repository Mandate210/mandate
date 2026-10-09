// The real chain behind `ActChain` (T027).
//
// Everything that knows about Anchor, web3.js and the RPC's wire shapes lives here, so
// that `act.ts` — where the decisions are — stays testable with no validator and no
// network. Same split as `watch.ts` and `connectionWatchRpc`.

import { BN, type Program } from '@coral-xyz/anchor'
import {
  type DrainCover,
  createJsonRpc,
  findAttestation,
  findAttestor,
  findConfig,
  findDeclarationEntry,
  findIncident,
  findPolicy,
  findVault,
  openIncidentsFilter,
  readTransaction,
} from '@mandate/sdk'
import type { DeclarationEntry } from '@mandate/shared'
import { base58Decode } from '@mandate/shared'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { type Connection, type Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import type { ActChain, AttestVerdict, IncidentRef, ProtocolState } from './act'
import type { ProtocolSource } from './protocols'
import type { ReservedPolicy, SweepChain, SweepIncident, SweepPolicy } from './sweep'
import type { WatchedAddress } from './watch'

export const createChain = ({
  program,
  connection,
  attestor,
  now = () => Math.floor(Date.now() / 1000),
}: {
  program: Program<DrainCover>
  connection: Connection
  /** This attestor's key: it signs its own attestations and pays its own bonds. */
  attestor: Keypair
  now?: () => number
}): ActChain => {
  const programId = program.programId
  // Raw JSON-RPC, not `connection.getTransaction`: web3.js 1.x cannot parse version 1,
  // and a privileged transaction it cannot read is a compromise nobody sees (T077).
  const jsonRpc = createJsonRpc(connection.rpcEndpoint)

  return {
    fetchTransaction: (signature) => readTransaction(jsonRpc, signature, 'confirmed'),

    loadProtocol: async (protocol): Promise<ProtocolState | null> => {
      const account = await program.account.protocol.fetchNullable(new PublicKey(protocol))
      return account === null
        ? null
        : { privileged: account.privileged.map((key) => key.toBase58()) }
    },

    loadDeclaration: async (protocol): Promise<DeclarationEntry[]> => {
      const key = new PublicKey(protocol)
      const { nextDeclarationSeq } = await program.account.protocol.fetch(key)
      const addresses = Array.from({ length: nextDeclarationSeq.toNumber() }, (_, seq) =>
        findDeclarationEntry(programId, key, seq),
      )
      // Every entry, not just the effective ones: which of them stood is decided against
      // the transaction's own clock, and that is the rule's job rather than ours.
      const entries = await program.account.declarationEntry.fetchMultiple(addresses)

      return entries.flatMap((entry) =>
        entry === null
          ? []
          : [
              {
                programId: entry.programId.toBase58(),
                ixDiscriminator: [...entry.ixDiscriminator],
                notBefore: entry.notBefore.toNumber(),
                notAfter: entry.notAfter === null ? null : entry.notAfter.toNumber(),
                movesFunds: entry.movesFunds,
                submittedAt: entry.submittedAt.toNumber(),
                effectiveAt: entry.effectiveAt.toNumber(),
                revokedAt: entry.revokedAt === null ? null : entry.revokedAt.toNumber(),
              },
            ],
      )
    },

    /**
     * A policy the program will accept an incident against.
     *
     * Judged at *now*, not at the transaction's block time, because that is what
     * `validate_open` checks — a client that picked by any other rule would build
     * transactions the program rejects. The program stays the authority on it; this only
     * avoids paying for the refusal. Whether the policy covers *this* transaction — its
     * block time against `start_ts` — is `act`'s question, which is why the start comes
     * back with the number.
     */
    findPolicyInForce: async (protocol) => {
      const key = new PublicKey(protocol)
      const { nextPolicySeq } = await program.account.protocol.fetch(key)
      const seqs = Array.from({ length: nextPolicySeq.toNumber() }, (_, seq) => seq)
      const policies = await program.account.policy.fetchMultiple(
        seqs.map((seq) => findPolicy(programId, key, seq)),
      )
      const at = now()

      for (const [index, policy] of policies.entries()) {
        if (policy === null) continue
        const inForce =
          !('exhausted' in policy.status) &&
          policy.premiumPaid.toNumber() > 0 &&
          at >= policy.startTs.toNumber() &&
          at < policy.endTs.toNumber()
        const seq = seqs[index]
        if (inForce && seq !== undefined) return { seq, startTs: policy.startTs.toNumber() }
      }
      return null
    },

    /**
     * The incident for this trigger signature, if it exists.
     *
     * One derivation and one account read: the address is a function of the protocol
     * and the signature (T070), so there is nothing to search. Before that this was a
     * `getProgramAccounts` with a `memcmp` on the stored signature and a walk back over
     * the protocol's counter to tell which protocol the hit belonged to.
     */
    findIncidentByTrigger: async (protocol, signature): Promise<IncidentRef | null> => {
      const address = findIncident(programId, new PublicKey(protocol), base58Decode(signature))
      const account = await program.account.incident.fetchNullable(address)
      return account === null
        ? null
        : { address: address.toBase58(), open: 'open' in account.status }
    },

    openIncident: async ({ protocol, policySeq, signature }) => {
      const key = new PublicKey(protocol)
      const [{ pool }, config] = await Promise.all([
        program.account.protocol.fetch(key),
        program.account.config.fetch(findConfig(programId)),
      ])
      const triggerSig = base58Decode(signature)
      const incident = findIncident(programId, key, triggerSig)

      await program.methods
        .openIncident(new BN(policySeq), triggerSig)
        .accountsPartial({
          opener: attestor.publicKey,
          protocol: key,
          pool,
          policy: findPolicy(programId, key, policySeq),
          incident,
          bondSource: getAssociatedTokenAddressSync(config.assetMint, attestor.publicKey),
          vault: findVault(config.assetMint, pool),
          systemProgram: SystemProgram.programId,
        })
        .signers([attestor])
        .rpc()

      return incident.toBase58()
    },

    hasAttested: async (incident) => {
      const attestation = findAttestation(programId, new PublicKey(incident), attestor.publicKey)
      return (await connection.getAccountInfo(attestation)) !== null
    },

    incidentOpen: async (incident) => {
      const account = await program.account.incident.fetchNullable(new PublicKey(incident))
      return account !== null && 'open' in account.status
    },

    /**
     * Every attestation carries what the deciding one settles with: no attestor can know
     * for certain that its vote will complete the quorum, and the program takes the same
     * accounts either way (`attest.rs`). The two token accounts are the associated ones
     * and nothing else; the deciding vote opens them if they are missing.
     */
    attest: async ({ protocol, incident, verdict }) => {
      const key = new PublicKey(protocol)
      const address = new PublicKey(incident)
      const stored = await program.account.incident.fetch(address)
      const [{ pool }, policy, { assetMint }] = await Promise.all([
        program.account.protocol.fetch(key),
        program.account.policy.fetch(stored.policy),
        program.account.config.fetch(findConfig(programId)),
      ])

      await program.methods
        .attest(verdictArgument(verdict))
        .accountsPartial({
          protocol: key,
          incident: address,
          attestorAuthority: attestor.publicKey,
          attestor: findAttestor(programId, attestor.publicKey),
          attestation: findAttestation(programId, address, attestor.publicKey),
          pool,
          policy: stored.policy,
          vault: findVault(assetMint, pool),
          assetMint,
          beneficiary: policy.beneficiary,
          beneficiaryToken: getAssociatedTokenAddressSync(assetMint, policy.beneficiary, true),
          opener: stored.opener,
          openerToken: getAssociatedTokenAddressSync(assetMint, stored.opener, true),
          systemProgram: SystemProgram.programId,
        })
        .signers([attestor])
        .rpc()
    },
  }
}

/** Anchor spells an enum variant as a single-key object. */
const verdictArgument = (verdict: AttestVerdict) =>
  verdict === 'unauthorized' ? { unauthorized: {} } : { authorized: {} }

/**
 * The real chain behind `SweepChain` (T071).
 *
 * Kept apart from `createChain` because it needs no key of its own: every instruction
 * it sends is permissionless, so the only thing the provider contributes is the fee.
 * That is what lets the one-shot command run under anybody's keypair — an underwriter
 * unfreezing their own capital does not have to be an attestor.
 */
export const createSweepChain = ({
  program,
  connection,
}: {
  program: Program<DrainCover>
  connection: Connection
}): SweepChain => {
  const programId = program.programId
  let cachedConfig: { assetMint: PublicKey; quorumBps: number } | null = null

  /**
   * `Config`, read once.
   *
   * Both fields are fixed when the config is created and no instruction updates them —
   * `set_attestor` moves `attestor_count`, which is deliberately not read here: an
   * incident's quorum is counted against the `set_size` it recorded when it opened, not
   * against the set as it stands now.
   */
  const loadConfig = async (): Promise<{ assetMint: PublicKey; quorumBps: number }> => {
    if (cachedConfig === null) {
      const account = await program.account.config.fetch(findConfig(programId))
      cachedConfig = { assetMint: account.assetMint, quorumBps: account.quorumBps }
    }
    return cachedConfig
  }

  return {
    /**
     * Every open incident, with the protocol each one belongs to.
     *
     * Two `getProgramAccounts` a pass and no per-incident reads. `Incident` does not
     * store its protocol — the protocol is in its address — so the owner is recovered
     * by re-deriving the address from each registered protocol and the signature the
     * account carries. That is arithmetic, not RPC: there are at most three protocols
     * (`PLAN.md` → Helius credits, C-5), and re-deriving is also what proves the
     * account really is the incident for that trigger.
     *
     * Filtered on `status` rather than listed whole: the program holds every incident
     * it has ever opened, and the open ones are the handful there is work for.
     */
    listOpenIncidents: async (): Promise<SweepIncident[]> => {
      const [protocols, incidents] = await Promise.all([
        program.account.protocol.all(),
        program.account.incident.all(openIncidentsFilter()),
      ])

      return incidents.flatMap(({ publicKey, account }) => {
        const owner = protocols.find(({ publicKey: protocol }) =>
          findIncident(programId, protocol, account.triggerSig).equals(publicKey),
        )
        // An incident whose protocol was deregistered between the two listings. It
        // cannot be acted on without the protocol account, and the next pass will see
        // it again.
        if (owner === undefined) return []

        return [
          {
            address: publicKey.toBase58(),
            protocol: owner.publicKey.toBase58(),
            policy: account.policy.toBase58(),
            opener: account.opener.toBase58(),
            deadline: account.deadline.toNumber(),
            setSize: account.setSize,
            votesUnauthorized: account.votesUnauthorized,
          },
        ]
      })
    },

    loadPolicy: async (policy): Promise<SweepPolicy | null> => {
      const account = await program.account.policy.fetchNullable(new PublicKey(policy))
      return account === null
        ? null
        : {
            startTs: account.startTs.toNumber(),
            endTs: account.endTs.toNumber(),
            premiumPaid: BigInt(account.premiumPaid.toString()),
            exhausted: 'exhausted' in account.status,
          }
    },

    quorumBps: async () => (await loadConfig()).quorumBps,

    settlementAccountExists: async (owner) => {
      const { assetMint } = await loadConfig()
      const token = getAssociatedTokenAddressSync(assetMint, new PublicKey(owner), true)
      return (await connection.getAccountInfo(token)) !== null
    },

    incidentOpen: async (incident) => {
      const account = await program.account.incident.fetchNullable(new PublicKey(incident))
      return account !== null && 'open' in account.status
    },

    closeExpired: async (protocol, incident) => {
      const key = new PublicKey(protocol)
      const address = new PublicKey(incident)
      const stored = await program.account.incident.fetch(address)
      const [{ pool }, { assetMint }] = await Promise.all([
        program.account.protocol.fetch(key),
        loadConfig(),
      ])

      await program.methods
        .closeExpiredIncident()
        .accountsPartial({
          protocol: key,
          pool,
          policy: stored.policy,
          incident: address,
          vault: findVault(assetMint, pool),
          // Required in both branches, and only paid in one: Anchor deserialises it
          // before the handler runs, so an opener that closed this account leaves an
          // incident nobody can close. `sweep.ts` checks for it and reports it.
          openerToken: getAssociatedTokenAddressSync(assetMint, stored.opener, true),
        })
        .rpc()
    },

    /**
     * Every policy still holding a reservation, for every registered protocol.
     *
     * Walked by sequence number, not listed with `getProgramAccounts`: `Policy` stores
     * neither its protocol nor its own seq, and the instruction needs the seq — which
     * the walk has in hand, the same way `findPolicyInForce` does it. One
     * `getMultipleAccounts` per protocol.
     */
    listReservedPolicies: async (): Promise<ReservedPolicy[]> => {
      const protocols = await program.account.protocol.all()
      const perProtocol = await Promise.all(
        protocols.map(async ({ publicKey: protocol, account }) => {
          const seqs = Array.from({ length: account.nextPolicySeq.toNumber() }, (_, seq) => seq)
          const addresses = seqs.map((seq) => findPolicy(programId, protocol, seq))
          const policies = await program.account.policy.fetchMultiple(addresses)
          return policies.flatMap((policy, index) =>
            policy === null || !holdsReservation(policy.status)
              ? []
              : [
                  {
                    address: (addresses[index] as PublicKey).toBase58(),
                    protocol: protocol.toBase58(),
                    seq: seqs[index] as number,
                    endTs: policy.endTs.toNumber(),
                  },
                ],
          )
        }),
      )
      return perProtocol.flat()
    },

    policyReserved: async (policy) => {
      const account = await program.account.policy.fetchNullable(new PublicKey(policy))
      return account !== null && holdsReservation(account.status)
    },

    releaseExpiredPolicy: async (protocol, seq) => {
      const key = new PublicKey(protocol)
      const { pool } = await program.account.protocol.fetch(key)
      await program.methods
        .releaseExpiredPolicy(new BN(seq))
        .accountsPartial({ protocol: key, pool, policy: findPolicy(programId, key, seq) })
        .rpc()
    },
  }
}

/**
 * `Pending` and `Active` still hold their remaining limit in `locked_limit`; `Expired`
 * gave it back through `release_expired_policy`, `Exhausted` through the payout that
 * exhausted it.
 */
const holdsReservation = (status: object): boolean =>
  !('expired' in status) && !('exhausted' in status)

/** A protocol's privileged addresses as the watcher takes them: one entry each. */
export const privilegedAddresses = (
  protocol: string,
  privileged: readonly PublicKey[],
): WatchedAddress[] => privileged.map((address) => ({ protocol, address: address.toBase58() }))

/**
 * The registry behind `ProtocolSource` (T079): `getProgramAccounts` for the full read, a
 * program-account subscription for the fast path. Both filter on the `Protocol`
 * discriminator, taken from the coder rather than written down — the same reason
 * `filters.ts` derives its offsets.
 */
export const createProtocolSource = ({
  program,
  connection,
}: {
  program: Program<DrainCover>
  connection: Connection
}): ProtocolSource => ({
  list: async () => {
    const protocols = await program.account.protocol.all()
    return protocols.flatMap(({ publicKey, account }) =>
      privilegedAddresses(publicKey.toBase58(), account.privileged),
    )
  },
  subscribe: async (handler) => {
    const id = connection.onProgramAccountChange(
      program.programId,
      ({ accountId, accountInfo }) => {
        let account: { privileged: PublicKey[] }
        try {
          account = program.coder.accounts.decode('protocol', accountInfo.data)
        } catch {
          // Not thrown into the socket's callback. A layout this client cannot decode
          // fails `list` as well, and the rescan logs it there.
          return
        }
        handler(privilegedAddresses(accountId.toBase58(), account.privileged))
      },
      {
        commitment: 'confirmed',
        filters: [{ memcmp: program.coder.accounts.memcmp('protocol') }],
      },
    )
    return () => connection.removeProgramAccountChangeListener(id)
  },
})
