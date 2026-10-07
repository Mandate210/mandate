// What GitHub Pages needs on top of a plain Vite build, and why.
//
// **`404.html`.** Pages serves static files and knows nothing about client-side
// routes, so a visitor opening `/mandate/app/incident/…` directly — a shared link,
// a refresh, a bookmark — gets a 404 for a page this app can render perfectly well.
// Pages serves the **site root's** `404.html` for any path it cannot find, so the
// workflow moves this file to the root of the site, beside the landing page, and the
// app's own shell takes over: the URL is untouched and the route resolves normally.
//
// **Links from before the landing page.** Until T072 the app sat at the site root, and
// links to `/mandate/incident/…` were handed out (M1). The copy carries a script that
// runs before anything else: a path under the site root but outside the app's base is
// sent to the same route inside it, with its query and hash. With the app at the root
// (`base` = `/`, a local build) the two coincide and nothing is ever rewritten.
//
// **`.nojekyll`.** Pages runs Jekyll over the output unless told not to, and Jekyll
// drops files and directories whose names start with an underscore. Vite does not
// emit any today, which is exactly why this is worth a zero-byte file rather than a
// habit of checking after every dependency bump.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(fileURLToPath(new URL('..', import.meta.url)), 'dist')
const base = process.env.BASE_PATH || '/'

const forward = `<script>
      ;(function () {
        var app = ${JSON.stringify(base)}
        var root = app.replace(/app\\/$/, '')
        var path = location.pathname
        if (path.indexOf(app) !== 0 && path.indexOf(root) === 0) {
          location.replace(app + path.slice(root.length) + location.search + location.hash)
        }
      })()
    </script>`

const index = readFileSync(join(dist, 'index.html'), 'utf8')
if (!index.includes('<head>')) throw new Error('pages: no <head> in dist/index.html')
writeFileSync(join(dist, '404.html'), index.replace('<head>', `<head>\n    ${forward}`))
writeFileSync(join(dist, '.nojekyll'), '')

console.log(`pages: wrote 404.html (app at ${base}) and .nojekyll`)
