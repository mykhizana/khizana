// Keeps this device and the owner's Google Drive in step, in the background: sends what changed
// here, receives what changed on the other devices, uploads the stored files and keeps the visible
// folder «خزانة» in order. One tab per device does the work (a browser lock).
import { api } from '@/db/api'
import { idb } from '@/db/idb'
import { MODE } from '@/lib/config'
import { queryClient } from '@/lib/queries'
import { driveClient, DriveError } from './api'
import { auth } from './auth'
import { DRIVE_API } from './config'
import { createEngine, type ArchiveInfo, type Progress, type SyncStatus } from './engine'

// the tabs of this device: a link, an unlink or a setting made in one tab reaches the tab that syncs
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('khizana-drive') : null

export type DriveState = 'off' | 'ready' | 'busy' | 'auth' | 'offline' | 'full' | 'error'
export type DriveSnapshot = {
  state: DriveState
  linked: boolean
  email: string | null
  status: SyncStatus | null
  message: string | null
  busy: string | null
  lastSync: number | null
  leader: boolean
  mirror: boolean
  quota: { used: number; limit: number } | null
}

const bytes = {
  get: async (p: string) => (await idb.get<Blob>('blobs', p).catch(() => undefined)) ?? null,
  put: (p: string, b: Blob) => idb.set('blobs', p, b).then(() => undefined),
  del: (p: string) => idb.del('blobs', p),
}
export const drive = driveClient(auth.token, DRIVE_API)
export const engine = createEngine({ db: { call: api.call }, drive, bytes })

class DriveSync {
  private snap: DriveSnapshot = { state: 'off', linked: false, email: null, status: null, message: null, busy: null, lastSync: null, leader: false, mirror: true, quota: null }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private running = false
  private lastPull = 0
  private lastMirror = 0
  private lastAbout = 0

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getSnapshot = () => this.snap
  private set(patch: Partial<DriveSnapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.listeners.forEach((f) => f())
  }

