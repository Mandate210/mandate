// A cluster that holds the fixture world (`fixtures.ts`), for tests that run the real
// indexer against it — the indexer's own, and the routes', which read what it wrote.

import type { ObservedTransaction } from '@mandate/shared'
import {
  addresses,
  attestTx,
  attestationOf,
  keys,
  legacyResolveTx,
  openTx,
  registerTx,
  settlingAttestTx,
  sig,
  worldAccounts,
} from './fixtures'
import type { IndexerRpc } from './indexer'

/** Cluster time at slot 100, where the fake cluster starts: after every fixture event. */
export const CLUSTER_TIME = 1_720_000_000

export const A = attestationOf(keys.attestorA).toBase58()
export const B = attestationOf(keys.attestorB).toBase58()
export const INCIDENT = addresses.incident.toBase58()
export const PROTOCOL = addresses.protocol.toBase58()

/**
 * A cluster that holds the fixture world and remembers what was asked of it. Each
 * account's history is newest first, as `getSignaturesForAddress` returns it.
 */
export const fakeCluster = async () => {
  let accounts = await worldAccounts()
  let slot = 100
  const transactions = new Map<string, ObservedTransaction>([
    [sig('SigRegister'), registerTx()],
    [sig('SigOpen'), openTx()],
    [sig('SigAttestA'), attestTx(keys.attestorA, sig('SigAttestA'))],
    [sig('SigAttestB'), attestTx(keys.attestorB, sig('SigAttestB'))],
    // The world was paid before T078, by a separate `resolve`; a census from nothing
    // has to find that payout again (`recoverProvenance`).
    [sig('SigResolve'), legacyResolveTx()],
    // How the same decision lands since T078, for the live path.
    [sig('SigDecide'), settlingAttestTx(keys.attestorB, sig('SigDecide'))],
  ])
  const history = new Map<string, string[]>([
    [PROTOCOL, [sig('SigResolve'), sig('SigOpen'), sig('SigRegister')]],
    [INCIDENT, [sig('SigResolve'), sig('SigAttestB'), sig('SigAttestA'), sig('SigOpen')]],
    [A, [sig('SigAttestA')]],
    [B, [sig('SigAttestB')]],
  ])
  const calls: string[] = []
  const foreign = new Map<string, { owner: string; data: Buffer }>()
  let logs: ((signature: string, failed: boolean) => void) | undefined

  const rpc: IndexerRpc = {
    programAccounts: async () => {
      calls.push('programAccounts')
      return { slot, accounts }
    },
    accounts: async (wanted) => {
      calls.push('accounts')
      return { slot, accounts: accounts.filter((account) => wanted.includes(account.address)) }
    },
    transaction: async (signature) => {
      calls.push(`transaction:${signature}`)
      return transactions.get(signature) ?? null
    },
    signatures: async (address) => {
      calls.push(`signatures:${address}`)
      return [...(history.get(address) ?? [])]
    },
    signatureSlot: async () => 90,
    // The trigger's slot, and the slots the cluster is read at: the world's clock stands
    // at CLUSTER_TIME on slot 100 and moves a second a slot from there.
    blockTime: async (at) =>
      at === 90 ? 1_709_999_999 : at >= 100 ? CLUSTER_TIME + (at - 100) : null,
    mintDecimals: async () => 6,
    foreignAccount: async (address) => {
      calls.push(`foreignAccount:${address}`)
      return foreign.get(address) ?? null
    },
    onProgramLogs: (callback) => {
      calls.push('subscribe')
      logs = callback
      return () => {
        logs = undefined
      }
    },
  }

  return {
    /** A transaction the live path can fetch by its signature. */
    addTransaction: (transaction: ObservedTransaction) => {
      transactions.set(transaction.signature, transaction)
    },
    /** Puts an account the program does not own on the cluster — a declared program's IDL. */
    setForeign: (address: string, account: { owner: string; data: Buffer } | null) => {
      if (account === null) foreign.delete(address)
      else foreign.set(address, account)
    },
    rpc,
    calls,
    setSlot: (next: number) => {
      slot = next
    },
    replace: async (address: string, data: Buffer) => {
      accounts = accounts.map((account) =>
        account.address === address ? { address, data } : account,
      )
    },
    emit: (signature: string, failed = false) => logs?.(signature, failed),
    subscribed: () => logs !== undefined,
  }
}
