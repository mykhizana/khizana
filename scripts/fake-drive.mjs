// A stand-in for Google Drive (the v3 calls the archive uses), in memory, for tests and for trying the
// app on two "devices" (two local ports) without a Google account:
//   node scripts/fake-drive.mjs 5199        then run the app with VITE_DRIVE_API=http://localhost:5199
// Any bearer token is accepted except "expired" (answers 401, to test reconnecting).
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

export function createFakeDrive() {
  const files = new Map() // id → { meta, bytes }
  const log = [] // the change journal: { fileId, removed }
  const sessions = new Map()
  const stats = { requests: 0, uploads: 0, downloads: 0 }
  let failNext = 0

  const newId = () => randomBytes(16).toString('base64url').replace(/[-_]/g, 'x').slice(0, 28)
  const now = () => new Date().toISOString()
  const space = (meta) => (meta.parents?.includes('appDataFolder') ? 'appDataFolder' : 'drive')
  const pub = (f) => ({ kind: 'drive#file', ...f.meta, size: f.bytes ? String(f.bytes.length) : undefined, webViewLink: `https://drive.google.com/file/d/${f.meta.id}/view?usp=drivesdk` })
  const change = (fileId, removed = false) => log.push({ fileId, removed })

  function put(meta, bytes) {
    const id = meta.id ?? newId()
    const f = {
      meta: {
        id,
        name: meta.name ?? 'Untitled',
        mimeType: meta.mimeType ?? 'application/octet-stream',
        parents: meta.parents?.length ? meta.parents : ['root'],
        appProperties: meta.appProperties ?? {},
        createdTime: now(),
        modifiedTime: now(),
        trashed: false,
      },
      bytes: bytes ?? null,
    }
    files.set(id, f)
    change(id)
    stats.uploads++
    return f
  }

  // ---------------------------------------------------------------- the query language (the part we use)
  function splitAnd(q) {
    const out = []
    let depth = 0
    let quote = false
    let cur = ''
    for (let i = 0; i < q.length; i++) {
      const ch = q[i]
      if (quote) {
        cur += ch
        if (ch === '\\') cur += q[++i] ?? ''
        else if (ch === "'") quote = false
        continue
      }
      if (ch === "'") quote = true
      if (ch === '{' || ch === '(') depth++
      if (ch === '}' || ch === ')') depth--
      if (depth === 0 && q.slice(i, i + 5).toLowerCase() === ' and ') {
        out.push(cur.trim())
        cur = ''
        i += 4
        continue
      }
      cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }
  const str = (s) => s.trim().replace(/^'|'$/g, '').replace(/\\(.)/g, '$1')
  function test(f, clause) {
    let m
    if ((m = /^name\s*=\s*('(?:[^'\\]|\\.)*')$/.exec(clause))) return f.meta.name === str(m[1])
    if ((m = /^name\s+contains\s+('(?:[^'\\]|\\.)*')$/.exec(clause))) return f.meta.name.includes(str(m[1]))
    if ((m = /^('(?:[^'\\]|\\.)*')\s+in\s+parents$/.exec(clause))) return f.meta.parents.includes(str(m[1]))
    if ((m = /^mimeType\s*(!?=)\s*('(?:[^'\\]|\\.)*')$/.exec(clause))) return (f.meta.mimeType === str(m[2])) === (m[1] === '=')
    if ((m = /^trashed\s*=\s*(true|false)$/.exec(clause))) return f.meta.trashed === (m[1] === 'true')
    if ((m = /^createdTime\s*>\s*('(?:[^'\\]|\\.)*')$/.exec(clause))) return f.meta.createdTime > str(m[1])
    if ((m = /^appProperties\s+has\s*\{\s*key\s*=\s*('(?:[^'\\]|\\.)*')\s+and\s+value\s*=\s*('(?:[^'\\]|\\.)*')\s*\}$/.exec(clause)))
      return f.meta.appProperties?.[str(m[1])] === str(m[2])
    throw new Error(`fake drive: query not understood: ${clause}`)
  }

  // ---------------------------------------------------------------- multipart/related bodies
  function multipart(buf, type) {
    const boundary = /boundary=([^;]+)/.exec(type)?.[1]
    if (!boundary) throw new Error('no boundary')
    const sep = Buffer.from(`--${boundary}`)
    const parts = []
    let at = buf.indexOf(sep)
    while (at >= 0) {
      const next = buf.indexOf(sep, at + sep.length)
      if (next < 0) break
      const part = buf.subarray(at + sep.length + 2, next - 2) // after CRLF … before CRLF
      const h = part.indexOf('\r\n\r\n')
      parts.push({ head: part.subarray(0, h).toString(), body: part.subarray(h + 4) })
      at = next
    }
    return { meta: JSON.parse(parts[0].body.toString('utf8')), bytes: parts[1]?.body ?? Buffer.alloc(0) }
  }

  async function body(req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    return Buffer.concat(chunks)
  }

  function send(res, status, data, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(data === undefined ? '' : JSON.stringify(data))
  }
  const error = (res, status, reason, message = reason) => send(res, status, { error: { code: status, message, errors: [{ reason, message }] } })

  function patch(f, meta, url) {
    if (meta.name !== undefined) f.meta.name = meta.name
    if (meta.mimeType !== undefined) f.meta.mimeType = meta.mimeType
    if (meta.trashed !== undefined) f.meta.trashed = !!meta.trashed
    if (meta.appProperties) f.meta.appProperties = { ...f.meta.appProperties, ...meta.appProperties }
    const add = url.searchParams.get('addParents')
    const rem = url.searchParams.get('removeParents')
    if (rem) f.meta.parents = f.meta.parents.filter((p) => !rem.split(',').includes(p))
    if (add) f.meta.parents = [...new Set([...f.meta.parents, ...add.split(',')])]
    f.meta.modifiedTime = now()
    change(f.meta.id)
  }

  async function handle(req, res) {
    stats.requests++
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Content-Range, X-Upload-Content-Type, X-Upload-Content-Length')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', 'Location, Range')
    if (req.method === 'OPTIONS') return send(res, 204)
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || auth === 'Bearer expired') return error(res, 401, 'authError', 'Invalid Credentials')
    if (failNext > 0) {
      failNext--
      return error(res, 503, 'backendError')
    }
    const m = (re) => re.exec(path)

    // ---- uploads
    if (path === '/upload/drive/v3/files' && req.method === 'POST') {
      const kind = url.searchParams.get('uploadType')
      if (kind === 'resumable') {
        const meta = JSON.parse((await body(req)).toString('utf8') || '{}')
        if (meta.id && files.has(meta.id)) return error(res, 409, 'fileIdInUse', 'A file already exists with the provided ID.')
        const sid = newId()
        sessions.set(sid, { meta, chunks: [], got: 0, total: Number(req.headers['x-upload-content-length'] ?? -1), target: null })
        return send(res, 200, undefined, { Location: `http://${req.headers.host}/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` })
      }
      const { meta, bytes } = multipart(await body(req), req.headers['content-type'])
      if (meta.id && files.has(meta.id)) return error(res, 409, 'fileIdInUse', 'A file already exists with the provided ID.')
      return send(res, 200, pub(put(meta, bytes)))
    }
    if (path === '/upload/drive/v3/files' && req.method === 'PUT') {
      const s = sessions.get(url.searchParams.get('upload_id'))
      if (!s) return error(res, 404, 'notFound')
      const chunk = await body(req)
      s.chunks.push(chunk)
      s.got += chunk.length
      const total = Number(/\/(\d+)$/.exec(req.headers['content-range'] ?? '')?.[1] ?? s.total)
      if (s.got < total) {
        res.writeHead(308, { Range: `bytes=0-${s.got - 1}` })
        return res.end()
      }
      sessions.delete(url.searchParams.get('upload_id'))
      const bytes = Buffer.concat(s.chunks)
      if (s.target) {
        const f = files.get(s.target)
        patch(f, s.meta, s.url)
        f.bytes = bytes
        stats.uploads++
        return send(res, 200, pub(f))
      }
      return send(res, 200, pub(put(s.meta, bytes)))
    }
    let mm
    if ((mm = m(/^\/upload\/drive\/v3\/files\/([^/]+)$/)) && req.method === 'PATCH') {
      const f = files.get(decodeURIComponent(mm[1]))
      if (!f) return error(res, 404, 'notFound')
      const kind = url.searchParams.get('uploadType')
      if (kind === 'resumable') {
        const meta = JSON.parse((await body(req)).toString('utf8') || '{}')
        const sid = newId()
        sessions.set(sid, { meta, chunks: [], got: 0, total: Number(req.headers['x-upload-content-length'] ?? -1), target: f.meta.id, url })
        return send(res, 200, undefined, { Location: `http://${req.headers.host}/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` })
      }
      const raw = await body(req)
      const { meta, bytes } = kind === 'multipart' ? multipart(raw, req.headers['content-type']) : { meta: {}, bytes: raw }
      patch(f, meta, url)
      f.bytes = bytes
      stats.uploads++
      return send(res, 200, pub(f))
    }

    // ---- metadata
    if (path === '/drive/v3/about') {
      const usage = [...files.values()].reduce((a, f) => a + (f.bytes?.length ?? 0), 0)
      return send(res, 200, { user: { emailAddress: 'owner@example.com', displayName: 'Owner' }, storageQuota: { limit: String(100 * 2 ** 30), usage: String(usage), usageInDrive: String(usage) } })
    }
    if (path === '/drive/v3/files/generateIds') {
      const n = Number(url.searchParams.get('count') ?? 10)
      return send(res, 200, { ids: Array.from({ length: n }, newId), space: url.searchParams.get('space') })
    }
    if (path === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse((await body(req)).toString('utf8') || '{}')
      if (meta.id && files.has(meta.id)) return error(res, 409, 'fileIdInUse')
      return send(res, 200, pub(put(meta, null)))
    }
    if (path === '/drive/v3/files' && req.method === 'GET') {
      const sp = url.searchParams.get('spaces') ?? 'drive'
      const clauses = splitAnd(url.searchParams.get('q') ?? '')
      let list = [...files.values()].filter((f) => space(f.meta) === sp && clauses.every((c) => test(f, c)))
      const order = url.searchParams.get('orderBy') ?? ''
      if (order.startsWith('createdTime')) list.sort((a, b) => a.meta.createdTime.localeCompare(b.meta.createdTime))
      if (order.startsWith('name')) list.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
      const size = Number(url.searchParams.get('pageSize') ?? 100)
      const from = Number(url.searchParams.get('pageToken') ?? 0)
      const page = list.slice(from, from + size).map(pub)
      return send(res, 200, { files: page, nextPageToken: from + size < list.length ? String(from + size) : undefined })
    }
    // ---- sharing (a dossier shared by a link)
    if ((mm = m(/^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/))) {
      const f = files.get(decodeURIComponent(mm[1]))
      if (!f) return error(res, 404, 'notFound', 'File not found')
      f.perms = f.perms ?? []
      if (req.method === 'POST' && !mm[2]) {
        const p = { id: newId(), ...JSON.parse((await body(req)).toString('utf8') || '{}') }
        f.perms.push(p)
        return send(res, 200, { kind: 'drive#permission', id: p.id, type: p.type, role: p.role })
      }
      if (req.method === 'DELETE' && mm[2]) {
        const i = f.perms.findIndex((p) => p.id === decodeURIComponent(mm[2]))
        if (i < 0) return error(res, 404, 'notFound', 'Permission not found')
        f.perms.splice(i, 1)
        return send(res, 204)
      }
    }
    if ((mm = m(/^\/drive\/v3\/files\/([^/]+)$/))) {
      const f = files.get(decodeURIComponent(mm[1]))
      if (!f) return error(res, 404, 'notFound', 'File not found')
      if (req.method === 'GET') {
        if (url.searchParams.get('alt') === 'media') {
          stats.downloads++
          res.writeHead(200, { 'Content-Type': f.meta.mimeType })
          return res.end(f.bytes ?? Buffer.alloc(0))
        }
        return send(res, 200, pub(f))
      }
      if (req.method === 'PATCH') {
        patch(f, JSON.parse((await body(req)).toString('utf8') || '{}'), url)
        return send(res, 200, pub(f))
      }
      if (req.method === 'DELETE') {
        files.delete(f.meta.id)
        change(f.meta.id, true)
        return send(res, 204)
      }
    }

    // ---- changes
    if (path === '/drive/v3/changes/startPageToken') return send(res, 200, { startPageToken: String(log.length) })
    if (path === '/drive/v3/changes') {
      const from = Number(url.searchParams.get('pageToken') ?? 0)
      const sp = url.searchParams.get('spaces') ?? 'drive'
      const size = Number(url.searchParams.get('pageSize') ?? 100)
      const slice = log.slice(from, from + size)
      const changes = slice
        .map((c) => ({ fileId: c.fileId, removed: c.removed || !files.has(c.fileId), file: files.has(c.fileId) ? pub(files.get(c.fileId)) : undefined }))
        .filter((c) => c.removed || space(files.get(c.fileId).meta) === sp)
      const end = from + slice.length
      return send(res, 200, end < log.length ? { changes, nextPageToken: String(end) } : { changes, newStartPageToken: String(end) })
    }
    return error(res, 404, 'notFound', `fake drive: ${req.method} ${path}`)
  }

  return {
    files,
    stats,
    /** the next n requests answer 503 (to test the retries) */
    failNext: (n) => {
      failNext = n
    },
    handle: (req, res) =>
      handle(req, res).catch((e) => {
        if (!res.headersSent) error(res, 500, 'internal', String(e?.message ?? e))
      }),
  }
}

export function startFakeDrive(port = 0) {
  const drive = createFakeDrive()
  const server = createServer(drive.handle)
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ drive, server, url: `http://127.0.0.1:${server.address().port}` })))
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/fake-drive.mjs')) {
  const { url } = await startFakeDrive(Number(process.argv[2] ?? 5199))
  console.log(`fake Google Drive on ${url}`)
}
