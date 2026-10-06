import { readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { createApp } from '@mandate/api/app'
import { describe, expect, it } from 'vitest'
import { httpSource } from '../apps/web/src/lib/source'

// FR-034: every action is a transaction signed outside the system, so the status page
// can neither sign nor write. Held mechanically, like the program id in
// `config-consistency.test.ts`: a wallet button would otherwise arrive with a landing
// page and nobody would notice the requirement was gone.

const root = join(import.meta.dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

// ---------------------------------------------------------------------------------
// The dependency closure of apps/web, from the lockfile — transitive, so a wallet
// that arrives through a UI kit or a workspace package counts the same as a direct one.

type Deps = Map<string, string>
interface Lock {
  importers: Map<string, { dependencies: Deps; devDependencies: Deps }>
  snapshots: Map<string, Deps>
}

const unquote = (s: string): string => s.replace(/^'(.*)'$/, '$1')

/** The two sections of a v9 `pnpm-lock.yaml` the closure needs; nothing else is read. */
const parseLock = (text: string): Lock => {
  const importers: Lock['importers'] = new Map()
  const snapshots: Lock['snapshots'] = new Map()
  let section = ''
  let owner: Deps[] = []
  let field = ''
  let pending = ''

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    if (indent === 0) {
      section = body.replace(/:$/, '')
      continue
    }
    if (section === 'importers') {
      if (indent === 2) {
        const entry = { dependencies: new Map(), devDependencies: new Map() }
        importers.set(unquote(body.replace(/:$/, '')), entry)
        owner = [entry.dependencies, entry.devDependencies]
      } else if (indent === 4) {
        field = body.replace(/:$/, '')
      } else if (indent === 6) {
        pending = unquote(body.replace(/:$/, ''))
      } else if (indent === 8 && body.startsWith('version: ')) {
        const target =
          field === 'dependencies' ? owner[0] : field === 'devDependencies' ? owner[1] : undefined
        target?.set(pending, body.slice('version: '.length))
      }
    } else if (section === 'snapshots') {
      if (indent === 2) {
        const deps: Deps = new Map()
        snapshots.set(unquote(body.replace(/:( \{\})?$/, '')), deps)
        owner = [deps]
      } else if (indent === 4) {
        field = body.replace(/:$/, '')
      } else if (indent === 6 && (field === 'dependencies' || field === 'optionalDependencies')) {
        const at = body.indexOf(': ')
        owner[0]?.set(unquote(body.slice(0, at)), body.slice(at + 2))
      }
    }
  }
  return { importers, snapshots }
}

/**
 * Every package name reachable from `importer`. Its devDependencies count: Vite bundles
 * whatever `src` imports, whichever list declared it. A linked workspace package brings
 * only its own dependencies, the way it is installed for a consumer.
 */
const closureOf = (lock: Lock, importer: string): Set<string> => {
  const names = new Set<string>()
  const seen = new Set<string>()
  const start = lock.importers.get(importer)
  if (start === undefined) throw new Error(`${importer} is not an importer in pnpm-lock.yaml`)
  const queue: { from: string; deps: Deps }[] = [
    { from: importer, deps: start.dependencies },
    { from: importer, deps: start.devDependencies },
  ]

  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    for (const [name, version] of next.deps) {
      names.add(name)
      if (version.startsWith('link:')) {
        const path = posix.normalize(posix.join(next.from, version.slice('link:'.length)))
        if (seen.has(`link:${path}`)) continue
        seen.add(`link:${path}`)
        const linked = lock.importers.get(path)
        if (linked === undefined) throw new Error(`${name} links to ${path}, not an importer`)
        queue.push({ from: path, deps: linked.dependencies })
        continue
      }
      // An alias (`npm:`) resolves to `real@version`; the real name is the one that matters.
      const alias = /^(@?[^@(]+)@(.+)$/.exec(version)
      const key = alias === null ? `${name}@${version}` : version
      if (alias !== null) names.add(alias[1] ?? name)
      if (seen.has(key)) continue
      seen.add(key)
      const deps = lock.snapshots.get(key)
      // An unresolved entry would end the walk quietly and pass the guard on a stub.
      if (deps === undefined) throw new Error(`no snapshot for ${key} in pnpm-lock.yaml`)
      queue.push({ from: importer, deps })
    }
  }
  return names
}

/** What could sign, build or send a transaction, or hold a session: none of it belongs in web. */
const CANNOT_SIGN: { pattern: RegExp; why: string }[] = [
  { pattern: /^@solana\//, why: 'Solana client libraries build and sign transactions' },
  { pattern: /^@wallet-standard\//, why: 'wallet discovery and connection' },
  { pattern: /^@coral-xyz\/anchor$/, why: 'Anchor client sends program instructions' },
  { pattern: /^@mandate\/sdk$/, why: 'our program client builds instructions' },
  { pattern: /^@walletconnect\//, why: 'remote wallet sessions' },
  { pattern: /^@reown\/|^@web3modal\//, why: 'wallet connection modal' },
  { pattern: /^@privy-io\//, why: 'embedded wallets and auth sessions (C-2)' },
  { pattern: /^@dynamic-labs\//, why: 'embedded wallets and auth sessions' },
  { pattern: /^@phantom\/|^@solflare-wallet\/|^@backpack\//, why: 'wallet SDK' },
  { pattern: /^(tweetnacl|@noble\/ed25519)$/, why: 'ed25519 signing primitive' },
]

/** HTTP clients other than `fetch` would be a second way out, past `httpSource`. */
const SECOND_CLIENT =
  /^(axios|ky|ofetch|superagent|got|graphql-request|@apollo\/client|socket\.io-client|@supabase\/.*)$/

const banned = (names: Iterable<string>): string[] =>
  [...names].flatMap((name) => {
    const hit = CANNOT_SIGN.find(({ pattern }) => pattern.test(name))
    if (hit !== undefined) return [`${name} — ${hit.why}`]
    return SECOND_CLIENT.test(name) ? [`${name} — a network client besides httpSource`] : []
  })

describe('web cannot sign: no wallet in its dependency closure (FR-034)', () => {
  const lock = parseLock(read('pnpm-lock.yaml'))
  const closure = closureOf(lock, 'apps/web')

  it('walks the whole closure, not just the direct list', () => {
    // `scheduler` comes only through react-dom, `zod` only through the linked
    // @mandate/shared: a walk that stopped early or skipped links would miss them.
    expect(closure.has('scheduler')).toBe(true)
    expect(closure.has('zod')).toBe(true)
    expect(closure.size).toBeGreaterThan(100)
  })

  it('reaches none of the banned packages', () => {
    expect(banned(closure)).toEqual([])
  })

  it('would catch one arriving transitively', () => {
    const planted = parseLock(
      [
        'importers:',
        '  apps/web:',
        '    dependencies:',
        "      '@mandate/shared':",
        '        version: link:../../packages/shared',
        '  packages/shared:',
        '    dependencies:',
        '      ui-kit:',
        '        version: 1.0.0',
        'snapshots:',
        '  ui-kit@1.0.0:',
        '    dependencies:',
        "      '@solana/wallet-adapter-react': 0.15.0",
        "  '@solana/wallet-adapter-react@0.15.0': {}",
      ].join('\n'),
    )
    expect(banned(closureOf(planted, 'apps/web'))).toEqual([
      '@solana/wallet-adapter-react — Solana client libraries build and sign transactions',
    ])
  })
})

// ---------------------------------------------------------------------------------
// The source: an injected provider (Phantom, Backpack…) signs with no package at all.

const sourceFiles = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

const WEB_SOURCES = sourceFiles('apps/web/src')
const NETWORK_EXIT = 'apps/web/src/lib/source.ts'

const findings = (files: string[], patterns: RegExp[]): string[] =>
  files.flatMap((file) =>
    read(file)
      .split('\n')
      .flatMap((line, i) =>
        patterns.some((p) => p.test(line))
          ? [`${relative(root, join(root, file)).replaceAll('\\', '/')}:${i + 1}: ${line.trim()}`]
          : [],
      ),
  )

const INJECTED_WALLET = [
  /\b(window|globalThis|self)\s*(\.|\?\.|\[\s*['"`])\s*(solana|phantom|backpack|solflare|xnft|ethereum)\b/,
  /\b(signTransaction|signAllTransactions|signAndSendTransaction|signMessage|requestAccounts)\b/,
  /wallet-standard:/,
  /\bnavigator\s*\.\s*wallets\b/,
]

const NETWORK = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bsendBeacon\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /<form\b/,
]

describe('web source neither reaches a wallet nor writes (FR-034)', () => {
  it('scans real files', () => {
    expect(WEB_SOURCES).toContain(NETWORK_EXIT)
    expect(WEB_SOURCES.length).toBeGreaterThan(20)
  })

  it('touches no injected wallet provider', () => {
    expect(findings(WEB_SOURCES, INJECTED_WALLET)).toEqual([])
  })

  it('goes out to the network only through httpSource', () => {
    const elsewhere = WEB_SOURCES.filter((file) => file !== NETWORK_EXIT)
    expect(findings(elsewhere, NETWORK)).toEqual([])
    // The control: the same patterns do see the one exit there is.
    expect(findings([NETWORK_EXIT], NETWORK)).not.toEqual([])
  })

  it('loads no script from outside the bundle', () => {
    const scripts = [...read('apps/web/index.html').matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
    expect(scripts.length).toBeGreaterThan(0)
    expect(scripts.filter((tag) => /\bsrc\s*=\s*["']?(https?:)?\/\//.test(tag))).toEqual([])
  })

  it('httpSource sends GET with no body, whatever it is asked for', async () => {
    const sent: (RequestInit | undefined)[] = []
    const source = httpSource('https://api.example/', async (_url, init) => {
      sent.push(init)
      return new Response('{}', { status: 200 })
    })
    for (const path of ['/health', '/pools', '/incidents?status=open']) await source(path)

    expect(sent).toHaveLength(3)
    for (const init of sent) {
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.body ?? null).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------------
// The other side: the API it reads from has no endpoint that accepts a write.

type AppDb = Parameters<typeof createApp>[0]['db']

describe('the API web reads from accepts no write (FR-034)', () => {
  // No handler below should reach a database; one that does fails loudly here.
  const untouchable = new Proxy(
    {},
    {
      get: () => {
        throw new Error('a route reached the database')
      },
    },
  ) as AppDb
  // A limit nobody reaches, so a 429 cannot stand in for the answer being checked.
  const app = createApp({ db: untouchable, tip: async () => 0, limit: { perMinute: 100_000 } })

  it('registers handlers for GET only; ALL is middleware on every path', () => {
    const routes = app.routes.map(({ method, path }) => `${method} ${path}`)
    expect(routes).toContain('GET /incidents')
    expect(app.routes.filter(({ method }) => method !== 'GET' && method !== 'ALL')).toEqual([])
    expect(app.routes.filter(({ method, path }) => method === 'ALL' && path !== '/*')).toEqual([])
  })

  it('answers 404 to every write method on every route', async () => {
    const paths = [...new Set(app.routes.filter((r) => r.method === 'GET').map((r) => r.path))]
    expect(paths.length).toBeGreaterThan(5)

    const answers: string[] = []
    for (const pattern of paths) {
      const path = pattern.replace(/:[^/]+/g, '11111111111111111111111111111111')
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await app.request(path, { method, body: '{}' })
        if (response.status !== 404) answers.push(`${method} ${path} → ${response.status}`)
      }
    }
    expect(answers).toEqual([])
  })
})
