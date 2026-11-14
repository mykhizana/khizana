// Phone reminders of the deadline radar, through the owner's Google Calendar: the app keeps one
// calendar of its own («خزانة — الآجال», scope calendar.app.created: it sees no other calendar) and
// writes four reminders per open deadline — two months, one month, one week before and on the day,
// at 9:00 — each with a link to the document. Google Calendar on the phone sends the notifications,
// even when the app is closed (the app has no server). Events have ids made from the deadline, so two
// devices writing the same reminders end up with one set.
// No settings and no token store here: `fetch` and `token` are given (the tests use a fake calendar).

export const CAL_API = 'https://www.googleapis.com/calendar/v3'
export const CAL_NAME = 'خزانة — الآجال'
/** days before the deadline */
export const OFFSETS = [60, 30, 7, 0] as const

export type ReminderSource = { id: string; due_date: string; kind: string; title: string | null; document_id: string | null; doc_title: string | null; vault: boolean }
export type PlannedEvent = { id: string; summary: string; description: string; date: string; key: string }
export type SyncResult = { calendarId: string; created: number; updated: number; deleted: number; total: number }

export class CalendarError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
  /** the permission ran out (401) or was never given (403 insufficient scope) */
  get auth() {
    return this.status === 401 || this.status === 403
  }
}

/** two FNV-1a hashes → «kh» + 16 hex digits: a valid Google event id (base32hex, 5–1024 characters) */
export function eventId(key: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0
  }
  return `kh${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const WHEN: Record<number, string> = { 60: 'بعد شهرين', 30: 'بعد شهر', 7: 'بعد أسبوع', 0: 'اليوم' }

/** the reminders the calendar should hold today (past ones are not written) */
export function planReminders(rows: ReminderSource[], today: string, appUrl: string): PlannedEvent[] {
  const out: PlannedEvent[] = []
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.due_date ?? '') || r.due_date < today) continue
    // a vault document never shows its name or its kind of paper on a lock screen
    const what = r.vault
      ? r.kind === 'expiry'
        ? 'تنتهي صلاحية وثيقة من خزنتك'
        : 'موعد يخص وثيقة من خزنتك'
      : r.title || (r.doc_title ? (r.kind === 'expiry' ? `تنتهي صلاحية: ${r.doc_title}` : `موعد: ${r.doc_title}`) : 'موعد من خزانة')
    const link = r.document_id ? `${appUrl}doc/${r.document_id}` : `${appUrl}deadlines`
    for (const off of OFFSETS) {
      const date = addDays(r.due_date, -off)
      if (date < today) continue
      const description = [
        r.vault ? 'وثيقة في خزنتك: افتح الخزنة في خزانة لتراها.' : r.doc_title ? `الوثيقة: ${r.doc_title}` : null,
        `الموعد: ${r.due_date}`,
        `في خزانة: ${link}`,
      ]
        .filter(Boolean)
        .join('\n')
      out.push({ id: eventId(`${r.id}|${off}`), summary: `${WHEN[off]}: ${what}`, description, date, key: r.id })
    }
  }
  return out
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type CalEvent = { id: string; status?: string; summary?: string; description?: string; start?: { dateTime?: string; date?: string } }

function resource(e: PlannedEvent, tz: string) {
  return {
    id: e.id,
    status: 'confirmed',
    summary: e.summary,
    description: e.description,
    start: { dateTime: `${e.date}T09:00:00`, timeZone: tz },
    end: { dateTime: `${e.date}T09:15:00`, timeZone: tz },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    transparency: 'transparent',
    extendedProperties: { private: { kh: '1', key: e.key } },
  }
}

/** keeps the app's calendar equal to the planned reminders; creates the calendar when there is none */
export async function syncReminders(
  deps: { fetch: Fetch; token: () => Promise<string | null>; base?: string },
  opts: { calendarId: string | null; rows: ReminderSource[]; today: string; tz: string; appUrl: string },
): Promise<SyncResult> {
  const base = deps.base ?? CAL_API
  const call = async (method: string, path: string, body?: unknown, ok: number[] = []): Promise<Record<string, unknown> | null> => {
    for (let attempt = 0; ; attempt++) {
      const token = await deps.token()
      if (!token) throw new CalendarError('انتهت ساعة Google: افتح خزانة واضغط أي شيء لتجديدها', 401)
      const res = await deps.fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (res.ok) return res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>)
      if (ok.includes(res.status)) return null
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      const text = await res.text().catch(() => '')
      throw new CalendarError(`Google Calendar ${res.status}: ${text.slice(0, 160)}`, res.status)
    }
  }

  // 1. the app's own calendar
  let calendarId = opts.calendarId
  if (calendarId && !(await call('GET', `/calendars/${encodeURIComponent(calendarId)}`, undefined, [404, 410]))) calendarId = null
  if (!calendarId) {
    const created = await call('POST', '/calendars', { summary: CAL_NAME, description: 'تذكيرات آجال وثائقك من تطبيق خزانة. تتجدد وحدها.', timeZone: opts.tz })
    calendarId = String(created?.id ?? '')
    if (!calendarId) throw new CalendarError('تعذّر إنشاء التقويم', 500)
  }
  const cal = encodeURIComponent(calendarId)

  // 2. what it holds now (only the app's own reminders)
  const existing = new Map<string, CalEvent>()
  let page: string | undefined
  do {
    const q = new URLSearchParams({ privateExtendedProperty: 'kh=1', maxResults: '2500', showDeleted: 'false' })
    if (page) q.set('pageToken', page)
    const r = (await call('GET', `/calendars/${cal}/events?${q}`)) as { items?: CalEvent[]; nextPageToken?: string } | null
    for (const e of r?.items ?? []) if (e.status !== 'cancelled') existing.set(e.id, e)
    page = r?.nextPageToken
  } while (page)

  // 3. make it equal to the plan
  const plan = planReminders(opts.rows, opts.today, opts.appUrl)
  const wanted = new Map(plan.map((e) => [e.id, e]))
  let created = 0
  let updated = 0
  let deleted = 0
  for (const e of plan) {
    const have = existing.get(e.id)
    const body = resource(e, opts.tz)
    if (!have) {
      // the same id may exist cancelled (deleted earlier): bring it back with the new content
      const made = await call('POST', `/calendars/${cal}/events`, body, [409])
      if (!made) await call('PUT', `/calendars/${cal}/events/${e.id}`, body)
      created++
    } else if (have.summary !== e.summary || have.description !== e.description || !String(have.start?.dateTime ?? '').startsWith(`${e.date}T09:00`)) {
      await call('PUT', `/calendars/${cal}/events/${e.id}`, body)
      updated++
    }
  }
  for (const id of existing.keys()) {
    if (wanted.has(id)) continue
    await call('DELETE', `/calendars/${cal}/events/${id}`, undefined, [404, 410])
    deleted++
  }
  return { calendarId, created, updated, deleted, total: plan.length }
}
