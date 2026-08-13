#!/usr/bin/env node
// Collects real privileged transactions from mainnet into the fixtures SC-002 is
// measured on (T025).
//
// **Every address here comes off the chain, none from a list someone typed.** The
// pipeline starts at a recent block, takes the programs that appear in it, reads each
// program's upgrade authority out of its ProgramData account, and then fetches the
// transactions those authorities took part in. A fixture set assembled from remembered
// addresses would be a set of guesses about who is privileged; this one is derived, and
// every step of the derivation is in the fixture's `provenance`.
//
// **Took part in, not signed.** A privileged address is very often off-curve — a
// multisig's, with no keypair anywhere — and cannot appear among a transaction's
// signers however much authority it holds. Collecting only signed transactions produced
// a fixture set with no multisig protocol in it at all, which is how the matching rule
// came to have a permanent blind spot over them.
//
//   node packages/shared/scripts/fetch-privileged.mjs --rpc <url> [--target 200]
//
// The endpoint is a parameter because the public mainnet one is not reachable
// everywhere (docs/PLAN.md → «Фікстури SC-002»).

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'src', '__fixtures__', 'privileged')

const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
/** `UpgradeableLoaderState::Program` — a 4-byte tag then the ProgramData address. */
const PROGRAM_TAG = 2
/** `UpgradeableLoaderState::ProgramData` — tag, slot, then an optional authority. */
const PROGRAM_DATA_TAG = 3

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const base58Encode = (bytes) => {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1

  const digits = []
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index]
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += digits[digit] << 8
      digits[digit] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  // A leading zero byte is a leading '1', and it has to be carried separately: the
  // arithmetic above cannot tell one leading zero from ten.
  return (
    '1'.repeat(zeros) +
    digits
      .reverse()
      .map((digit) => ALPHABET[digit])
      .join('')
  )
}

const base58Decode = (text) => {
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros += 1

  const bytes = []
  for (let index = zeros; index < text.length; index += 1) {
    const value = ALPHABET.indexOf(text[index])
    if (value === -1) throw new Error(`not base58: ${text[index]}`)
    let carry = value
    for (let byte = 0; byte < bytes.length; byte += 1) {
      carry += bytes[byte] * 58
      bytes[byte] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()])
}

/** Both directions, checked against values whose answer is known, before any fetching:
 * a wrong codec here would silently produce fixtures about the wrong addresses. */
const selfCheck = () => {
  const systemProgram = base58Encode(new Uint8Array(32))
  if (systemProgram !== '11111111111111111111111111111111') {
    throw new Error(`base58 encoder is wrong: 32 zero bytes gave ${systemProgram}`)
  }
  const roundTrip = base58Encode(base58Decode(BPF_UPGRADEABLE_LOADER))
  if (roundTrip !== BPF_UPGRADEABLE_LOADER) {
    throw new Error(`base58 round trip is wrong: ${roundTrip}`)
  }
}

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const RPC = argument('rpc', process.env.MAINNET_RPC_URL ?? 'https://solana-rpc.publicnode.com')
const TARGET = Number(argument('target', '200'))
const BLOCKS = Number(argument('blocks', '3'))
const SIGNATURES_PER_AUTHORITY = Number(argument('per-authority', '60'))
/** How many upgrade authorities to look at. Most of them turn out never to sign, so
 * this has to be several times the number of protocols the fixtures end up with. */
