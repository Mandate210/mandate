import { AnchorError, BN, type Program } from '@coral-xyz/anchor'
import {
  type DrainCover,
  createProgram,
  findAttestation,
  findAttestor,
  findIncident,
} from '@mandate/sdk'
import { type Keypair, SystemProgram } from '@solana/web3.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { type TestEnv, asset, setupTestEnv, validatorReachable, waitForNextEpoch } from './harness'
import {
  type RegisteredProtocol,
  admitAttestor,
  attest,
  ensureConfig,
  fundPool,
  issuePolicy,
  openIncident,
  registerProtocol,
  setAttestor,
} from './world'

const reachable = await validatorReachable()
const CAPITAL = asset(1_000_000)

describe.skipIf(!reachable)('attest', () => {
  let env: TestEnv
  let program: Program<DrainCover>
  let target: RegisteredProtocol
  let policySeq: number
  /** Admitted before the incident exists, so they are in the set it opened with. */
  let first: Keypair
  let second: Keypair
  /** Admitted after the incident opened — FR-008 keeps them out of it. */
  let latecomer: Keypair
  let incidentSeq: number

  const openOne = async (): Promise<number> =>
    (await openIncident(program, env, target, policySeq)).seq

  beforeAll(async () => {
    env = await setupTestEnv()
    program = createProgram(env.provider)
    await ensureConfig(program, env)

    first = await admitAttestor(program, env)
    second = await admitAttestor(program, env)
    // One boundary for both: membership starts with the next epoch, and waiting is
    // per epoch rather than per attestor.
    await waitForNextEpoch(env.connection)

    target = await registerProtocol(program, env)
    await fundPool(program, env, target, CAPITAL)
    policySeq = (
      await issuePolicy(program, env, target, {
        limit: asset(500_000),
        retention: asset(50_000),
        premium: asset(4_000),
      })
    ).seq

    incidentSeq = await openOne()
    latecomer = await admitAttestor(program, env)
    await waitForNextEpoch(env.connection)
  })

  it('records a verdict and tallies it on the incident', async () => {
    const attestation = await attest(program, target, incidentSeq, first)

    const stored = await program.account.attestation.fetch(attestation)
    expect(stored.verdict).toEqual({ unauthorized: {} })
    expect(stored.submittedAt.toNumber()).toBeGreaterThan(0)

    const incident = await program.account.incident.fetch(
      findIncident(program.programId, target.protocol, incidentSeq),
    )
    // Tallied on the incident rather than counted from the attestation accounts:
    // the program cannot enumerate PDAs, and a tally assembled by the caller is a
    // tally the caller can misreport.
    expect(incident.votesUnauthorized).toBe(1)
    expect(incident.votesAuthorized).toBe(0)
    expect(incident.status).toEqual({ open: {} })
  })

  it('counts a dissenting verdict separately', async () => {
    await attest(program, target, incidentSeq, second, 'authorized')

    const incident = await program.account.incident.fetch(
      findIncident(program.programId, target.protocol, incidentSeq),
    )
    expect(incident.votesUnauthorized).toBe(1)
    expect(incident.votesAuthorized).toBe(1)
  })

  it('refuses a second attestation from the same attestor', async () => {
    // FR-009 without a check in our code: the address derives from
    // (incident, attestor), so the runtime refuses to create it twice.
    await expect(attest(program, target, incidentSeq, first)).rejects.toThrow()

    const incident = await program.account.incident.fetch(
      findIncident(program.programId, target.protocol, incidentSeq),
    )
    expect(incident.votesUnauthorized).toBe(1)
  })

  it('refuses an attestor admitted after the incident opened', async () => {
    // In the set now, and active — but not in the set the incident opened with.
    const account = await program.account.attestor.fetch(
      findAttestor(program.programId, latecomer.publicKey),
    )
    expect(account.inSet).toBe(true)

    const error = await attest(program, target, incidentSeq, latecomer).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('AttestorNotActive')
  })

  it('refuses an attestor who has been removed', async () => {
    const removed = await admitAttestor(program, env)
    await waitForNextEpoch(env.connection)
    const seq = await openOne()
    await setAttestor(program, env, removed.publicKey, false)

    // Removal is immediate, so it lands even on an incident already in flight.
    const error = await attest(program, target, seq, removed).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AnchorError)
    expect((error as AnchorError).error.errorCode.code).toBe('AttestorNotActive')
  })

  it('refuses an address that was never admitted', async () => {
    const stranger = await env.fundedKeypair(2)
    const incident = findIncident(program.programId, target.protocol, incidentSeq)

    // No attestor account at all, so the seeds resolve to an address that holds
    // nothing — the constraint fails before any verdict is counted.
    await expect(
      program.methods
        .attest(new BN(incidentSeq), { unauthorized: {} })
        .accountsPartial({
          protocol: target.protocol,
          incident,
          attestorAuthority: stranger.publicKey,
          attestor: findAttestor(program.programId, stranger.publicKey),
          attestation: findAttestation(program.programId, incident, stranger.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc(),
    ).rejects.toThrow()
  })
})
