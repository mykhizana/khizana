// Signing in to Google for Drive. Google's own window asks the owner (the first time) and gives this
// browser a short-lived token (about an hour); the password never passes through the app. Google
// gives a new token only after a click, so after an hour one click renews it — nothing is lost
// meanwhile (changes and files wait on the device).
import { idb } from '@/db/idb'
import { BASE } from '@/lib/config'
import { DRIVE_FAKE, DRIVE_SCOPES, GOOGLE_CLIENT_ID } from './config'

/** `scope`: what Google granted (every permission given so far, thanks to include_granted_scopes) */
type Tok = { access_token: string; expires_at: number; scope?: string }
type GisResponse = { access_token?: string; expires_in?: number | string; scope?: string; error?: string; error_description?: string }
type Gis = {
  initTokenClient: (c: Record<string, unknown>) => { requestAccessToken: (o?: Record<string, unknown>) => void }
  hasGrantedAllScopes: (r: GisResponse, ...scopes: string[]) => boolean
  revoke: (token: string, done?: () => void) => void
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: Gis } }
  }
}

const KV_TOKEN = 'google_token'
const KV_EMAIL = 'google_email'
const KV_CLIENT = 'google_client_id'
let mem: Tok | null | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())
// the other tabs of this device hear of a sign-in or a sign-out at once (the tab that syncs may be another one)
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('khizana-auth') : null
channel?.addEventListener('message', () => {
  mem = undefined
  emit()
})

let loading: Promise<Gis> | null = null
function loadGis(): Promise<Gis> {
  const ready = window.google?.accounts?.oauth2
  if (ready) return Promise.resolve(ready)
  loading ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => (window.google?.accounts?.oauth2 ? resolve(window.google.accounts.oauth2) : reject(new Error('نافذة Google لم تُحمَّل')))
    s.onerror = () => {
      loading = null
      reject(new Error('تعذّر الوصول إلى Google — تحقق من الاتصال'))
    }
    document.head.appendChild(s)
  })
  return loading
}

async function store(t: Tok | null) {
  mem = t
  if (t) await idb.set('kv', KV_TOKEN, t)
  else await idb.del('kv', KV_TOKEN)
  channel?.postMessage('token')
  emit()
}

const basename = BASE.replace(/\/$/, '')
const standaloneIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && (navigator as Navigator & { standalone?: boolean }).standalone === true
// one Google window at a time (the banner and the renewal on a tap may ask together)
let connecting: Promise<void> | null = null

