// The process around `run`: a terminal to confirm on, and an exit status.

import { createInterface } from 'node:readline/promises'
import { run } from './declare'

// Run through `pnpm --filter @mandate/cli declare`, the process starts in apps/cli and
// pnpm 9 passes a `--` through as an argument. Back to where the command was typed, so a
// relative --keypair or --idl means what it says, and without the stray separator.
if (process.env.INIT_CWD !== undefined) process.chdir(process.env.INIT_CWD)
const argv = process.argv.slice(2)
if (argv[0] === '--') argv.shift()

const main = async (): Promise<number> => {
  const terminal = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined
  try {
    return await run(argv, {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      confirm:
        terminal === undefined
          ? undefined
          : async (question) => /^y(es)?$/i.test((await terminal.question(question)).trim()),
    })
  } finally {
    terminal?.close()
  }
}

// `exitCode`, not `exit()`: after an RPC round trip on Windows, Node 26 turns an
// explicit exit into a libuv assertion and status 127.
process.exitCode = await main()