const AUTHORITY_LIMIT = Number(argument('authorities', '12'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let calls = 0
const call = async (method, params, attempt = 0) => {
  calls += 1
  // Paced rather than parallel: this runs against somebody's free endpoint, and a
  // fixture set is not worth being rude for.
  await sleep(120)
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (response.status === 429 && attempt < 5) {
    await sleep(1_000 * 2 ** attempt)
    return call(method, params, attempt + 1)
  }
  const body = await response.json()
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

/** Static keys first, then the ones an address table supplied — the order the runtime
 * uses to resolve `programIdIndex`. */
const accountKeysOf = (transaction) => [
  ...transaction.transaction.message.accountKeys,
  ...(transaction.meta?.loadedAddresses?.writable ?? []),
  ...(transaction.meta?.loadedAddresses?.readonly ?? []),
]

const signersOf = (transaction) =>
  transaction.transaction.message.accountKeys.slice(
    0,
    transaction.transaction.message.header.numRequiredSignatures,
  )

/** `json` encoding gives account *indices*; the rule matches on addresses. Resolved
 * here rather than at read time so the fixture states which accounts an instruction
 * took without anybody having to re-derive the index table. */
const instructionOf = (instruction, keys) => ({
  programId: keys[instruction.programIdIndex],
  /** Base58, verbatim as the RPC returned it. */
  data: instruction.data,
  accounts: (instruction.accounts ?? []).map((index) => keys[index]),
  ...(instruction.stackHeight == null ? {} : { stackHeight: instruction.stackHeight }),
})

const main = async () => {
  selfCheck()
  console.log(`rpc: ${RPC}`)

  const finalized = await call('getSlot', [{ commitment: 'finalized' }])
  const firstAvailableBlock = await call('getFirstAvailableBlock', [])
  console.log(
    `history window: slots ${firstAvailableBlock}..${finalized} ` +
      `(${finalized - firstAvailableBlock} slots, about ${Math.round(((finalized - firstAvailableBlock) * 0.4) / 86_400)} days)`,
  )
  const programUse = new Map()
  for (let index = 0; index < BLOCKS; index += 1) {
    const slot = finalized - 300 - index * 500
    const block = await call('getBlock', [
      slot,
      {
        encoding: 'json',
        transactionDetails: 'full',
        maxSupportedTransactionVersion: 0,
        rewards: false,
      },
    ])
    for (const transaction of block.transactions) {
      const keys = accountKeysOf(transaction)
      for (const instruction of transaction.transaction.message.instructions) {
        const programId = keys[instruction.programIdIndex]
        if (programId) programUse.set(programId, (programUse.get(programId) ?? 0) + 1)
      }
    }
    console.log(`block ${slot}: ${block.transactions.length} transactions`)
  }

  const candidates = [...programUse.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  console.log(`distinct programs seen: ${candidates.length}`)

  /** program id → its upgrade authority, for the ones that have one. */
  const authorities = new Map()
  for (const programId of candidates) {
    if (authorities.size >= AUTHORITY_LIMIT) break
    const program = await call('getAccountInfo', [programId, { encoding: 'base64' }])
    if (!program?.value || program.value.owner !== BPF_UPGRADEABLE_LOADER) continue

    const programAccount = Buffer.from(program.value.data[0], 'base64')
    if (programAccount.length !== 36 || programAccount.readUInt32LE(0) !== PROGRAM_TAG) continue
    const programDataAddress = base58Encode(programAccount.subarray(4))

    const programData = await call('getAccountInfo', [
      programDataAddress,
      { encoding: 'base64', dataSlice: { offset: 0, length: 45 } },
    ])
    if (!programData?.value) continue
    const state = Buffer.from(programData.value.data[0], 'base64')
    if (state.readUInt32LE(0) !== PROGRAM_DATA_TAG) continue
    // tag(4) + last_deploy_slot(8) + Option tag(1) + authority(32). A zero option byte
    // is an immutable program — nobody is privileged over it, so it is not our case.
    if (state[12] !== 1) continue

    authorities.set(programId, base58Encode(state.subarray(13, 45)))
    console.log(`authority found: program ${programId} → ${authorities.get(programId)}`)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  // One run, one coherent snapshot: files left by an earlier run would mix samples
  // taken hours apart under a single `skipped.json`, and nothing downstream could tell.
  for (const stale of readdirSync(OUT_DIR)) {
    if (stale.endsWith('.json')) rmSync(join(OUT_DIR, stale))
  }
  const fetchedAt = new Date().toISOString()
  let collected = 0
  const skipped = []

  for (const [programId, authority] of authorities) {
    if (collected >= TARGET) break

    const signatures = await call('getSignaturesForAddress', [
      authority,
      { limit: SIGNATURES_PER_AUTHORITY },
    ])
    const transactions = []
    let signedCount = 0
    for (const { signature, err } of signatures) {
      if (err) continue
      const transaction = await call('getTransaction', [
        signature,
        { encoding: 'json', maxSupportedTransactionVersion: 0 },
      ])
      if (!transaction) continue

      const keys = accountKeysOf(transaction)
      // Involvement, not signature. Dropping everything the authority did not sign is
      // what made every multisig-governed protocol invisible: 5 of the 17 authorities
      // this pipeline finds are off-curve, so a signature of theirs cannot exist at all
      // (docs/PLAN.md → «Мультисиг і привілейовані PDA»).
      if (!keys.includes(authority)) continue

      const signers = signersOf(transaction)
      if (signers.includes(authority)) signedCount += 1

      transactions.push({
        signature,
        slot: transaction.slot,
        blockTime: transaction.blockTime,
        signers,
        accountKeys: keys,
        instructions: transaction.transaction.message.instructions.map((instruction) =>
          instructionOf(instruction, keys),
        ),
        /** Kept grouped the way the RPC reports them, by the top-level instruction that
         * caused them. `flattenInstructions` is the one place that puts them in order. */
        innerInstructions: (transaction.meta?.innerInstructions ?? []).map((group) => ({
          index: group.index,
          instructions: group.instructions.map((instruction) => instructionOf(instruction, keys)),
        })),
      })
    }

    if (transactions.length === 0) {
      // Recorded rather than dropped, and the wording matters: this is «nothing in the
      // window this endpoint keeps», not «this address never acts». A public endpoint
      // holds days, not history — the first run of this script called it «never appears
      // as a signer» and overstated what had been measured.
      skipped.push({
        programId,
        authority,
        reason: 'no transaction mentioning the authority within the endpoint’s history window',
      })
      console.log(`skipped ${authority}: nothing in the window`)
      continue
    }

    const fixture = {
      provenance: {
        cluster: 'mainnet-beta',
        rpc: RPC,
        fetchedAt,
        /** How this address was found to be privileged, so the claim is checkable. */
        derivedFrom: `upgrade authority of program ${programId}, read from its ProgramData account`,
        /** The oldest slot this endpoint could serve when the snapshot was taken —
         * the bound on every «never» a reader might infer from these files. */
        firstAvailableBlock,
      },
      authority,
      programId,
      /** How the authority took part, counted at collection time so the split between
       * the two branches of the rule is visible without re-deriving it. */
      signed: signedCount,
      involvedOnly: transactions.length - signedCount,
      transactions,
    }
    writeFileSync(
      join(OUT_DIR, `${authority}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
      'utf8',
    )
    collected += transactions.length
    console.log(`wrote ${authority}.json: ${transactions.length} transactions (${collected} total)`)
  }

  writeFileSync(
    join(OUT_DIR, 'skipped.json'),
    `${JSON.stringify({ fetchedAt, firstAvailableBlock, finalized, skipped }, null, 2)}\n`,
    'utf8',
  )
  console.log(`\ncollected ${collected} transactions in ${calls} RPC calls`)
  if (collected < TARGET) {
    console.log(`short of the ${TARGET} SC-002 asks for — widen --blocks or --per-authority`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
