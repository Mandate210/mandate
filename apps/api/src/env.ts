// The repository's `.env`, for running the api and its commands locally.
//
// Node's own loader rather than a dependency. It never overrides a variable that is
// already set, so on a host that provides its environment the file is simply absent
// and nothing changes.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url))

export const loadRepoEnv = (): void => {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}
