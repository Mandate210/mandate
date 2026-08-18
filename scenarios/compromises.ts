// The corpus SC-003 is measured on: ten compromises of privileged access, staged as
// real transactions on a real cluster.
//
// **What these reproduce, and what they do not.** Each one is the *shape* a class of
// real compromise presents on chain — the instruction the attacker's transaction
// carries, who signed it, and how it stands against what the protocol had declared.
// None of them is a claim about any particular company's incident, and none of the
// addresses here belongs to anybody: the world is built from scratch on a local
// validator every run. That is the same line the SC-002 fixtures draw from the other
// side, where the transactions are real and the protocols are therefore named.
//
// **Every scenario is a real, confirmed transaction.** Nothing here hands the matcher a
// hand-written `ObservedTransaction`: the attestor reads these back off the cluster
// through the same path it uses in production, so the scenario exercises the RPC
// decoding, the flattening and the rule together. A scenario that only proved the rule
// would prove the part that was already covered by unit tests.
//
// The corpus splits in two on purpose. Seven scenarios are *operations* — a privileged
// key doing something it never declared, which is what most compromises look like. The
// last three are *timing and scope*: an operation smuggled alongside a declared one, an
// operation run before its declaration could take effect, and one run after the
// protocol revoked it. Those three are where a matcher that merely pattern-matched
// instruction names would pass the first seven and still miss the compromise.

