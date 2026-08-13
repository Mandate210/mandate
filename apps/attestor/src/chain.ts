// The real chain behind `ActChain` (T027).
//
// Everything that knows about Anchor, web3.js and the RPC's wire shapes lives here, so
// that `act.ts` — where the decisions are — stays testable with no validator and no
// network. Same split as `watch.ts` and `connectionWatchRpc`.

import { BN, type Program } from '@coral-xyz/anchor'
import type { DeclarationEntry, ObservedTransaction } from '@drain-cover/shared'
import { base58Decode, flattenInstructions } from '@drain-cover/shared'
import {
  type DrainCover,
  findAttestation,
  findAttestor,
  findConfig,
  findDeclarationEntry,
  findIncident,
  findPolicy,
  findVault,
} from '@drain-cover/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { type Connection, type Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import type { ActChain, AttestVerdict, IncidentRef, ProtocolState } from './act'

/** `Incident.trigger_sig` sits after the account discriminator and `policy`. */
const TRIGGER_SIG_OFFSET = 8 + 32

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
     * The incident already carrying this trigger signature, if any.
     *
     * A `memcmp` on the stored signature rather than a walk over every incident the
     * protocol ever had: it is one call whose cost does not grow with the protocol's
     * history. The filter takes base58, which is what a signature already is.
     */
    findIncidentByTrigger: async (protocol, signature): Promise<IncidentRef | null> => {
      const key = new PublicKey(protocol)
      const found = await program.account.incident.all([
        { memcmp: { offset: TRIGGER_SIG_OFFSET, bytes: signature } },
      ])

      for (const { publicKey, account } of found) {
        // `all` cannot filter on the seeds, so the protocol is confirmed by re-deriving
        // the address: an incident of another protocol may carry the same signature.
        const seq = await seqOfIncident(program, key, publicKey)
        if (seq === null) continue
        return { seq, open: 'open' in account.status }
      }
      return null
    },

    openIncident: async ({ protocol, policySeq, signature }) => {
      const key = new PublicKey(protocol)
      const [{ pool }, config] = await Promise.all([
        program.account.protocol.fetch(key),
        program.account.config.fetch(findConfig(programId)),
      ])
      const seq = (await program.account.protocol.fetch(key)).nextIncidentSeq.toNumber()

      await program.methods
        .openIncident(new BN(policySeq), base58Decode(signature))
        .accountsPartial({
          opener: attestor.publicKey,
          protocol: key,
          pool,
          policy: findPolicy(programId, key, policySeq),
          incident: findIncident(programId, key, seq),
          bondSource: getAssociatedTokenAddressSync(config.assetMint, attestor.publicKey),
          vault: findVault(config.assetMint, pool),
          systemProgram: SystemProgram.programId,
        })
        .signers([attestor])
        .rpc()

      return seq
    },

    hasAttested: async (protocol, incidentSeq) => {
      const incident = findIncident(programId, new PublicKey(protocol), incidentSeq)
      const attestation = findAttestation(programId, incident, attestor.publicKey)
      return (await connection.getAccountInfo(attestation)) !== null
    },

    attest: async ({ protocol, incidentSeq, verdict }) => {
      const key = new PublicKey(protocol)
      const incident = findIncident(programId, key, incidentSeq)

      await program.methods
        .attest(new BN(incidentSeq), verdictArgument(verdict))
        .accountsPartial({
          protocol: key,
          incident,
          attestorAuthority: attestor.publicKey,
          attestor: findAttestor(programId, attestor.publicKey),
          attestation: findAttestation(programId, incident, attestor.publicKey),
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
 * Which sequence number an incident address belongs to.
 *
 * The account carries no sequence of its own — it is in the seeds — so the only way
 * back is to re-derive. Walking from the protocol's counter downwards finds a recent
 * incident in a step or two, which is the case that matters: the one being raced over.
 */
const seqOfIncident = async (
  program: Program<DrainCover>,
  protocol: PublicKey,
  incident: PublicKey,
): Promise<number | null> => {
  const { nextIncidentSeq } = await program.account.protocol.fetch(protocol)
  for (let seq = nextIncidentSeq.toNumber() - 1; seq >= 0; seq -= 1) {
    if (findIncident(program.programId, protocol, seq).equals(incident)) return seq
  }
  return null
}
