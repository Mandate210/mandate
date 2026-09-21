// The real chain behind `ActChain` (T027).
//
// Everything that knows about Anchor, web3.js and the RPC's wire shapes lives here, so
// that `act.ts` — where the decisions are — stays testable with no validator and no
// network. Same split as `watch.ts` and `connectionWatchRpc`.

import { BN, type Program } from '@coral-xyz/anchor'
import {
  type DrainCover,
  findAttestation,
  findAttestor,
  findConfig,
  findDeclarationEntry,
  findIncident,
  findPolicy,
  findVault,
} from '@mandate/sdk'
import type { DeclarationEntry, ObservedTransaction } from '@mandate/shared'
import { base58Decode, flattenInstructions } from '@mandate/shared'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { type Connection, type Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import type { ActChain, AttestVerdict, IncidentRef, ProtocolState } from './act'

/**
 * A transaction as the rule needs it.
 *
 * **A failed transaction is not an event.** It changed nothing on chain, so it is no
 * evidence of anything and an incident opened on it would be an incident about an
 * attempt. `watch.ts` already drops these; this drops them again, because a signature
 * can also arrive from a sweep of history.
 *
 * `jsonParsed` is deliberately not used: it renames accounts per program and would make
 * what the rule sees depend on which programs the RPC happens to know how to decode.
 */
export const toObservedTransaction = (
  signature: string,
  fetched: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>,
): ObservedTransaction | null => {
  if (fetched.meta?.err != null) return null
  if (fetched.blockTime == null) return null

  const message = fetched.transaction.message
  const keys = message
    .getAccountKeys({ accountKeysFromLookups: fetched.meta?.loadedAddresses ?? null })
    .keySegments()
    .flat()
    .map((key) => key.toBase58())

  const compiled = message.compiledInstructions.map((instruction) => ({
    programId: keys[instruction.programIdIndex] ?? '',
    data: [...instruction.data],
    accounts: instruction.accountKeyIndexes.map((index) => keys[index] ?? ''),
  }))

  const inner = (fetched.meta?.innerInstructions ?? []).map((group) => ({
    index: group.index,
    instructions: group.instructions.map((instruction) => {
      const height = stackHeightOf(instruction)
      return {
        programId: keys[instruction.programIdIndex] ?? '',
        // Inner instruction data comes off the RPC base58-encoded, unlike the outer ones.
        data: base58Decode(instruction.data),
        accounts: instruction.accounts.map((index) => keys[index] ?? ''),
        ...(height === undefined ? {} : { stackHeight: height }),
      }
    }),
  }))

  return {
    signature,
    blockTime: fetched.blockTime,
    signers: message.staticAccountKeys
      .slice(0, message.header.numRequiredSignatures)
      .map((key) => key.toBase58()),
    accountKeys: keys,
    instructions: flattenInstructions(compiled, inner),
  }
}

/**
 * A node reports how deep a CPI instruction ran, but `@solana/web3.js` has never put
 * `stackHeight` on `CompiledInstruction`. Read defensively rather than asserted: the
 * field is genuinely optional on the wire, and `flattenInstructions` has a floor for
 * when it is missing.
 */
const stackHeightOf = (instruction: unknown): number | undefined => {
  if (typeof instruction !== 'object' || instruction === null) return undefined
  const value = (instruction as Record<string, unknown>).stackHeight
  return typeof value === 'number' ? value : undefined
}

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

  return {
    fetchTransaction: async (signature) => {
      const fetched = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      })
      return fetched === null ? null : toObservedTransaction(signature, fetched)
    },

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
     * avoids paying for the refusal.
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
        if (inForce) return seqs[index] ?? null
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
     * The bar is the set size the incident recorded when it opened, never the current
     * one, and the share is rounded **up** — both exactly as `quorum_threshold` does it
     * in the program. Rounding down would let a set of three clear a 60% quorum on one
     * attestation.
     */
    quorumReached: async (incident) => {
      const account = await program.account.incident.fetchNullable(new PublicKey(incident))
      if (account === null || !('open' in account.status)) return false

      const { quorumBps } = await program.account.config.fetch(findConfig(programId))
      const needed = Math.ceil((account.setSize * quorumBps) / 10_000)
      return account.votesUnauthorized >= needed
    },

    resolve: async (protocol, incident) => {
      const key = new PublicKey(protocol)
      const address = new PublicKey(incident)
      const stored = await program.account.incident.fetch(address)
      const [{ pool }, policy] = await Promise.all([
        program.account.protocol.fetch(key),
        program.account.policy.fetch(stored.policy),
      ])
      const { assetMint } = await program.account.config.fetch(findConfig(programId))

      await program.methods
        .resolve()
        .accountsPartial({
          protocol: key,
          pool,
          policy: stored.policy,
          incident: address,
          vault: findVault(assetMint, pool),
          // The beneficiary and the opener are paid in the settlement asset, so both
          // need an account for it. Derived, not created: `resolve` cannot open one,
          // and a beneficiary without an account is a policy that was issued wrong.
          beneficiaryToken: getAssociatedTokenAddressSync(assetMint, policy.beneficiary, true),
          openerToken: getAssociatedTokenAddressSync(assetMint, stored.opener, true),
        })
        .rpc()
    },

    attest: async ({ protocol, incident, verdict }) => {
      const address = new PublicKey(incident)

      await program.methods
        .attest(verdictArgument(verdict))
        .accountsPartial({
          protocol: new PublicKey(protocol),
          incident: address,
          attestorAuthority: attestor.publicKey,
          attestor: findAttestor(programId, attestor.publicKey),
          attestation: findAttestation(programId, address, attestor.publicKey),
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
