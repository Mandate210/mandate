import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Failed to find the root element')

// `basename` from the build's own base URL, not hard-coded.
//
// Vite's `base` rewrites asset URLs, and nothing else: served from a project page at
// `/drain-cover/`, the router would still be matching paths against `/` and every
// route would miss. `import.meta.env.BASE_URL` is `/` for a normal build, so this is
// the same app locally and one that works under a subpath when built for one.
createRoot(rootElement).render(
  <BrowserRouter basename={import.meta.env.BASE_URL}>
    <App />
  </BrowserRouter>,
)
