// Google Drive v3: the few calls the archive needs, with retries on the temporary errors.
// The token comes from src/drive/auth.ts; tests and local trials point DRIVE_API at a stand-in.
export type DriveFile = {
  id: string
  name: string
  mimeType?: string
  parents?: string[]
  appProperties?: Record<string, string>
  size?: string
  createdTime?: string
  modifiedTime?: string
  trashed?: boolean
}
export type DriveChange = { fileId: string; removed?: boolean; file?: DriveFile }
export type DriveAbout = {
  user?: { emailAddress?: string; displayName?: string }
  storageQuota?: { limit?: string; usage?: string; usageInDrive?: string; usageInDriveTrash?: string }
}

export class DriveError extends Error {
  status: number
  reason: string
  constructor(message: string, status: number, reason = '') {
    super(message)
    this.status = status
    this.reason = reason
  }
  get auth() {
    return this.status === 401
  }
  get full() {
    return this.reason === 'storageQuotaExceeded'
  }
}

export const FOLDER = 'application/vnd.google-apps.folder'
const FIELDS = 'id,name,mimeType,parents,appProperties,size,createdTime,modifiedTime,trashed'
const SIMPLE_MAX = 5 * 1024 * 1024

export type TokenSource = () => Promise<string | null>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** a value inside a Drive query string */
export const qs = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export function driveClient(token: TokenSource, base = 'https://www.googleapis.com') {
  const api = `${base}/drive/v3`
  const up = `${base}/upload/drive/v3`

  // (every request has a time limit: one stalled phone connection must not block the sync for ever)
  async function request(url: string, init: RequestInit = {}, opts: { ok404?: boolean; timeout?: number } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const t = await token()
      if (!t) throw new DriveError('Google Drive غير متصل', 401, 'no_token')
      let res: Response
      try {
        res = await fetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}` },
          signal: AbortSignal.timeout(opts.timeout ?? 60_000),
        })
      } catch (e) {
        if (attempt < 4) {
          await sleep(1000 * 2 ** attempt)
          continue
        }
        throw new DriveError(`لا اتصال بـ Google Drive (${(e as Error).message})`, 0, 'network')
      }
      if (res.ok || res.status === 308 || (opts.ok404 && res.status === 404)) return res
      let reason = ''
      let message = `Google Drive: ${res.status}`
      try {
        const j = await res.clone().json()
        reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? ''
        message = j?.error?.message ? `Google Drive: ${j.error.message}` : message
      } catch {
        /* not json */
      }
      const temporary = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit/i.test(reason))
      if (temporary && attempt < 5) {
        await sleep(Math.min(32_000, 1000 * 2 ** attempt) + Math.random() * 500)
        continue
      }
      throw new DriveError(message, res.status, reason)
    }
  }
  const json = async <T>(url: string, init: RequestInit = {}, timeout?: number) => (await (await request(url, init, { timeout })).json()) as T
  /** time for a body of this size, even on a slow phone connection (~25 KB/s) */
  const timeFor = (size: number) => 60_000 + Math.ceil(size / 25)

  function multipart(meta: object, body: Blob) {
    const b = `kh${crypto.randomUUID().replace(/-/g, '')}`
    const blob = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${b}\r\nContent-Type: ${body.type || 'application/octet-stream'}\r\n\r\n`,
      body,
      `\r\n--${b}--`,
    ])
    return { blob, type: `multipart/related; boundary=${b}` }
  }

  // a large file: the session is opened, then the whole file goes in one request (sent again from where
  // Google stopped if the connection breaks)
  async function resumable(url: string, method: 'POST' | 'PATCH', meta: object, body: Blob): Promise<DriveFile> {
    const start = await request(url, {
      method,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': body.type || 'application/octet-stream', 'X-Upload-Content-Length': String(body.size) },
      body: JSON.stringify(meta),
    })
    const session = start.headers.get('Location')
    if (!session) throw new DriveError('Google Drive: no upload session', 0, 'no_session')
    let from = 0
    for (let round = 0; round < 5; round++) {
      const part = from ? body.slice(from) : body
      const res = await request(
        session,
        { method: 'PUT', headers: from ? { 'Content-Range': `bytes ${from}-${body.size - 1}/${body.size}` } : {}, body: part },
        { timeout: timeFor(part.size) },
      )
      if (res.status !== 308) return (await res.json()) as DriveFile
      // «Range: bytes=0-N» = what Google has; no Range = nothing yet (all of it again)
      const range = res.headers.get('Range')
      from = range ? Number(range.split('-')[1]) + 1 : 0
    }
    throw new DriveError('Google Drive: the upload does not finish', 0, 'network')
  }

  return {
    async about(): Promise<DriveAbout> {
      return json(`${api}/about?fields=user(emailAddress,displayName),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)`)
    },

    /** ids chosen before uploading: trying again can never make a second copy */
    async generateIds(count: number, space: 'drive' | 'appDataFolder'): Promise<string[]> {
      const r = await json<{ ids: string[] }>(`${api}/files/generateIds?count=${Math.min(1000, Math.max(1, count))}&space=${space}&type=files`)
      return r.ids
    },

    async get(id: string): Promise<DriveFile | null> {
      const res = await request(`${api}/files/${encodeURIComponent(id)}?fields=${FIELDS}`, {}, { ok404: true })
      return res.status === 404 ? null : ((await res.json()) as DriveFile)
    },

    /** a new file (or folder, without body). With meta.id: an id from generateIds */
    async create(meta: { id?: string; name: string; parents?: string[]; appProperties?: Record<string, string>; mimeType?: string }, body?: Blob): Promise<DriveFile> {
      const q = `fields=${FIELDS}`
      if (!body) return json(`${api}/files?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(meta) })
      if (body.size > SIMPLE_MAX) return resumable(`${up}/files?uploadType=resumable&${q}`, 'POST', meta, body)
      const m = multipart(meta, body)
      return json(`${up}/files?uploadType=multipart&${q}`, { method: 'POST', headers: { 'Content-Type': m.type }, body: m.blob }, timeFor(body.size))
    },

    /** rename / move / trash, and optionally new content */
    async update(
      id: string,
      meta: { name?: string; appProperties?: Record<string, string>; trashed?: boolean; mimeType?: string },
      opts: { addParents?: string; removeParents?: string } = {},
      body?: Blob,
    ): Promise<DriveFile> {
      const p = new URLSearchParams({ fields: FIELDS })
      if (opts.addParents) p.set('addParents', opts.addParents)
      if (opts.removeParents) p.set('removeParents', opts.removeParents)
      const target = encodeURIComponent(id)
      if (!body) return json(`${api}/files/${target}?${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(meta) })
      if (body.size > SIMPLE_MAX) {
        p.set('uploadType', 'resumable')
        return resumable(`${up}/files/${target}?${p}`, 'PATCH', meta, body)
      }
      p.set('uploadType', 'multipart')
      const m = multipart(meta, body)
      return json(`${up}/files/${target}?${p}`, { method: 'PATCH', headers: { 'Content-Type': m.type }, body: m.blob }, timeFor(body.size))
    },

    async download(id: string): Promise<Blob> {
      return (await request(`${api}/files/${encodeURIComponent(id)}?alt=media`, {}, { timeout: 10 * 60_000 })).blob()
    },

    /** «anyone with the link can view» on a file the app made (drive.file allows it): the link, and the permission to take back */
    async share(id: string): Promise<{ permissionId: string; link: string }> {
      const target = encodeURIComponent(id)
      const p = await json<{ id: string }>(`${api}/files/${target}/permissions?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false }),
      })
      const f = await json<{ webViewLink?: string }>(`${api}/files/${target}?fields=webViewLink`)
      return { permissionId: p.id, link: f.webViewLink ?? `https://drive.google.com/file/d/${id}/view` }
    },

    /** the link stops working (an already removed permission, or file, is fine) */
    async unshare(id: string, permissionId: string): Promise<void> {
      await request(`${api}/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`, { method: 'DELETE' }, { ok404: true })
    },

    /** removed for good (an already missing file is fine) */
    async remove(id: string): Promise<void> {
      await request(`${api}/files/${encodeURIComponent(id)}`, { method: 'DELETE' }, { ok404: true })
    },

    async list(q: string, opts: { spaces?: 'drive' | 'appDataFolder'; orderBy?: string; max?: number } = {}): Promise<DriveFile[]> {
      const out: DriveFile[] = []
      let pageToken = ''
      do {
        const p = new URLSearchParams({ q, spaces: opts.spaces ?? 'drive', pageSize: '1000', fields: `nextPageToken,files(${FIELDS})` })
        if (opts.orderBy) p.set('orderBy', opts.orderBy)
        if (pageToken) p.set('pageToken', pageToken)
        const r = await json<{ files: DriveFile[]; nextPageToken?: string }>(`${api}/files?${p}`)
        out.push(...(r.files ?? []))
        pageToken = r.nextPageToken ?? ''
      } while (pageToken && (!opts.max || out.length < opts.max))
      return out
    },

    async startPageToken(): Promise<string> {
      return (await json<{ startPageToken: string }>(`${api}/changes/startPageToken`)).startPageToken
    },

    /** everything new in the hidden app folder since a page token */
    async changes(pageToken: string): Promise<{ changes: DriveChange[]; next: string }> {
      const all: DriveChange[] = []
      let token = pageToken
      for (;;) {
        const p = new URLSearchParams({ pageToken: token, spaces: 'appDataFolder', pageSize: '1000', fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))` })
        const r = await json<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>(`${api}/changes?${p}`)
        all.push(...(r.changes ?? []))
        if (r.nextPageToken) token = r.nextPageToken
        else return { changes: all, next: r.newStartPageToken ?? token }
      }
    },
  }
}

export type Drive = ReturnType<typeof driveClient>