import {
  createApproveCheckedInstruction,
  createApproveInstruction,
  createBurnInstruction,
  createFreezeAccountInstruction,
  createMintToInstruction,
  createRevokeInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  AuthorityType,
} from '@solana/spl-token'
import {
  type Connection,
  type Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'

/** Six decimals, as the settlement asset and every staged token here. */
export const UNIT = 1_000_000

export interface CompromiseWorld {
  connection: Connection
  /** Pays for staging. Never the privileged key: setup is not a compromise. */
  payer: Keypair
  /** The compromised key of this scenario's protocol. `null` for the multisig
   * scenario, whose privileged address has no key at all. */
  privileged: Keypair | null
  /** The privileged address, whether or not anything can sign for it. */
  privilegedAddress: PublicKey
  /** Where what is taken ends up. */
  attacker: Keypair
  /** Members of the multisig, for the one scenario whose authority is one. */
  members: Keypair[]
  /** A mint whose mint and freeze authority is the privileged address. */
  token: PublicKey
  /** Holds `token`, owned by the privileged address — the protocol's own funds. */
  treasury: PublicKey
  /** Holds `token`, owned by the attacker. */
  pocket: PublicKey
  /** Files a declaration for this protocol and returns once it is stored. */
  declare(input: {
    programId: PublicKey
    discriminator: number[]
    movesFunds?: boolean
  }): Promise<number>
  /** Withdraws one, effective immediately (FR-032). */
  revoke(seq: number): Promise<void>
  /** Sends and confirms, returning the signature. Signers beyond `payer` are given. */
  send(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string>
}

export interface Compromise {
  id: string
  /** The class of real incident whose on-chain shape this reproduces. */
  reproduces: string
  /**
   * SOL the privileged address has to be holding, for the one scenario that sweeps
   * native balance. Declared rather than given to everybody: on a validator a couple
   * of SOL a stage is free, and on devnet the same generosity is more than a whole
   * run can afford.
   */
  needsSol?: number
  /** Everything the attacker's world needs, done before any attestor is watching —
   * staging a mint is not a compromise, and an attestor judging it would be judging
   * the scenario's own scaffolding. */
  prepare?(world: CompromiseWorld): Promise<void>
  /** The moment the privileged access is used. Returns the offending signature. */
  fire(world: CompromiseWorld): Promise<string>
}

const signerFor = (world: CompromiseWorld): Keypair => {
  if (world.privileged === null) throw new Error(`${world.privilegedAddress} has no key to sign`)
  return world.privileged
}

export const COMPROMISES: Compromise[] = [
  {
    id: 'treasury-drain',
    reproduces: 'a stolen admin key moving the protocol’s own balance to an address it controls',
    fire: (world) =>
      world.send(
        [
          createTransferInstruction(
            world.treasury,
            world.pocket,
            world.privilegedAddress,
            500 * UNIT,
          ),
        ],
        [signerFor(world)],
      ),
  },
  {
    id: 'infinite-mint',
    reproduces: 'a mint authority that was never revoked, used to print supply out of nothing',
    fire: (world) =>
      world.send(
        [
          createMintToInstruction(
            world.token,
            world.pocket,
            world.privilegedAddress,
            1_000_000 * UNIT,
          ),
        ],
        [signerFor(world)],
      ),
  },
  {
    id: 'authority-handover',
    reproduces: 'privileged authority signed over to the attacker, so the theft outlives the key',
    fire: (world) =>
      world.send(
        [
          createSetAuthorityInstruction(
            world.token,
            world.privilegedAddress,
            AuthorityType.MintTokens,
            world.attacker.publicKey,
          ),
        ],
        [signerFor(world)],
      ),
  },
  {
    id: 'freeze-user-funds',
    reproduces: 'a retained freeze authority used to lock holders out while positions are unwound',
    fire: (world) =>
      world.send(
        [createFreezeAccountInstruction(world.pocket, world.token, world.privilegedAddress)],
        [signerFor(world)],
      ),
  },
  {
    id: 'burn-user-funds',
    reproduces: 'privileged access used to destroy balances rather than move them',
    fire: (world) =>
      world.send(
        [
          createBurnInstruction(
            world.treasury,
            world.token,
            world.privilegedAddress,
            100 * UNIT,
          ),
        ],
        [signerFor(world)],
      ),
  },
  {
    id: 'lamport-drain',
    reproduces: 'the native balance of the privileged account swept out alongside the token theft',
    // The 0.1 SOL below, plus room for the fee and the rent it keeps.
    needsSol: 0.12,
    fire: (world) =>
      world.send(
        [
          SystemProgram.transfer({
            fromPubkey: world.privilegedAddress,
            toPubkey: world.attacker.publicKey,
            lamports: 100_000_000,
          }),
        ],
        [signerFor(world)],
      ),
  },
  {
    id: 'multisig-executed-drain',
    reproduces:
      'a multisig-governed protocol whose privileged address cannot sign at all — the members sign and it is passed down as the authority',
    // The shape 5 of the 17 real upgrade authorities behind T025 are in, and the one
    // the matcher was blind to until T027. Nothing about it is a signature: the
    // privileged address is a token multisig, so no key for it exists anywhere, and it
    // appears in the instruction as a non-signing account.
    fire: (world) =>
      world.send(
        [
          createTransferInstruction(
            world.treasury,
            world.pocket,
            world.privilegedAddress,
            500 * UNIT,
            world.members,
          ),
        ],
        world.members,
      ),
  },
  {
    id: 'drain-behind-a-declared-operation',
    reproduces:
      'a genuine maintenance window used as cover, with the theft riding in the same transaction',
    prepare: async (world) => {
      // Declared honestly and long enough before the fact to be in force — which is
      // the point: the transaction below is half legitimate.
      await world.declare({
        programId: TOKEN_PROGRAM,
        discriminator: methodBytes(4),
        movesFunds: false,
      })
    },
    fire: (world) =>
      world.send(
        [
          createApproveInstruction(
            world.treasury,
            world.attacker.publicKey,
            world.privilegedAddress,
            1 * UNIT,
          ),
          createTransferInstruction(
            world.treasury,
            world.pocket,
            world.privilegedAddress,
            400 * UNIT,
          ),
        ],
        [signerFor(world)],
      ),
  },
  {
    id: 'acting-before-the-delay-elapses',
    reproduces:
      'a compromised authority declaring its own operation and running it at once, to make the theft look scheduled',
    // FR-031 is the whole defence here: the entry exists and names exactly this
    // operation, and it is still undeclared because it has not taken effect. Filed
    // inside `fire`, seconds before the operation, so no waiting can rescue it.
    fire: async (world) => {
      await world.declare({
        programId: TOKEN_PROGRAM,
        discriminator: methodBytes(13),
        movesFunds: true,
      })
      return world.send(
        [
          createApproveCheckedInstruction(
            world.treasury,
            world.token,
            world.attacker.publicKey,
            world.privilegedAddress,
            50 * UNIT,
            6,
          ),
        ],
        [signerFor(world)],
      )
    },
  },
  {
    id: 'acting-after-revocation',
    reproduces:
      'an operation the protocol had permitted and then withdrew, run anyway once the key was lost',
    prepare: async (world) => {
      const seq = await world.declare({
        programId: TOKEN_PROGRAM,
        discriminator: methodBytes(5),
        movesFunds: false,
      })
      revocations.set(world.privilegedAddress.toBase58(), seq)
    },
    // FR-032: revocation is immediate and only forward. The entry was effective, was
    // withdrawn, and the operation that follows is therefore undeclared — while
    // everything done while it stood stays declared.
    fire: async (world) => {
      const seq = revocations.get(world.privilegedAddress.toBase58())
      if (seq === undefined) throw new Error('acting-after-revocation was never prepared')
      await world.revoke(seq)
      return world.send(
        [createRevokeInstruction(world.treasury, world.privilegedAddress)],
        [signerFor(world)],
      )
    },
  },
]

/** Which declaration each protocol has to withdraw, filled in during preparation. */
const revocations = new Map<string, number>()

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

/**
 * The eight bytes a declaration entry is matched on, for an SPL Token instruction.
 *
 * One byte of opcode, zero-filled — the same width `METHOD_BYTES` gives the token
 * programs, and for the same reason: everything after the opcode is arguments, and an
 * entry that matched on those would be a different entry every time the amount changed.
 */
export const methodBytes = (opcode: number): number[] => [opcode, 0, 0, 0, 0, 0, 0, 0]

/** Builds, signs and confirms one transaction. */
export const sendWith = async (
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  signers: Keypair[],
): Promise<string> => {
  const transaction = new Transaction().add(...instructions)
  transaction.feePayer = payer.publicKey
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  transaction.recentBlockhash = blockhash

  const unique = new Map<string, Keypair>([[payer.publicKey.toBase58(), payer]])
  for (const signer of signers) unique.set(signer.publicKey.toBase58(), signer)
  transaction.sign(...unique.values())

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    preflightCommitment: 'confirmed',
  })
  const status = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  if (status.value.err !== null) {
    throw new Error(`staged transaction failed: ${JSON.stringify(status.value.err)}`)
  }
  return signature
}

/**
 * The control: a privileged operation that is entirely legitimate.
 *
 * Ten recognitions out of ten mean nothing on their own — a system that opened an
 * incident on every transaction it saw would score exactly the same. This is the
 * scenario that has to come out the other way, and it is the reason the ten above can
 * be read as recall rather than as noise.
 *
 * SC-002 makes this argument at scale, on 819 real mainnet transactions. This makes it
 * here, in the same run, against the same workers.
 */
export const LEGITIMATE: Compromise = {
  id: 'declared-maintenance',
  reproduces: 'nothing — the protocol doing what it told everyone it would do',
  prepare: async (world) => {
    await world.declare({
      programId: TOKEN_PROGRAM,
      discriminator: methodBytes(3),
      movesFunds: true,
    })
  },
  fire: (world) =>
    world.send(
      [createTransferInstruction(world.treasury, world.pocket, world.privilegedAddress, 1 * UNIT)],
      [signerFor(world)],
    ),
}
