// The indexer: keeps the Postgres cache in step with the program (T048).
//
// Decided 2026-09-30:
//
// - **Live changes come from the program's logs.** One `logsSubscribe` on the program;
//   each signature is fetched, its instructions decoded, and the accounts they named
//   read back. The transaction is what carries the signatures the trail needs (FR-011,
//   SC-007) and the relations an address cannot give back — account notifications
//   alone would bring neither.
// - **Recovery is a census, not a replay.** On start and every ten minutes one
//   `getProgramAccounts` reads everything the program owns at one slot. A notification
//   lost while the socket was down, a restart after hours asleep, a cache dropped on
//   purpose — each is repaired by the next census, and none needs a record of where the
//   last run stopped. What a census cannot see (signatures, the `protocol_id` behind a
//   protocol's address) is then recovered per account from its own history.
// - **`finalized` throughout.** The page shows what the chain can no longer take back:
//   a payout that appears and then vanishes after a fork is the worst thing a trust
//   product can display. The price is ~13s of lag, reported by `/health`; the speed
//   that SC-001 measures belongs to the attestors, not to this cache.
//
// Nothing here decides what a row says — that is `accounts.ts`. This file fetches,
// writes, and keeps the two paths from stepping on each other.

import { type Db, schema, upsertNewer } from '@mandate/db'
import { toObservedTransaction } from '@mandate/sdk'
import type { ObservedTransaction } from '@mandate/shared'
import type { Commitment, Connection, PublicKey } from '@solana/web3.js'
import { PublicKey as Key } from '@solana/web3.js'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  type DecodedAccount,
  type Hints,
  type Rows,
  addHint,
  decodeAccount,
  factsFromTransaction,
  instructionNames,
  relate,
  toRows,
} from './accounts'

/** Every read the indexer makes, so that tests can stand in for the cluster. */
export interface IndexerRpc {
  /** Everything the program owns, at one slot. */
  programAccounts(): Promise<{ slot: number; accounts: { address: string; data: Buffer }[] }>
  /** These accounts at one slot; those the program does not own are left out. */
  accounts(
    addresses: string[],
  ): Promise<{ slot: number; accounts: { address: string; data: Buffer }[] }>
  /** A successful transaction, or `null` if it failed or the node no longer serves it. */
  transaction(signature: string): Promise<ObservedTransaction | null>
  /** Successful signatures that touched `address`, newest first, all of them. */
  signatures(address: string): Promise<string[]>
  /** The slot a signature landed in, from the node's status cache or its history. */
  signatureSlot(signature: string): Promise<number | null>
  blockTime(slot: number): Promise<number | null>
  mintDecimals(mint: string): Promise<number>
  /** Calls back with each signature that ran the program; returns the unsubscribe. */
  onProgramLogs(callback: (signature: string, failed: boolean) => void): () => void
}

/** pino's call shape, kept as an interface so tests need no logger at all. */
export interface IndexerLogger {
  info(object: object, message: string): void
  warn(object: object, message: string): void
  error(object: object, message: string): void
}

const silentLogger: IndexerLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** Ten minutes — the same interval, for the same reason, as the attestor's reconciliation. */
export const DEFAULT_CENSUS_INTERVAL_SECONDS = 600

/** An incident's columns that only a transaction fills. */
const INCIDENT_PROVENANCE = {
  triggerSlot: schema.incidents.triggerSlot,
  triggerBlockTime: schema.incidents.triggerBlockTime,
  openedSignature: schema.incidents.openedSignature,
  payoutSignature: schema.incidents.payoutSignature,
  payoutAt: schema.incidents.payoutAt,
}

type IncidentProvenance = Partial<
  Pick<typeof schema.incidents.$inferInsert, keyof typeof INCIDENT_PROVENANCE>
>

/** Columns only a transaction fills; a census row must not erase them. */
const KEEP = {
  incidents: Object.values(INCIDENT_PROVENANCE),
  attestations: [schema.attestations.signature],
  declarations: [schema.declarations.instructionName],
}

export type CensusReport = {
  slot: number
  written: Record<keyof Rows, number>
  unplaced: number
  filled: number
}