export const auth = {
  fake: DRIVE_FAKE,
  builtIn: !!GOOGLE_CLIENT_ID,
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },

  async clientId(): Promise<string> {
    if (DRIVE_FAKE) return 'fake'
    return GOOGLE_CLIENT_ID || ((await idb.get<string>('kv', KV_CLIENT).catch(() => undefined)) ?? '')
  },
  async setClientId(id: string | null) {
    if (id?.trim()) await idb.set('kv', KV_CLIENT, id.trim())
    else await idb.del('kv', KV_CLIENT)
    emit()
  },

  /** a valid token, or null (not signed in, or it ran out: one click renews it) */
  async token(): Promise<string | null> {
    if (DRIVE_FAKE) return 'fake-token'
    const fresh = (t: Tok | null | undefined) => !!t && t.expires_at - 60_000 > Date.now()
    // none here, or ran out: another tab may have signed in meanwhile
    if (!fresh(mem)) mem = (await idb.get<Tok>('kv', KV_TOKEN).catch(() => undefined)) ?? null
    return fresh(mem) ? mem!.access_token : null
  },
  async expiresAt(): Promise<number | null> {
    if (DRIVE_FAKE) return Date.now() + 3600_000
    await auth.token()
    return mem?.expires_at ?? null
  },
  async email(): Promise<string | null> {
    return (await idb.get<string>('kv', KV_EMAIL).catch(() => undefined)) ?? null
  },
  async setEmail(e: string | null) {
    if (e) await idb.set('kv', KV_EMAIL, e)
    else await idb.del('kv', KV_EMAIL)
    emit()
  },

  /** Google's script, loaded ahead: a click must open its window at once */
  prepare() {
    if (!DRIVE_FAKE) void loadGis().catch(() => undefined)
  },

  /** the permission can be renewed by a Google window on this page (not on an iPhone home-screen app) */
  canRenewInPlace: () => !DRIVE_FAKE && !standaloneIos(),

  /** a permission Google granted with the present token (the calendar reminders need their own) */
  async hasScope(scope: string): Promise<boolean> {
    if (DRIVE_FAKE) return true
    await auth.token()
    return (mem?.scope ?? '').split(' ').includes(scope)
  },

  /** from a click: Google's window asks the owner (the first time) or only confirms; `extra`: more permissions */
  connect(opts: { consent?: boolean; extra?: string[] } = {}): Promise<void> {
    if (!connecting) connecting = auth.connectOnce(opts).finally(() => (connecting = null))
    return connecting
  },

  async connectOnce(opts: { consent?: boolean; extra?: string[] } = {}): Promise<void> {
    if (DRIVE_FAKE) return store({ access_token: 'fake-token', expires_at: Date.now() + 3600_000 })
    const client_id = await auth.clientId()
    if (!client_id) throw new Error('أضف معرّف Google (Client ID) أولاً')
    const hint = (await auth.email()) ?? undefined
    if (standaloneIos()) return auth.redirect()
    const gis = await loadGis()
    await new Promise<void>((resolve, reject) => {
      const client = gis.initTokenClient({
        client_id,
        scope: [...DRIVE_SCOPES, ...(opts.extra ?? [])].join(' '),
        include_granted_scopes: true,
        prompt: opts.consent ? 'consent' : '',
        ...(hint ? { login_hint: hint } : {}),
        callback: (r: GisResponse) => {
          if (r.error || !r.access_token) return reject(new Error(r.error_description || r.error || 'لم يكتمل الدخول'))
          if (!gis.hasGrantedAllScopes(r, ...DRIVE_SCOPES)) return reject(new Error('يجب السماح لخزانة بالوصول إلى Drive: فعّل المربعين في نافذة Google'))
          void store({ access_token: r.access_token, expires_at: Date.now() + Number(r.expires_in ?? 3599) * 1000, scope: r.scope }).then(resolve, reject)
        },
        error_callback: (e: { type?: string; message?: string }) =>
          reject(
            new Error(
              e?.type === 'popup_closed'
                ? 'أُغلقت نافذة Google قبل الإكمال'
                : e?.type === 'popup_failed_to_open'
                  ? 'منع المتصفح نافذة Google: اسمح بالنوافذ المنبثقة، أو استعمل «الدخول بطريقة أخرى»'
                  : e?.message || 'تعذّر الدخول إلى Google',
            ),
          ),
      })
      client.requestAccessToken()
    })
  },

  /** the other way (the app opened from the iPhone home screen, or a blocked window): a full-page visit to Google */
  async redirect(): Promise<void> {
    const client_id = await auth.clientId()
    if (!client_id) throw new Error('أضف معرّف Google (Client ID) أولاً')
    const state = crypto.randomUUID()
    sessionStorage.setItem('kh-oauth-state', state)
    sessionStorage.setItem('kh-oauth-back', location.pathname.slice(basename.length) || '/')
    const p = new URLSearchParams({ client_id, redirect_uri: `${location.origin}${BASE}`, response_type: 'token', scope: DRIVE_SCOPES.join(' '), include_granted_scopes: 'true', state })
    const hint = await auth.email()
    if (hint) p.set('login_hint', hint)
    location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${p}`)
  },

  /** at start-up, back from Google: the token in the address is kept; returns where to go back to */
  async takeRedirect(): Promise<string | null> {
    const h = new URLSearchParams(location.hash.slice(1))
    if (!h.get('access_token') && !h.get('error')) return null
    const valid = !!h.get('state') && h.get('state') === sessionStorage.getItem('kh-oauth-state')
    const back = sessionStorage.getItem('kh-oauth-back') || '/'
    sessionStorage.removeItem('kh-oauth-state')
    sessionStorage.removeItem('kh-oauth-back')
    history.replaceState(null, '', `${basename}${back}`)
    const granted = (h.get('scope') ?? '').split(' ')
    if (valid && h.get('access_token') && DRIVE_SCOPES.every((s) => granted.includes(s)))
      await store({ access_token: h.get('access_token')!, expires_at: Date.now() + Number(h.get('expires_in') ?? 3599) * 1000, scope: h.get('scope') ?? undefined })
    return back
  },

  /** sign out of Google on this device (the archive stays, on the device and in Drive) */
  async disconnect() {
    const t = mem?.access_token
    await store(null)
    if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t)
  },
}
