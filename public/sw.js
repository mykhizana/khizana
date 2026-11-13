// خزانة — service worker: the app opens without network, and files shared from other apps
// (WhatsApp, the gallery…) are handed to the «add» page.
const VERSION = 'kh-__BUILD__'
const BASE = new URL('./', self.location).pathname
const SHELL = `${BASE}index.html`

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll([SHELL, `${BASE}logo.svg`, `${BASE}icon-192.png`]))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function saveShared(files) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('khizana-files', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of ['blobs', 'kv', 'offline']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
    }
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite')
      tx.objectStore('kv').put(files, 'shared_files')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // «Share → خزانة» from another app
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === `${BASE}add`) {
    event.respondWith(
      (async () => {
        try {
          const form = await req.formData()
          const files = form.getAll('files').filter((f) => typeof f !== 'string')
          await saveShared(files)
        } catch {
          /* nothing to keep */
        }
        return Response.redirect(`${BASE}add?shared=1`, 303)
      })(),
    )
    return
  }

  if (req.method !== 'GET') return
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(VERSION).then((cache) => cache.put(SHELL, copy))
          }
          return res
        })
        .catch(() => caches.match(SHELL).then((hit) => hit || Response.error())),
    )
    return
  }

  // built files carry a hash in their name: once cached they never change (the database engine included)
  if (url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(VERSION).then((cache) => cache.put(req, copy))
            }
            return res
          }),
      ),
    )
  }
})