export const createIndexer = ({
  rpc,
  db,
  programId,
  logger = silentLogger,
  censusIntervalSeconds = DEFAULT_CENSUS_INTERVAL_SECONDS,
}: {
  rpc: IndexerRpc
  db: Db
  programId: PublicKey
  logger?: IndexerLogger
  censusIntervalSeconds?: number
}) => {
  const decimals = new Map<string, number>()

  // One thing at a time. `upsertNewer` already makes any order safe; serialising keeps
  // the RPC budget flat and a census from recovering provenance a live transaction is
  // about to write anyway.
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work)
    queue = next.catch(() => {})
    return next
  }

  const assetDecimals = async (accounts: readonly DecodedAccount[]) => {
    const config = accounts.find((account) => account.kind === 'Config')
    if (config === undefined) return undefined
    const mint = (config.fields.asset_mint as PublicKey).toBase58()
    const cached = decimals.get(mint)
    if (cached !== undefined) return cached
    // A mint's decimals never change, so one read per process is all it takes.
    const read = await rpc.mintDecimals(mint)
    decimals.set(mint, read)
    return read
  }

  /** What the cache already knows about these addresses' places. */
  const storedHints = async (addresses: string[]): Promise<Hints> => {
    const hints: Hints = new Map()
    if (addresses.length === 0) return hints
    const [protocols, pools, policies, declarations, incidents, attestations] = await Promise.all([
      db.select().from(schema.protocols).where(inArray(schema.protocols.address, addresses)),
      db.select().from(schema.pools).where(inArray(schema.pools.address, addresses)),
      db.select().from(schema.policies).where(inArray(schema.policies.address, addresses)),
      db.select().from(schema.declarations).where(inArray(schema.declarations.address, addresses)),
      db.select().from(schema.incidents).where(inArray(schema.incidents.address, addresses)),
      db.select().from(schema.attestations).where(inArray(schema.attestations.address, addresses)),
    ])
    for (const row of protocols) addHint(hints, row.address, { protocolId: row.protocolId })
    for (const row of pools) addHint(hints, row.address, { protocol: row.protocol })
    for (const row of [...policies, ...declarations]) {
      addHint(hints, row.address, { protocol: row.protocol, seq: row.seq })
    }
    for (const row of incidents) addHint(hints, row.address, { protocol: row.protocol })
    for (const row of attestations) {
      addHint(hints, row.address, { incident: row.incident, attestor: row.attestor })
    }
    return hints
  }

  /**
   * The `protocol_id` a protocol was registered under, from the transaction that did it.
   *
   * It is a seed of the address and not a field of the account, so the one place it can
   * be read is `register_protocol`'s arguments — the oldest transaction on the account.
   * Checked by rebuilding the address from it: a wrong id would not produce it.
   */
  const recoverProtocolId = async (protocol: string): Promise<string | undefined> => {
    const history = await rpc.signatures(protocol)
    for (const signature of history.reverse()) {
      const transaction = await rpc.transaction(signature)
      if (transaction === null) continue
      const facts = factsFromTransaction(programId, transaction)
      const id = facts.hints.get(protocol)?.protocolId
      if (id !== undefined) return id
    }
    return undefined
  }

  const placeProtocols = async (accounts: readonly DecodedAccount[], hints: Hints) => {
    for (const account of accounts) {
      if (account.kind !== 'Protocol' || hints.get(account.address)?.protocolId !== undefined) {
        continue
      }
      const id = await recoverProtocolId(account.address)
      if (id !== undefined) addHint(hints, account.address, { protocolId: id })
    }
  }

  const write = async (rows: Rows) => {
    await upsertNewer(db, schema.config, rows.config)
    await upsertNewer(db, schema.protocols, rows.protocols)
    await upsertNewer(db, schema.pools, rows.pools)
    await upsertNewer(db, schema.policies, rows.policies)
    await upsertNewer(db, schema.declarations, rows.declarations, { keep: KEEP.declarations })
    await upsertNewer(db, schema.incidents, rows.incidents, { keep: KEEP.incidents })
    await upsertNewer(db, schema.attestations, rows.attestations, { keep: KEEP.attestations })
  }

  /**
   * Records where the chain was last read, with the cluster time of that slot: the API
   * reports it as `as_of` and computes `in_force` at it (T049). One `getBlockTime` per
   * census and per followed transaction — the slot read, not the transaction's own, is
   * the moment the written rows describe.
   */
  const setCursor = async (id: string, lastSlot: number, lastSignature: string | null) => {
    const blockTime = await rpc.blockTime(lastSlot)
    await db
      .insert(schema.indexerCursor)
      .values({ id, lastSlot, lastSignature, blockTime })
      .onConflictDoUpdate({
        target: schema.indexerCursor.id,
        set: { lastSlot, lastSignature, blockTime },
      })
  }

  // ── Provenance ──────────────────────────────────────────────────────────────────

  /** Writes a transaction-only column, but never over a value already there. */
  const fillIncident = async (address: string, values: IncidentProvenance) => {
    for (const [field, value] of Object.entries(values) as [
      keyof IncidentProvenance,
      number | string,
    ][]) {
      await db
        .update(schema.incidents)
        .set({ [field]: value })
        .where(and(eq(schema.incidents.address, address), isNull(INCIDENT_PROVENANCE[field])))
    }
  }

  const fillAttestation = async (address: string, signature: string) => {
    await db
      .update(schema.attestations)
      .set({ signature })
      .where(and(eq(schema.attestations.address, address), isNull(schema.attestations.signature)))
  }

  /**
   * Recovers, from each account's own history, the columns no census can see.
   *
   * Bounded by the rows that lack them: after the first pass over an existing program,
   * only what arrived while the socket was down is left, and a live transaction fills
   * its own. A node that no longer serves the history leaves the column `null` — which
   * the API reports as unknown, never as something else.
   */
  const recoverProvenance = async (only?: readonly string[]): Promise<number> => {
    let filled = 0
    const scope = only === undefined ? undefined : [...only]
    if (scope !== undefined && scope.length === 0) return 0

    const incidents = await db
      .select()
      .from(schema.incidents)
      .where(
        and(
          scope === undefined ? undefined : inArray(schema.incidents.address, scope),
          or(
            isNull(schema.incidents.openedSignature),
            isNull(schema.incidents.triggerSlot),
            and(eq(schema.incidents.status, 'paid_out'), isNull(schema.incidents.payoutSignature)),
          ),
        ),
      )

    for (const incident of incidents) {
      if (incident.triggerSlot === null) {
        const slot = await rpc.signatureSlot(incident.triggerSignature)
        if (slot !== null) {
          const time = await rpc.blockTime(slot)
          await fillIncident(incident.address, {
            triggerSlot: slot,
            ...(time === null ? {} : { triggerBlockTime: time }),
          })
          filled += 1
        }
      }
      if (incident.openedSignature !== null && incident.payoutSignature !== null) continue
      if (incident.openedSignature !== null && incident.status !== 'paid_out') continue

      const history = await rpc.signatures(incident.address)
      // The account is created by `open_incident`, so its oldest transaction is that one.
      const oldest = history.at(-1)
      if (incident.openedSignature === null && oldest !== undefined) {
        await fillIncident(incident.address, { openedSignature: oldest })
        filled += 1
      }
      if (incident.status === 'paid_out' && incident.payoutSignature === null) {
        // Nothing follows a payout, so `resolve` is the newest — walked rather than
        // assumed, in case something did.
        for (const signature of history) {
          const transaction = await rpc.transaction(signature)
          if (transaction === null) continue
          if (!instructionNames(programId, transaction).includes('resolve')) continue
          await fillIncident(incident.address, {
            payoutSignature: signature,
            payoutAt: transaction.blockTime,
          })
          filled += 1
          break
        }
      }
    }

    const attestations = await db
      .select({ address: schema.attestations.address })
      .from(schema.attestations)
      .where(
        and(
          scope === undefined ? undefined : inArray(schema.attestations.address, scope),
          isNull(schema.attestations.signature),
        ),
      )
    for (const { address } of attestations) {
      // Written once, by `attest`, and never again.
      const oldest = (await rpc.signatures(address)).at(-1)
      if (oldest === undefined) continue
      await fillAttestation(address, oldest)
      filled += 1
    }

    return filled
  }

  // ── The two paths ───────────────────────────────────────────────────────────────

  const census = async (): Promise<CensusReport> => {
    const read = await rpc.programAccounts()
    const accounts = read.accounts
      .map(({ address, data }) => decodeAccount(address, data))
      .filter((account): account is DecodedAccount => account !== null)

    const hints = await storedHints(
      accounts.filter((account) => account.kind === 'Protocol').map((account) => account.address),
    )
    relate(programId, accounts, hints, {
      attestors: accounts
        .filter((account) => account.kind === 'Attestor')
        .map((account) => (account.fields.authority as PublicKey).toBase58()),
    })
    await placeProtocols(accounts, hints)

    const { rows, unplaced } = toRows(
      programId,
      accounts,
      hints,
      read.slot,
      await assetDecimals(accounts),
    )
    await write(rows)
    if (unplaced.length > 0) {
      logger.warn(
        { unplaced: unplaced.length, sample: unplaced.slice(0, 5) },
        'census: unplaced accounts',
      )
    }
    const filled = await recoverProvenance()
    await setCursor('census', read.slot, null)

    const written = Object.fromEntries(
      Object.entries(rows).map(([table, list]) => [table, list.length]),
    ) as Record<keyof Rows, number>
    return { slot: read.slot, written, unplaced: unplaced.length, filled }
  }

  const handleSignature = async (signature: string): Promise<void> => {
    const transaction = await rpc.transaction(signature)
    if (transaction === null) return

    const facts = factsFromTransaction(programId, transaction)
    if (facts.touched.length === 0) return
    const read = await rpc.accounts(facts.touched)
    const accounts = read.accounts
      .map(({ address, data }) => decodeAccount(address, data))
      .filter((account): account is DecodedAccount => account !== null)

    const hints = await storedHints(accounts.map((account) => account.address))
    for (const [address, hint] of facts.hints) addHint(hints, address, hint)
    relate(programId, accounts, hints)
    await placeProtocols(accounts, hints)

    const { rows, unplaced } = toRows(
      programId,
      accounts,
      hints,
      read.slot,
      await assetDecimals(accounts),
    )
    await write(rows)
    if (unplaced.length > 0) {
      // The census places them from the whole picture; nothing is lost by waiting.
      logger.info({ signature, unplaced }, 'live: left for the census')
    }

    for (const fact of facts.provenance) {
      if (fact.table === 'attestations') await fillAttestation(fact.address, fact.signature)
      else if ('openedSignature' in fact) {
        await fillIncident(fact.address, { openedSignature: fact.openedSignature })
      } else {
        await fillIncident(fact.address, {
          payoutSignature: fact.payoutSignature,
          payoutAt: fact.payoutAt,
        })
      }
    }
    // The trigger's slot and time: a new incident's, read once while it is fresh.
    await recoverProvenance(rows.incidents.map((row) => row.address))
    await setCursor('live', read.slot, signature)
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | undefined

  return {
    census: () => enqueue(census),
    handleSignature: (signature: string) => enqueue(() => handleSignature(signature)),

    /**
     * Subscribes first and takes the census second, so nothing lands in the gap
     * between them: whatever the census misses, the subscription already queued.
     */
    start: async (): Promise<CensusReport> => {
      unsubscribe = rpc.onProgramLogs((signature, failed) => {
        if (failed) return
        enqueue(() => handleSignature(signature)).catch((error: unknown) => {
          logger.error({ signature, error: String(error) }, 'live: transaction not indexed')
        })
      })
      const report = await enqueue(census)
      timer = setInterval(() => {
        enqueue(census)
          .then((next) => logger.info(next, 'census'))
          .catch((error: unknown) => logger.error({ error: String(error) }, 'census failed'))
      }, censusIntervalSeconds * 1000)
      return report
    },

    stop: async (): Promise<void> => {
      if (timer !== undefined) clearInterval(timer)
      unsubscribe?.()
      await queue
    },
  }
}