  /** at start-up (device mode): carries on if this device is linked to an archive in Drive */
  async start() {
    if (MODE !== 'local' || this.started) return
    this.started = true
    auth.subscribe(() => {
      void this.refresh()
      this.kick()
    })
    channel?.addEventListener('message', () => {
      void this.refresh().then(() => {
        this.lastPull = 0
        this.lastMirror = 0
        this.kick()
      })
    })
    window.addEventListener('online', () => this.kick())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.lastPull = 0
        this.kick()
      } else if (this.snap.status?.outbox) this.kick() // send before the tab sleeps
    })
    await this.refresh().catch(() => undefined)
    if (this.snap.linked) auth.prepare()
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      void navigator.locks.request('khizana-drive', () => {
        this.set({ leader: true })
        this.kick()
        return new Promise<void>(() => {}) // held for the life of this tab
      })
    } else {
      this.set({ leader: true })
      this.kick()
    }
  }

  /** the settings page asks for the full picture; the loop only needs the light one */
  private full = false
  watchFull(on: boolean) {
    this.full = on
  }
  async refresh() {
    const m = await engine.meta()
    const status = this.full ? await engine.status() : ({ ...(this.snap.status ?? {}), ...(await engine.tick()) } as SyncStatus)
    this.set({
      linked: m.linked === '1',
      mirror: m.mirror !== '0',
      email: await auth.email(),
      status,
      lastSync: m.pulled_at ? Date.parse(m.pulled_at) : null,
      state: m.linked === '1' ? (this.snap.state === 'off' ? 'ready' : this.snap.state) : 'off',
    })
  }

  kick = () => {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), 50)
  }
  private later(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick() {
    this.timer = null
    if (this.running) return this.later(1500)
    if (!this.snap.leader) return
    if (!this.snap.linked) {
      await this.refresh().catch(() => undefined) // (linked from another tab?)
      if (!this.snap.linked) return
    }
    this.running = true
    let wait = 5000
    let stop = false
    try {
      if (!(await auth.token())) {
        this.set({ state: 'auth', busy: null })
        stop = true // resumes when the owner signs in again
        return
      }
      if (!navigator.onLine) {
        this.set({ state: 'offline', busy: null })
        wait = 20_000
        return
      }
      const now = Date.now()
      const visible = document.visibilityState === 'visible'
      let s = await engine.tick()
      // what changed here: sent once the owner pauses, and at least every 45 s while working
      const last = s.outbox_last ? Date.parse(s.outbox_last) : 0
      const first = s.outbox_first ? Date.parse(s.outbox_first) : 0
      if (s.outbox > 0 && (now - last > 6000 || now - first > 45_000 || !visible)) {
        this.set({ state: 'busy', busy: 'إرسال التغييرات' })
        await engine.push()
      }
      // what changed elsewhere: every 30 s on screen, every 5 min in the background
      if (now - this.lastPull > (visible ? 30_000 : 300_000)) {
        this.set({ state: 'busy', busy: 'استقبال التحديثات' })
        const n = await engine.pull()
        this.lastPull = Date.now()
        if (n) {
          await queryClient.invalidateQueries()
          const { queue } = await import('@/pipeline/queue')
          queue.kick()
        }
      }
      // the stored files
      s = await engine.tick()
      if (s.uploads + s.removals > 0) {
        this.set({ state: 'busy', busy: 'رفع الملفات' })
        const r = await engine.uploads(20_000, (t) => this.set({ busy: t }))
        if (r.done) await engine.push()
        if (r.left) wait = 300
      }
      // the visible folder «خزانة» (only when something changed)
      if (this.snap.mirror && s.mirror && now - this.lastMirror > 60_000) {
        this.set({ state: 'busy', busy: 'ترتيب مجلد «خزانة» في Drive' })
        const r = await engine.mirror(20_000, (t) => this.set({ busy: t }))
        this.lastMirror = r.left ? 0 : Date.now()
        if (r.done) await engine.push()
        if (r.left) wait = 300
      }
      await engine.compact()
      if (now - this.lastAbout > 15 * 60_000) {
        this.lastAbout = now
        const a = await engine.about().catch(() => null)
        if (a?.user?.emailAddress) await auth.setEmail(a.user.emailAddress)
        if (a?.storageQuota) this.set({ quota: { used: Number(a.storageQuota.usage ?? 0), limit: Number(a.storageQuota.limit ?? 0) } })
      }
      this.set({ state: 'ready', busy: null, message: null })
    } catch (e) {
      if (e instanceof DriveError && e.auth) {
        this.set({ state: 'auth', busy: null })
        stop = true
      } else if (e instanceof DriveError && e.full) {
        this.set({ state: 'full', busy: null, message: 'مساحة Google Drive ممتلئة: وسّع اشتراك Google One أو أفرغ سلة Drive' })
        wait = 10 * 60_000
      } else if (e instanceof DriveError && (e.reason === 'network' || e.status === 0)) {
        this.set({ state: 'offline', busy: null })
        wait = 20_000
      } else {
        this.set({ state: 'error', busy: null, message: String((e as Error)?.message ?? e).slice(0, 300) })
        wait = 60_000
      }
    } finally {
      this.running = false
      await this.refresh().catch(() => undefined)
      if (!stop && this.snap.linked && this.snap.leader) this.later(wait)
    }
  }

  // ---------------------------------------------------------------- what the settings page uses
  inspect() {
    return engine.inspect()
  }
  /** link this device: make the archive in Drive, or join the one that is there */
  async link(existing: ArchiveInfo | null, progress: Progress) {
    this.set({ state: 'busy', busy: existing ? 'الانضمام إلى أرشيفك في Drive' : 'إنشاء أرشيفك في Drive' })
    try {
      if (existing) await engine.join(existing, progress)
      else await engine.create(progress)
      const a = await engine.about().catch(() => null)
      if (a?.user?.emailAddress) await auth.setEmail(a.user.emailAddress)
      await queryClient.invalidateQueries()
    } finally {
      this.set({ state: 'ready', busy: null })
      await this.refresh()
      this.lastPull = 0
      this.lastMirror = 0
      channel?.postMessage('linked')
      this.kick()
    }
  }
  async unlink() {
    await engine.unlink()
    this.set({ state: 'off', busy: null, message: null })
    await this.refresh()
    channel?.postMessage('unlinked')
  }
  async syncNow() {
    this.lastPull = 0
    this.lastMirror = 0
    await api.call('kh_blob_retry')
    await this.refresh()
    this.kick()
  }
  async setMirror(on: boolean) {
    await engine.setMeta({ mirror: on ? null : '0' })
    if (on) await api.call('kh_mirror_mark_all')
    this.lastMirror = 0
    await this.refresh()
    channel?.postMessage('mirror')
    this.kick()
  }
  /** the bytes of a stored file that only another device had: from Drive (null when not possible yet) */
  async fetchBlob(path: string): Promise<Blob | null> {
    if (!this.snap.linked) {
      await this.refresh().catch(() => undefined)
      if (!this.snap.linked) return null
    }
    if (!(await auth.token())) {
      this.set({ state: 'auth' })
      return null
    }
    try {
      return await engine.fetchBlob(path)
    } catch (e) {
      if (e instanceof DriveError && e.auth) this.set({ state: 'auth' })
      return null
    }
  }
  /** room on this device: the copies of files that are safely in Drive go (thumbnails and «keep offline» stay) */
  async freeSpace(): Promise<number> {
    const cached = await api.call<{ path: string; role: string; pinned: boolean }[]>('kh_blob_cached')
    const here = new Set((await idb.keys('blobs')).map(String))
    let n = 0
    for (const c of cached) {
      if (c.role === 'thumb' || c.pinned || !here.has(c.path)) continue
      await idb.del('blobs', c.path)
      n++
    }
    return n
  }
}

export const driveSync = new DriveSync()
