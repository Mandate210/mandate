// What GitHub Pages needs on top of a plain Vite build, and why.
//
// **`404.html`.** Pages serves static files and knows nothing about client-side
// routes, so a visitor opening `/mandate/incident/…` directly — a shared link,
// a refresh, a bookmark — gets a 404 for a page this app can render perfectly well.
// Pages serves `404.html` for any path it cannot find, so a copy of `index.html`
// under that name hands control back to the router. Only the first paint differs;
// the URL is untouched, so the route resolves normally.
//
// **`.nojekyll`.** Pages runs Jekyll over the output unless told not to, and Jekyll
// drops files and directories whose names start with an underscore. Vite does not
// emit any today, which is exactly why this is worth a zero-byte file rather than a
// habit of checking after every dependency bump.

import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(fileURLToPath(new URL('..', import.meta.url)), 'dist')

copyFileSync(join(dist, 'index.html'), join(dist, '404.html'))
writeFileSync(join(dist, '.nojekyll'), '')

console.log('pages: wrote 404.html and .nojekyll')