// ── The real cluster ──────────────────────────────────────────────────────────────

const COMMITMENT: Commitment = 'finalized'

/** SPL mint layout: `mint_authority` (36) + `supply` (8), then `decimals`. */
const MINT_DECIMALS_OFFSET = 44

export const connectionIndexerRpc = (connection: Connection, programId: PublicKey): IndexerRpc => ({
  programAccounts: async () => {
    const { context, value } = await connection.getProgramAccounts(programId, {
      commitment: COMMITMENT,
      withContext: true,
    })
    return {
      slot: context.slot,
      accounts: value.map(({ pubkey, account }) => ({
        address: pubkey.toBase58(),
        data: account.data,
      })),
    }
  },

  accounts: async (addresses) => {
    const unique = [...new Set(addresses)]
    const accounts: { address: string; data: Buffer }[] = []
    let slot = 0
    // `getMultipleAccounts` takes at most a hundred keys.
    for (let start = 0; start < unique.length; start += 100) {
      const batch = unique.slice(start, start + 100)
      const { context, value } = await connection.getMultipleAccountsInfoAndContext(
        batch.map((address) => new Key(address)),
        COMMITMENT,
      )
      slot = Math.max(slot, context.slot)
      value.forEach((account, index) => {
        const address = batch[index]
        if (account !== null && address !== undefined && account.owner.equals(programId)) {
          accounts.push({ address, data: account.data })
        }
      })
    }
    return { slot, accounts }
  },

  transaction: async (signature) => {
    const fetched = await connection.getTransaction(signature, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 0,
    })
    return fetched === null ? null : toObservedTransaction(signature, fetched)
  },

  signatures: async (address) => {
    const found: string[] = []
    let before: string | undefined
    for (;;) {
      const page = await connection.getSignaturesForAddress(
        new Key(address),
        { limit: 1000, ...(before === undefined ? {} : { before }) },
        COMMITMENT,
      )
      for (const entry of page) if (entry.err === null) found.push(entry.signature)
      if (page.length < 1000) return found
      before = page.at(-1)?.signature
    }
  },

  signatureSlot: async (signature) => {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })
    return value[0]?.slot ?? null
  },

  blockTime: (slot) => connection.getBlockTime(slot),

  mintDecimals: async (mint) => {
    const account = await connection.getAccountInfo(new Key(mint), COMMITMENT)
    const value = account?.data[MINT_DECIMALS_OFFSET]
    if (value === undefined) throw new Error(`no mint at ${mint}`)
    return value
  },

  onProgramLogs: (callback) => {
    const id = connection.onLogs(
      programId,
      (logs) => callback(logs.signature, logs.err !== null),
      COMMITMENT,
    )
    return () => {
      void connection.removeOnLogsListener(id)
    }
  },
})
