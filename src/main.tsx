import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/globals.css'
import { App } from './App'

// after a new deployment an open tab may ask for files that no longer exist: reload once
window.addEventListener('vite:preloadError', (event) => {
  const key = 'kh:reloaded-at'
  let last = 0
  try {
    last = Number(sessionStorage.getItem(key) || 0)
  } catch {
    /* ignore */
  }
  if (Date.now() - last > 15_000) {
    event.preventDefault()
    try {
      sessionStorage.setItem(key, String(Date.now()))
    } catch {
      /* ignore */
    }
    location.reload()
  }
})

// installable app that opens without network (public/sw.js)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
