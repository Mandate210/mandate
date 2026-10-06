// SC-007 by hand: replay the decision on one incident against a live RPC (T056).
//
//   pnpm --filter @mandate/tests sc007 <incident> [--api <url>] [--record]
//
// Takes the trail from the API — the only thing it asks the API — and everything else
// from `SOLANA_RPC_URL`. Prints what the rule and the chain say and every place the
// trail disagrees with them. `--record` also writes the trail and the raw RPC answers
// to `tests/__fixtures__/sc007/<incident>.json`, which `sc007-trail.test.ts` replays
// offline in `pnpm gate`.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createJsonRpc } from '@mandate/sdk'
import { incidentDetailResponseSchema } from '@mandate/shared'
import { replayDecision } from './replay'
import { type Recording, recordingRpc } from './rpc'

const ENV = new URL('../../.env', import.meta.url)
const FIXTURES = new URL('../__fixtures__/sc007/', import.meta.url)

const main = async (): Promise<number> => {
  const args = process.argv.slice(2)
  const [incident] = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--api')
  const apiIndex = args.indexOf('--api')
  const api = apiIndex === -1 ? 'http://127.0.0.1:3000' : args[apiIndex + 1]
  const record = args.includes('--record')
  if (incident === undefined || api === undefined) {
    console.error('usage: sc007 <incident> [--api <url>] [--record]')
    return 2
  }

  if (existsSync(ENV)) process.loadEnvFile(ENV)
  const endpoint = process.env.SOLANA_RPC_URL
  if (endpoint === undefined || endpoint === '') {
    console.error('SOLANA_RPC_URL is not set')
    return 2
  }

  const started = performance.now()
  const response = await fetch(`${api}/incidents/${incident}`)
  if (!response.ok) {
    console.error(`${api} answered ${response.status} for ${incident}`)
    return 1
  }
  const trail = incidentDetailResponseSchema.parse(await response.json())

  const recording: Recording = {}
  const live = createJsonRpc(endpoint)
  const replay = await replayDecision(trail, record ? recordingRpc(live, recording) : live)
  const seconds = ((performance.now() - started) / 1000).toFixed(1)

  console.log(`incident   ${incident}`)
  console.log(
    `verdict    ${replay.verdict.status}${'basis' in replay.verdict ? ` (${replay.verdict.basis})` : ''}`,
  )
  for (const entry of replay.entries) console.log(`entry      ${entry.address} ${entry.state}`)
  console.log(
    `quorum     ${trail.incident.votes_unauthorized} unauthorized, ${replay.quorumNeeded} needed`,
  )
  console.log(`owed       ${replay.owed}`)
  console.log(`status     ${trail.incident.status}, paid ${trail.incident.payout}`)
  console.log(`replayed   in ${seconds} s, ${replay.problems.length} problem(s)`)
  for (const problem of replay.problems) console.log(`  ${problem.code}: ${problem.message}`)

  if (record) {
    mkdirSync(FIXTURES, { recursive: true })
    const file = new URL(`${incident}.json`, FIXTURES)
    // LF and a trailing newline, as every other committed file.
    writeFileSync(file, `${JSON.stringify({ trail, recording }, null, 2)}\n`)
    console.log(`recorded   ${file.pathname}`)
  }
  return replay.problems.length === 0 ? 0 : 1
}

// `exitCode`, not `exit()`: Node 26 on Windows trips a libuv assertion when it exits
// with requests in flight.
process.exitCode = await main()
