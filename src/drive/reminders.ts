// The phone reminders of the deadline radar (src/drive/calendar.ts writes them to Google Calendar).
// Turned on once by the owner — a click, because Google's window must ask for the calendar
// permission — then kept up to date by the app: at start, every six hours, and a minute after a
// deadline changes here. One tab at a time (a browser lock); every device writes the same event ids,
// so a device that also has the permission only confirms what is there.
import { api } from '@/db/api'
import { idb } from '@/db/idb'
import { BASE } from '@/lib/config'
import { auth } from './auth'
import { CalendarError, syncReminders } from './calendar'
import { CALENDAR_SCOPE, DRIVE_FAKE } from './config'

type Setting = { enabled?: boolean; calendar_id?: string | null }
export type RemindersState = { enabled: boolean; granted: boolean; busy: boolean; total: number | null; lastSync: number | null; error: string | null }

const KV_LAST = 'reminders_last'
const EVERY = 6 * 3600_000
let state: RemindersState = { enabled: false, granted: false, busy: false, total: null, lastSync: null, error: null }
const listeners = new Set<() => void>()
const set = (p: Partial<RemindersState>) => {
  state = { ...state, ...p }
  listeners.forEach((f) => f())
}
let timer: ReturnType<typeof setTimeout> | null = null
let started = false

async function setting(): Promise<Setting> {
  const v = (await api.settings())?.reminders
  return v && typeof v === 'object' ? (v as Setting) : {}
}

/** today on this device's clock, as YYYY-MM-DD */
const localToday = () => new Date().toLocaleDateString('en-CA')

async function run() {
  const s = await setting()
  if (!s.enabled) return set({ enabled: false })
  if (DRIVE_FAKE) return
  if (!(await auth.hasScope(CALENDAR_SCOPE))) return set({ enabled: true, granted: false })
  set({ enabled: true, granted: true, busy: true, error: null })
  try {
    const r = await syncReminders(
      { fetch: (u, i) => fetch(u, i), token: () => auth.token() },
      {
        calendarId: s.calendar_id ?? null,
        rows: await api.remindersSource(),
        today: localToday(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        appUrl: `${location.origin}${BASE}`,
      },
    )
    if (r.calendarId !== s.calendar_id) await api.setSetting('reminders', { ...(await setting()), calendar_id: r.calendarId })
    const last = { at: Date.now(), total: r.total }
    await idb.set('kv', KV_LAST, last).catch(() => undefined)
    set({ busy: false, lastSync: last.at, total: r.total })
  } catch (e) {
    set({
      busy: false,
      error: e instanceof CalendarError && e.auth ? 'انتهت ساعة Google أو لم تُعطَ صلاحية التقويم: اضغط «حدّث الآن».' : (e as Error)?.message || String(e),
    })
  }
}

export const reminders = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  get: () => state,

  async refresh() {
    const s = await setting().catch(() => ({}) as Setting)
    const last = await idb.get<{ at: number; total: number }>('kv', KV_LAST).catch(() => undefined)
    set({ enabled: !!s.enabled, granted: await auth.hasScope(CALENDAR_SCOPE), lastSync: last?.at ?? null, total: last?.total ?? null })
  },

  /** from a click: Google's window asks for the calendar permission, then the reminders are written */
  async enable() {
    await auth.connect({ extra: [CALENDAR_SCOPE] })
    if (!(await auth.hasScope(CALENDAR_SCOPE))) throw new Error('لم تُعطَ صلاحية التقويم: فعّل مربّعها في نافذة Google، ثم أعد المحاولة')
    await api.setSetting('reminders', { ...(await setting()), enabled: true })
    set({ enabled: true, granted: true })
    await reminders.syncNow()
  },

  /** stops writing reminders (those already in the calendar stay until removed there) */
  async disable() {
    await api.setSetting('reminders', { ...(await setting()), enabled: false })
    set({ enabled: false })
  },

  async syncNow(): Promise<void> {
    if (typeof navigator !== 'undefined' && 'locks' in navigator)
      await navigator.locks.request('khizana-calendar', { ifAvailable: true }, async (lock) => {
        if (lock) await run()
      })
    else await run()
  },

  /** a deadline changed: write the reminders a minute later (several changes, one write) */
  soon() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void reminders.syncNow(), 60_000)
  },

  start() {
    if (started) return
    started = true
    void reminders.refresh().then(() => {
      if (state.enabled && state.granted && (!state.lastSync || Date.now() - state.lastSync > EVERY)) void reminders.syncNow()
    })
    setInterval(() => void reminders.syncNow(), EVERY)
  },
}
