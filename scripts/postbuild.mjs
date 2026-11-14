// After `vite build`: GitHub Pages has no SPA rewrites, so every route gets a copy of the shell,
// and the service worker gets a cache name of its own for this deployment.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const DIST = 'dist'
const ROUTES = ['search', 'ask', 'library', 'add', 'scan', 'review', 'people', 'places', 'labels', 'settings']

try {
  writeFileSync(`${DIST}/sw.js`, readFileSync(`${DIST}/sw.js`, 'utf8').replace('__BUILD__', Date.now().toString(36)))
} catch {
  /* no service worker */
}
copyFileSync(`${DIST}/index.html`, `${DIST}/404.html`)
for (const r of ROUTES) {
  mkdirSync(`${DIST}/${r}`, { recursive: true })
  copyFileSync(`${DIST}/index.html`, `${DIST}/${r}/index.html`)
}
writeFileSync(`${DIST}/robots.txt`, 'User-agent: *\nDisallow: /\n')
console.log('postbuild: routes + 404 + sw stamped')
