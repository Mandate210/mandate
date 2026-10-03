import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { createQueryClient } from './lib/api'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Failed to find the root element')

// One client for the app's life: its cache is what lets a page revisited show the last
// answer at once while the next one is fetched.
const queryClient = createQueryClient()

// `basename` from the build's own base URL, not hard-coded.
//
// Vite's `base` rewrites asset URLs, and nothing else: served from a project page at
// `/mandate/`, the router would still be matching paths against `/` and every
// route would miss. `import.meta.env.BASE_URL` is `/` for a normal build, so this is
// the same app locally and one that works under a subpath when built for one.
createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
)
