// Google's own window for choosing files in Drive (the Google Picker). It shows the owner's whole Drive, but
// only the files chosen there become reachable by the app (drive.file) — nothing else in Drive does. It needs
// the app's Google token and its Google Cloud project number (the digits that start the client id), and the
// «Google Picker API» turned on in that project. An API key is optional (VITE_GOOGLE_API_KEY).
import { GOOGLE_API_KEY } from './config'
import { PICK_MAX, type Picked } from './import'

type PickerDoc = Record<string, unknown>
interface DocsView {
  setIncludeFolders(v: boolean): DocsView
  setSelectFolderEnabled(v: boolean): DocsView
  setMode(mode: string): DocsView
}
interface PickerBuilder {
  addView(v: DocsView): PickerBuilder
  enableFeature(f: string): PickerBuilder
  setMaxItems(n: number): PickerBuilder
  setOAuthToken(t: string): PickerBuilder
  setAppId(id: string): PickerBuilder
  setDeveloperKey(k: string): PickerBuilder
  setLocale(l: string): PickerBuilder
  setTitle(t: string): PickerBuilder
  setCallback(cb: (data: PickerDoc) => void): PickerBuilder
  build(): { setVisible(v: boolean): void }
}
type PickerNS = {
  DocsView: new (viewId?: string) => DocsView
  PickerBuilder: new () => PickerBuilder
  ViewId: { DOCS: string }
  DocsViewMode: { LIST: string }
  Feature: { MULTISELECT_ENABLED: string }
  Response: { ACTION: string; DOCUMENTS: string }
  Action: { PICKED: string; CANCEL: string }
  Document: { ID: string; NAME: string; MIME_TYPE: string }
}
type Gapi = { load: (lib: string, o: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }) => void }
// (window.google is declared for Google's sign-in in auth.ts; the picker adds google.picker beside it)
const g = () => window as unknown as { gapi?: Gapi; google?: { picker?: PickerNS } }

let loading: Promise<PickerNS> | null = null
function load(): Promise<PickerNS> {
  const ready = g().google?.picker
  if (ready) return Promise.resolve(ready)
  loading ??= new Promise<PickerNS>((resolve, reject) => {
    const fail = (message: string) => {
      loading = null
      reject(new Error(message))
    }
    const start = () =>
      g().gapi!.load('picker', {
        callback: () => {
          const p = g().google?.picker
          if (p) resolve(p)
          else fail('نافذة Google Drive لم تُحمَّل')
        },
        onerror: () => fail('تعذّر تحميل نافذة Google Drive'),
        timeout: 20_000,
        ontimeout: () => fail('تأخرت نافذة Google Drive: تحقق من الاتصال وأعد المحاولة'),
      })
    if (g().gapi?.load) return start()
    const s = document.createElement('script')
    s.src = 'https://apis.google.com/js/api.js'
    s.async = true
    s.onload = () => (g().gapi?.load ? start() : fail('نافذة Google Drive لم تُحمَّل'))
    s.onerror = () => fail('تعذّر الوصول إلى Google — تحقق من الاتصال')
    document.head.appendChild(s)
  })
  return loading
}

export const drivePicker = {
  /** the window's script, fetched ahead (when the owner reaches for the button) */
  prepare() {
    void load().catch(() => undefined)
  },

  /** the files the owner chose; [] when the window is closed */
  async pick(token: string, clientId: string): Promise<Picked[]> {
    const P = await load()
    const appId = /^(\d+)-/.exec(clientId)?.[1]
    return new Promise<Picked[]>((resolve) => {
      // (My Drive and what is shared with the owner; shared drives of an organisation would need every
      // Drive call to carry supportsAllDrives, and a personal account has none)
      const view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(P.DocsViewMode.LIST)
      const b = new P.PickerBuilder()
        .addView(view)
        .enableFeature(P.Feature.MULTISELECT_ENABLED)
        .setMaxItems(PICK_MAX)
        .setOAuthToken(token)
        .setLocale('ar')
        .setTitle('اختر ما تضيفه إلى خزانة')
        .setCallback((data) => {
          const action = data[P.Response.ACTION]
          if (action === P.Action.CANCEL) return resolve([])
          if (action !== P.Action.PICKED) return
          const docs = (data[P.Response.DOCUMENTS] as PickerDoc[] | undefined) ?? []
          resolve(
            docs
              .map((d) => ({ id: String(d[P.Document.ID] ?? ''), name: String(d[P.Document.NAME] ?? ''), mimeType: d[P.Document.MIME_TYPE] ? String(d[P.Document.MIME_TYPE]) : undefined }))
              .filter((d) => d.id),
          )
        })
      // the project number: the files picked are opened to this app (and only to it)
      if (appId) b.setAppId(appId)
      if (GOOGLE_API_KEY) b.setDeveloperKey(GOOGLE_API_KEY)
      b.build().setVisible(true)
    })
  },
}
