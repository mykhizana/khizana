// The app's side of share links (src/drive/share.ts does the Drive work): publish, take back, and the
// tidying of ended links. Drive cannot end an «anyone with the link» permission by itself, so the
// tidying runs whenever it can: at start, when Google is connected again, when the app comes back on
// screen, every six hours, and at the very end date of the nearest link while the app is open. One tab
// at a time, never opening a Google window by itself.
import { api } from '@/db/api'
import { auth } from '@/drive/auth'
import { nextEnd, publishShare, revokeShare, sweepShares, type Published } from '@/drive/share'
import { drive, engine } from '@/drive/sync'
import { MODE } from './config'

const db = { call: api.call }
const EVERY = 6 * 3600_000
const AGAIN = 10 * 60_000
let started = false
let last = 0
let timer: ReturnType<typeof setTimeout> | null = null

async function where(): Promise<{ device: string; archive: string | null; linked: boolean }> {
  const m = await engine.meta().catch(() => ({}) as Record<string, string>)
  return { device: m.device ?? '', archive: m.archive ?? null, linked: m.linked === '1' }
}

/** the next tidying at the soonest end date (while the app stays open; a day at most) */
async function plan() {
  if (timer) clearTimeout(timer)
  timer = null
  const at = nextEnd(await api.shares({ open: true }).catch(() => []))
  if (at === null) return
  timer = setTimeout(() => void shares.sweep(true), Math.min(Math.max(at - Date.now() + 5_000, 5_000), 24 * 3600_000))
}

export const shares = {
  /** a Google token is there (otherwise the owner must connect Google: one click) */
  ready: async () => !!(await auth.token()),

  publish: async (o: Omit<Parameters<typeof publishShare>[2], 'device' | 'archive'>): Promise<Published> => {
    const w = await where()
    const r = await publishShare(drive, db, { ...o, device: w.device || null, archive: w.archive })
    void plan()
    return r
  },

  revoke: async (s: { id: string; drive_file: string | null }) => {
    await revokeShare(drive, db, s)
    void plan()
  },

  /** `force`: even if it ran a moment ago */
  async sweep(force = false): Promise<void> {
    if (MODE !== 'local') return
    if (!force && Date.now() - last < AGAIN) return
    if (!(await auth.token())) return
    const w = await where()
    if (!w.device) return
    last = Date.now()
    // (a device outside the archive judges only its own copies, and the copies past their end date)
    const run = () => sweepShares(drive, db, { device: w.device, archive: w.archive, linked: w.linked }).catch(() => undefined)
    if (typeof navigator !== 'undefined' && 'locks' in navigator)
      await navigator.locks.request('khizana-shares', { ifAvailable: true }, async (lock) => {
        if (lock) await run()
      })
    else await run()
    void plan()
  },

  start() {
    if (started || MODE !== 'local') return
    started = true
    setTimeout(() => void shares.sweep(true), 30_000)
    setInterval(() => void shares.sweep(true), EVERY)
    auth.subscribe(() => void shares.sweep())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void shares.sweep()
    })
    void plan()
  },
}

/**
 * Before the trash: when open share links hold these documents, the owner chooses whether they are taken
 * back too (a link given to an office for a month should not die because a better scan replaced a page).
 */
export async function trashLinksChoice(ids: string[]): Promise<boolean> {
  const n = (await api.docLinks(ids).catch(() => ({ count: 0 }))).count
  if (!n) return false
  const what = n === 1 ? 'رابط مشاركة مفتوح يحتوي' : `${n} روابط مشاركة مفتوحة تحتوي`
  return confirm(`${what} ${ids.length === 1 ? 'هذه الوثيقة' : 'هذه الوثائق'}.
«موافق»: ${n === 1 ? 'يُسحب مع الحذف فيتوقف فتحه' : 'تُسحب مع الحذف فيتوقف فتحها'}.
«إلغاء»: ${n === 1 ? 'يبقى مفتوحاً حتى تنتهي مدته' : 'تبقى مفتوحة حتى تنتهي مدتها'}.`)
}
