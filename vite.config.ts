import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// GitHub Pages serves the app under /<repo>/ ; a custom domain later just needs VITE_BASE=/
const base = process.env.VITE_BASE ?? '/khizana/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // PGlite ships its own WebAssembly files: Vite must not pre-bundle it
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1500, target: 'es2022' },
  server: { port: 5177 },
  preview: { port: 4177 },
})
