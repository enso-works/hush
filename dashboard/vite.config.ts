// The dashboard builds into ../src/dashboard, which the server serves as-is
// and which is committed: running hush never needs Node tooling beyond `pg`.
// `base: './'` keeps every asset URL relative, so the same build works at
// /dashboard/, behind a proxy prefix (/demo/dashboard/, /hush/dashboard/),
// or anywhere else it is mounted.
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    outDir: '../src/dashboard',
    emptyOutDir: true,
    // One predictable file set, and no inline modulepreload polyfill script
    // (the page's CSP allows scripts from 'self' only).
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // One chunk on purpose (above); the warning is for a jump, not the size.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    // `npm run dev` against a local hush (HUSH_URL, default a DEMO=1 one on
    // 3055): the page lives at /dashboard/ and calls /admin/* beside it.
    proxy: { '/admin': process.env.HUSH_URL ?? 'http://127.0.0.1:3055' },
  },
})
