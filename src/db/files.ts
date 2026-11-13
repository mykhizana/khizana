// File bytes: IndexedDB in device mode (and, once the device is linked, in the owner's Google Drive
// too: a file this device does not have is brought from Drive), the private «kh-files» bucket in
// cloud mode. Paths are always <owner>/<document>/<file>.<ext>
import { MODE } from '@/lib/config'
import { idb } from './idb'

const urlCache = new Map<string, { url: string; at: number }>()

async function bucket() {
  const { supabase } = await import('./cloud')
  return supabase().storage.from('kh-files')
}

async function fromDrive(path: string): Promise<Blob | null> {
  const { driveSync } = await import('@/drive/sync')
  return driveSync.fetchBlob(path)
}

export const files = {
  async put(path: string, blob: Blob): Promise<void> {
    if (MODE === 'local') {
      // (when the device is linked, the database notes the file for upload once its row exists)
      await idb.set('blobs', path, blob)
      return
    }
    const b = await bucket()
    const { error } = await b.upload(path, blob, { contentType: blob.type || 'application/octet-stream', upsert: false })
    if (error) throw new Error(error.message)
  },

  async get(path: string): Promise<Blob | null> {
    if (MODE === 'local') return (await idb.get<Blob>('blobs', path)) ?? (await fromDrive(path))
    const off = await idb.get<Blob>('offline', path).catch(() => undefined)
    if (off) return off
    const b = await bucket()
    const { data, error } = await b.download(path)
    if (error) return null
    return data
  },

  /** a URL usable in <img>/<a>: object URL (device) or a short signed URL (cloud) */
  async url(path: string): Promise<string | null> {
    const hit = urlCache.get(path)
    const ttl = MODE === 'local' ? Infinity : 4 * 60_000
    if (hit && Date.now() - hit.at < ttl) return hit.url
    let url: string | null = null
    if (MODE === 'local') {
      const blob = await files.get(path)
      url = blob ? URL.createObjectURL(blob) : null
    } else {
      const off = await idb.get<Blob>('offline', path).catch(() => undefined)
      if (off) url = URL.createObjectURL(off)
      else {
        const b = await bucket()
        const { data } = await b.createSignedUrl(path, 300)
        url = data?.signedUrl ?? null
      }
    }
    if (url) urlCache.set(path, { url, at: Date.now() })
    return url
  },

  /** bytes no document needs any more (after «empty the trash», a failed save…) */
  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return
    const forget = (p: string) => {
      const hit = urlCache.get(p)
      if (hit?.url.startsWith('blob:')) URL.revokeObjectURL(hit.url)
      urlCache.delete(p)
    }
    if (MODE === 'local') {
      // the database keeps the paths still used by a document, and queues the Drive copies for removal
      const { api } = await import('./api')
      const r = await api.call<{ paths: string[] }>('kh_blob_forget', { paths })
      for (const p of r.paths) {
        forget(p)
        await idb.del('blobs', p)
      }
      return
    }
    for (const p of paths) {
      forget(p)
      await idb.del('offline', p).catch(() => undefined)
    }
    const b = await bucket()
    await b.remove(paths)
  },

  /** forget cached URLs (bytes removed from this device by the sync) */
  dropUrls(paths: string[]) {
    for (const p of paths) {
      const hit = urlCache.get(p)
      if (hit?.url.startsWith('blob:')) URL.revokeObjectURL(hit.url)
      urlCache.delete(p)
    }
  },

  /** cloud mode: keep a copy on this device so the document opens without internet */
  async keepOffline(paths: string[], keep: boolean): Promise<void> {
    if (MODE === 'local') return
    for (const p of paths) {
      if (!keep) {
        await idb.del('offline', p)
        continue
      }
      const b = await bucket()
      const { data } = await b.download(p)
      if (data) await idb.set('offline', p, data)
    }
  },
}
