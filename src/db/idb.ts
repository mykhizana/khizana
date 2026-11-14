// A tiny promise wrapper around IndexedDB: the device keeps file bytes (device mode),
// offline copies (cloud mode) and a few private values (the AI key in device mode).
const DB_NAME = 'khizana-files'
const VERSION = 1
export type StoreName = 'blobs' | 'kv' | 'offline'

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of ['blobs', 'kv', 'offline'] as StoreName[]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      opening = null
      reject(req.error)
    }
  })
  return opening
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const s = t.objectStore(store)
        const req = fn(s)
        t.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T))
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error ?? new Error('IndexedDB aborted'))
      }),
  )
}

export const idb = {
  get: <T = unknown>(store: StoreName, key: string) => tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>),
  set: (store: StoreName, key: string, value: unknown) => tx<IDBValidKey>(store, 'readwrite', (s) => s.put(value, key)),
  del: (store: StoreName, key: string) => tx<undefined>(store, 'readwrite', (s) => s.delete(key)),
  keys: (store: StoreName) => tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store: StoreName) => tx<undefined>(store, 'readwrite', (s) => s.clear()),
  async usage(): Promise<{ used: number; quota: number } | null> {
    try {
      const e = await navigator.storage?.estimate?.()
      return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null
    } catch {
      return null
    }
  },
}
