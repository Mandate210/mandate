import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // `/` locally; the Pages workflow builds under `/<repo>/app/`, beside the landing page.
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
})
