// The archive in the owner's Google Drive: what one device sends and receives. No browser-only API
// here (only fetch, Blob and streams), so the very same code runs in the tests (Node) and in the app.
//
// In the hidden app folder of Drive (only this app sees it):
//   khizana.json                      the archive: its id and the device that made it
//   snap-<time>-<device>.ndjson.gz    full copies of the index; each says, per device, up to which
//                                     changeset it covers (appProperties v_<device>)
//   cs-<device>-<n>.json.gz           changesets: what one device changed, numbered without gaps
//   b-…                               the stored files (page images, thumbnails, originals)
//   lease-mirror.json                 which device keeps the visible folder in order right now
// In My Drive, the visible folder «خزانة»: a folder per shelf and a readable copy of each document
// outside the vault.
import { DriveError, FOLDER, qs, type Drive, type DriveFile } from './api'
import { gunzipText, gzipLines, gzipStream, gzipText } from './gz'
import { jpegPdf } from './pdf'

export type Db = { call: <T = unknown>(fn: string, p?: unknown) => Promise<T> }
export type Bytes = { get(path: string): Promise<Blob | null>; put(path: string, b: Blob): Promise<void>; del(path: string): Promise<void> }
export type ArchiveInfo = { format: 'khizana-drive'; version: 1; archive: string; created_at: string; created_by: string }
export type Progress = (text: string, ratio?: number) => void
export type SyncTick = {
  linked: boolean
  outbox: number
  outbox_first: string | null
  outbox_last: string | null
  uploads: number
  removals: number
  mirror: boolean
}
export type SyncStatus = SyncTick & {
  device: string
  pending: number
  upload_bytes: number
  stuck: number
  last_error: string | null
  in_drive: number
  mirrored: number
}

type Row = Record<string, unknown>
type Changeset = { fmt: 'khizana-cs'; v: 1; archive: string; dev: string; seq: number; at: string; rows: { t: string; d: Row }[]; dels: unknown[] }
type Pending = { id: string; seq: number; keys: unknown[]; body: Changeset }
type QueueItem = { path: string; op: 'up' | 'del'; drive_id: string | null; tries: number; role: string | null; mime: string | null; size: number | null }
type MirrorItem = {
  action: 'put' | 'drop'
  document_id: string
  dirty_at: string
  category_id?: string | null
  trashed?: boolean
  name?: string
  src?: string
  orig?: string | null
  mime?: string | null
  pages?: { path: string }[] | null
  mirror: { drive_id: string; folder: string | null; name: string | null; src: string | null } | null
}

const META = 'khizana.json'
const LEASE = 'lease-mirror.json'
const APP = 'appDataFolder'
const ROOT_NAME = 'خزانة'
const NONE_NAME = 'غير مصنفة'
const TRASH_NAME = 'سلة المحذوفات'
const pad = (n: number) => String(n).padStart(10, '0')
const iso = (t: number) => new Date(t).toISOString()
const folderName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || NONE_NAME
const gone404 = (e: unknown) => e instanceof DriveError && e.status === 404
/** the per-device vector of a snapshot, from its appProperties */
const vecOf = (f: DriveFile): Record<string, number> =>
  Object.fromEntries(Object.entries(f.appProperties ?? {}).filter(([k]) => k.startsWith('v_')).map(([k, v]) => [k.slice(2), Number(v)]))

export function createEngine({ db, drive, bytes, now = () => Date.now() }: { db: Db; drive: Drive; bytes: Bytes; now?: () => number }) {
  // ---------------------------------------------------------------- small helpers
  const pools: Record<string, string[]> = { drive: [], appDataFolder: [] }
  async function newId(space: 'drive' | 'appDataFolder') {
    if (!pools[space].length) pools[space] = await drive.generateIds(space === APP ? 50 : 20, space)
    return pools[space].shift()!
  }
  const meta = () => db.call<Record<string, string>>('kh_sync_meta')
  const setMeta = (set: Record<string, string | null>) => db.call<Record<string, string>>('kh_sync_meta', { set })

  /** create with an id chosen earlier; if a first try got through, keep that file */
  async function createOrAdopt(m: Parameters<Drive['create']>[0], body?: Blob): Promise<DriveFile> {
    try {
      return await drive.create(m, body)
    } catch (e) {
      if (!m.id || (e instanceof DriveError && (e.auth || e.full))) throw e
      const have = await drive.get(m.id).catch(() => null)
      if (have) return have
      throw e
    }
  }

  // one run of each kind at a time
  const running = new Map<string, Promise<unknown>>()
  function once<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const cur = running.get(name)
    if (cur) return cur as Promise<T>
    const p = fn().finally(() => running.delete(name))
    running.set(name, p)
    return p
  }

  async function findArchives(): Promise<{ file: DriveFile; info: ArchiveInfo }[]> {
    const out: { file: DriveFile; info: ArchiveInfo }[] = []
    for (const f of await drive.list(`name = ${qs(META)} and trashed = false`, { spaces: APP })) {
      try {
        const info = JSON.parse(await (await drive.download(f.id)).text()) as ArchiveInfo
        if (info?.format === 'khizana-drive') out.push({ file: f, info })
      } catch {
        /* unreadable or already gone: ignored */
      }
    }
    // two devices creating one at the same moment: the oldest wins
    return out.sort((a, b) => (a.file.createdTime ?? '').localeCompare(b.file.createdTime ?? '') || a.file.id.localeCompare(b.file.id))
  }

  /** the snapshots of an archive, newest first (by Drive's own clock, not a device's) */
  async function snapshots(archive: string): Promise<DriveFile[]> {
    return (await drive.list(`appProperties has { key='kh' and value='snap' } and trashed = false`, { spaces: APP }))
      .filter((f) => f.appProperties?.a === archive)
      .sort((a, b) => (b.createdTime ?? '').localeCompare(a.createdTime ?? '') || b.id.localeCompare(a.id))
  }

  // ---------------------------------------------------------------- snapshots
  async function writeSnapshot(archive: string, progress?: Progress) {
    const m = await meta()
    const dev = m.device
    const applied = JSON.parse(m.applied || '{}') as Record<string, number>
    const seq = Number(m.seq || 0)
    // what it covers: every changeset applied here, and this device's own up to the last one sent
    const vec: Record<string, number> = { ...applied, [dev]: m.pending_cs ? seq - 1 : seq }
    const at = iso(now())
    const tables = await db.call<{ t: string }[]>('kh_sync_info')
    let step = -1
    let after: unknown = null
    let rows = 0
    let tail: string[] | null = null
    const blob = await gzipStream(async () => {
      if (step === -1) {
        step = 0
        return JSON.stringify({ fmt: 'khizana-snap', v: 1, archive, dev, at, vec }) + '\n'
      }
      if (step < tables.length) {
        const t = tables[step].t
        const r = await db.call<{ rows: Row[]; done: boolean; after: unknown }>('kh_sync_dump', { t, after, limit: 800 })
        if (r.done) {
          step++
          after = null
        } else after = r.after
        rows += r.rows.length
        progress?.(`نسخ الفهرس إلى Drive (${rows})`)
        return r.rows.length ? r.rows.map((d) => JSON.stringify({ t, d })).join('\n') + '\n' : ''
      }
      if (tail === null) {
        // rows still waiting for their parent (they came in changesets this snapshot covers), then the tombstones
        const waiting = await db.call<{ t: string; d: Row }[]>('kh_sync_dump_pending')
        const tombs = await db.call<unknown[]>('kh_sync_dump_tombs')
        tail = waiting.map((w) => JSON.stringify({ t: w.t, d: w.d, waiting: true }))
        for (let i = 0; i < tombs.length; i += 2000) tail.push(JSON.stringify({ tombs: tombs.slice(i, i + 2000) }))
      }
      return tail.length ? tail.splice(0, 500).join('\n') + '\n' : null
    })
    const props: Record<string, string> = { kh: 'snap', dev, at, a: archive }
    for (const [d, s] of Object.entries(vec)) props[`v_${d}`] = String(s)
    const file = await createOrAdopt(
      { id: await newId(APP), name: `snap-${at.replace(/[:.]/g, '-')}-${dev}.ndjson.gz`, parents: [APP], appProperties: props, mimeType: 'application/gzip' },
      blob,
    )
    await setMeta({ snap_at: at })
    return { file, vec, at, size: blob.size }
  }

  /** a snapshot into this database: 'load' when it is empty (fast), 'merge' row by row (newer wins) */
  async function readSnapshot(file: DriveFile, mode: 'load' | 'merge', progress?: Progress): Promise<Record<string, number>> {
    const blob = await drive.download(file.id)
    const self = new Set((await db.call<{ t: string; self: boolean }[]>('kh_sync_info')).filter((x) => x.self).map((x) => x.t))
    let header: { vec?: Record<string, number> } | null = null
    let cur: { t: string; rows: Row[] } | null = null
    const waiting: { t: string; d: Row }[] = []
    let n = 0
    const flush = async () => {
      if (!cur?.rows.length) return
      const t = cur.t
      if (mode === 'load') await db.call('kh_sync_load', { t, rows: cur.rows })
      else await db.call('kh_sync_apply', { rows: cur.rows.map((d) => ({ t, d })), dels: [] })
      n += cur.rows.length
      cur.rows = []
      progress?.(`تحميل الفهرس من Drive (${n})`)
    }
    for await (const line of gzipLines(blob)) {
      const x = JSON.parse(line)
      if (x.fmt === 'khizana-snap') {
        header = x
        continue
      }
      if (x.tombs) {
        await flush()
        if (mode === 'load') await db.call('kh_sync_load', { tombs: x.tombs })
        else await db.call('kh_sync_apply', { rows: [], dels: x.tombs })
        continue
      }
      if (x.waiting) {
        waiting.push({ t: x.t, d: x.d })
        continue
      }
      if (!cur || cur.t !== x.t) {
        await flush()
        cur = { t: x.t, rows: [] }
      }
      cur.rows.push(x.d)
      // a table that points to itself goes in at once (parents and children together)
      if (!self.has(x.t) && cur.rows.length >= (mode === 'load' ? 1500 : 300)) await flush()
    }
    await flush()
    // the rows that were waiting there wait here (or go in, if their parents are here now)
    for (let i = 0; i < waiting.length; i += 300) await db.call('kh_sync_apply', { rows: waiting.slice(i, i + 300), dels: [] })
    if (!header) throw new Error('نسخة الفهرس في Drive ناقصة')
    return header.vec ?? {}
  }

  // ---------------------------------------------------------------- linking a device
  async function inspect() {
    const found = await findArchives()
    const p = await db.call<{ pristine: boolean; documents: number; bytes: number }>('kh_sync_pristine')
    return { archive: found[0]?.info ?? null, ...p }
  }

  /** the first device: its archive becomes the one in Drive */
  async function create(progress?: Progress): Promise<ArchiveInfo> {
    const m = await meta()
    const info: ArchiveInfo = { format: 'khizana-drive', version: 1, archive: crypto.randomUUID(), created_at: iso(now()), created_by: m.device }
    const token = await drive.startPageToken()
    // (a changeset still waiting for an older archive is part of what this snapshot holds)
    await setMeta({ linked: '1', archive: info.archive, applied: '{}', token: null, held: null, held_since: null, pending_cs: null, recovered: null })
    await writeSnapshot(info.archive, progress)
    await createOrAdopt({ id: await newId(APP), name: META, parents: [APP], mimeType: 'application/json' }, new Blob([JSON.stringify(info)], { type: 'application/json' }))
    const all = await findArchives()
    if (all[0] && all[0].info.archive !== info.archive) {
      // another device made one at the same moment and was first: this one joins it
      for (const x of all.filter((y) => y.info.archive === info.archive)) await drive.remove(x.file.id)
      for (const f of await snapshots(info.archive)) await drive.remove(f.id)
      await setMeta({ linked: '0', archive: null })
      return join(all[0].info, progress)
    }
    await db.call('kh_blob_enqueue_all')
    await db.call('kh_mirror_mark_all')
    await setMeta({ token })
    return info
  }

  /** a device joining an archive that already is in Drive */
  async function join(info: ArchiveInfo, progress?: Progress): Promise<ArchiveInfo> {
    const snap = (await snapshots(info.archive))[0]
    if (!snap) throw new Error('الأرشيف في Drive لا يحوي نسخة من الفهرس بعد — أعد المحاولة بعد قليل')
    const before = await meta()
    const again = before.archive === info.archive // this device was in this archive before
    const p = await db.call<{ pristine: boolean }>('kh_sync_pristine')
    if (p.pristine) await db.call('kh_sync_wipe')
    else await db.call('kh_sync_prepare_merge')
    const vec = await readSnapshot(snap, p.pristine ? 'load' : 'merge', progress)
    const m = await meta()
    const applied: Record<string, number> = {}
    for (const [d, s] of Object.entries(vec)) if (d !== m.device) applied[d] = Number(s)
    // numbering: the other devices expect this device's changesets to follow the last one they have
    // of it — in this archive (never a gap: a changeset still waiting from before is sent first)
    const seq = again ? Math.max(Number(m.seq || 0), Number(vec[m.device] ?? 0)) : Number(vec[m.device] ?? 0)
    await setMeta({
      linked: '1',
      archive: info.archive,
      applied: JSON.stringify(applied),
      seq: String(again && m.pending_cs ? Math.max(seq, Number((JSON.parse(m.pending_cs) as Pending).seq)) : seq),
      pending_cs: again ? (m.pending_cs ?? null) : null,
      token: null,
      held: null,
      held_since: null,
      recovered: null,
    })
    if (!p.pristine) {
      await db.call('kh_sync_fix_seeds')
      await db.call('kh_sync_mark_all', { mine: true })
    }
    await db.call('kh_blob_enqueue_all')
    await db.call('kh_mirror_mark_all')
    await pull(progress)
    await push(progress)
    return info
  }

  /** this device stops syncing (a changeset not sent yet is kept: it goes when the device joins again) */
  async function unlink() {
    await setMeta({ linked: '0', token: null, held: null, held_since: null })
  }

  // ---------------------------------------------------------------- sending
  function push(progress?: Progress): Promise<number> {
    return once('push', async () => {
      let sent = 0
      for (;;) {
        const m = await meta()
        if (m.linked !== '1' || !m.archive) return sent
        let pend = m.pending_cs ? (JSON.parse(m.pending_cs) as Pending) : null
        if (pend && pend.body.archive !== m.archive) {
          // (left from an archive this device no longer belongs to)
          await setMeta({ pending_cs: null })
          pend = null
        }
        if (!pend) {
          const take = await db.call<{ rows: Changeset['rows']; dels: unknown[]; keys: unknown[]; more: boolean }>('kh_sync_take', { limit: 600 })
          if (!take.keys.length) return sent
          const seq = Number(m.seq || 0) + 1
          pend = {
            id: await newId(APP),
            seq,
            keys: take.keys,
            body: { fmt: 'khizana-cs', v: 1, archive: m.archive, dev: m.device, seq, at: iso(now()), rows: take.rows, dels: take.dels },
          }
          // kept before sending: after a crash the very same changeset goes, with the very same id
          await setMeta({ pending_cs: JSON.stringify(pend), seq: String(seq) })
        }
        await createOrAdopt(
          { id: pend.id, name: `cs-${pend.body.dev}-${pad(pend.seq)}.json.gz`, parents: [APP], appProperties: { kh: 'cs', dev: pend.body.dev, seq: String(pend.seq) }, mimeType: 'application/gzip' },
          await gzipText(JSON.stringify(pend.body)),
        )
        await db.call('kh_sync_ack', { keys: pend.keys })
        await setMeta({ pending_cs: null, pushed_at: iso(now()) })
        sent += pend.keys.length
        progress?.(`أُرسل ${sent} تغييراً`)
      }
    })
  }

  // ---------------------------------------------------------------- receiving
  function pull(progress?: Progress): Promise<number> {
    return once('pull', async () => {
      const m = await meta()
      if (m.linked !== '1') return 0
      const me = m.device
      const applied = JSON.parse(m.applied || '{}') as Record<string, number>
      let token = m.token
      let seen: DriveFile[]
      if (!token) {
        token = await drive.startPageToken()
        seen = await drive.list(`appProperties has { key='kh' and value='cs' } and trashed = false`, { spaces: APP })
      } else {
        const r = await drive.changes(token)
        seen = r.changes.filter((c) => !c.removed && c.file && !c.file.trashed).map((c) => c.file!)
        token = r.next
      }
      let n = 0
      // a snapshot made meanwhile that covers changesets this device never saw (tidied away before it
      // looked): if they are not in Drive any more, the snapshot brings their rows
      const behind = new Map<string, number>()
      for (const sn of seen.filter((f) => f.appProperties?.kh === 'snap' && f.appProperties.a === m.archive))
        for (const [d, v] of Object.entries(vecOf(sn))) if (d !== me && v > (applied[d] ?? 0)) behind.set(d, (applied[d] ?? 0) + 1)
      for (const [d, next] of [...behind]) {
        const mine = await drive.list(`appProperties has { key='dev' and value=${qs(d)} } and trashed = false`, { spaces: APP })
        if (mine.some((f) => f.appProperties?.kh === 'cs' && Number(f.appProperties.seq) === next)) behind.delete(d)
      }
      if (behind.size) {
        n += await recover(behind, [], progress)
        Object.assign(applied, JSON.parse((await meta()).applied || '{}'))
      }
      const byId = new Map<string, DriveFile>()
      for (const f of [...(m.held ? (JSON.parse(m.held) as DriveFile[]) : []), ...seen]) byId.set(f.id, f)
      let todo = [...byId.values()]
        .filter((f) => f.appProperties?.kh === 'cs' && f.appProperties.dev && f.appProperties.dev !== me)
        .filter((f) => Number(f.appProperties!.seq) > (applied[f.appProperties!.dev!] ?? 0))
        .sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? '') || Number(a.appProperties!.seq) - Number(b.appProperties!.seq))
      // in order, per device; one that waits for an earlier one is kept for later
      const drain = async (list: DriveFile[]): Promise<DriveFile[]> => {
        for (let moved = true; moved && list.length; ) {
          moved = false
          const later: DriveFile[] = []
          for (const f of list) {
            const dev = f.appProperties!.dev!
            const seq = Number(f.appProperties!.seq)
            if (seq <= (applied[dev] ?? 0)) continue
            if (seq !== (applied[dev] ?? 0) + 1) {
              later.push(f) // an earlier one of that device has not come in yet
              continue
            }
            let body: Changeset | null = null
            try {
              body = JSON.parse(await gunzipText(await drive.download(f.id))) as Changeset
            } catch (e) {
              if (!gone404(e)) throw e
              later.push(f) // tidied away meanwhile: the snapshot that covers it brings its rows (recover)
              continue
            }
            if (body.archive === m.archive) {
              const r = await db.call<{ removed_paths?: string[] }>('kh_sync_apply', { rows: body.rows, dels: body.dels })
              for (const p of r.removed_paths ?? []) await bytes.del(p).catch(() => undefined)
              n++
              progress?.(`استُقبل ${n} تحديثاً`)
            }
            applied[dev] = seq
            await setMeta({ applied: JSON.stringify(applied) })
            moved = true
          }
          list = later
        }
        return list
      }
      todo = await drain(todo)
      // a gap that does not close in 10 minutes (changesets tidied away while this device was away,
      // or lost): recover, then carry on
      let since: string | null = m.held_since ?? null
      if (todo.length && since && now() - Number(since) > 10 * 60_000) {
        const need = new Map<string, number>()
        for (const f of todo) {
          const d = f.appProperties?.dev
          if (d && !need.has(d)) need.set(d, (applied[d] ?? 0) + 1)
        }
        n += await recover(need, todo, progress)
        Object.assign(applied, JSON.parse((await meta()).applied || '{}'))
        todo = await drain(todo)
        since = null
      }
      await setMeta({
        token,
        pulled_at: iso(now()),
        held: todo.length ? JSON.stringify(todo) : null,
        held_since: todo.length ? (since ?? String(now())) : null,
      })
      return n
    })
  }

  /** closing a gap (need: device → first missing changeset): the newest snapshot that covers it brings
   *  the missing rows; a gap no snapshot covers (nothing can bring it back) is stepped over, just before
   *  the oldest changeset that is here. Never the same snapshot twice. */
  async function recover(need: Map<string, number>, held: DriveFile[], progress?: Progress): Promise<number> {
    const m = await meta()
    const applied = JSON.parse(m.applied || '{}') as Record<string, number>
    const merged = new Set<string>(JSON.parse(m.recovered || '[]') as string[])
    let n = 0
    const snap = (await snapshots(m.archive)).find((s) => !merged.has(s.id) && [...need].some(([d, first]) => (vecOf(s)[d] ?? 0) >= first))
    if (snap) {
      const vec = await readSnapshot(snap, 'merge', progress)
      for (const [d, s] of Object.entries(vec)) if (d !== m.device) applied[d] = Math.max(applied[d] ?? 0, Number(s))
      merged.add(snap.id)
      n++
    }
    for (const [d, first] of need) {
      if ((applied[d] ?? 0) >= first) continue
      const oldest = Math.min(...held.filter((f) => f.appProperties?.dev === d).map((f) => Number(f.appProperties?.seq)))
      if (Number.isFinite(oldest)) applied[d] = Math.max(applied[d] ?? 0, oldest - 1)
    }
    await setMeta({ applied: JSON.stringify(applied), held_since: null, recovered: JSON.stringify([...merged].slice(-20)) })
    return n
  }

  // ---------------------------------------------------------------- stored files
  function uploads(budgetMs = 25_000, progress?: Progress): Promise<{ done: number; left: boolean }> {
    return once('uploads', async () => {
      const t0 = now()
      let done = 0
      const one = async (it: QueueItem): Promise<boolean> => {
        try {
          if (it.op === 'del') {
            if (it.drive_id) await drive.remove(it.drive_id)
            await db.call('kh_blob_done', { path: it.path, op: 'del' })
            return true
          }
          const blob = await bytes.get(it.path)
          if (!blob) {
            await db.call('kh_blob_drop', { path: it.path })
            return false
          }
          const id = it.drive_id ?? (await db.call<{ drive_id: string }>('kh_blob_reserve', { path: it.path, drive_id: await newId(APP) })).drive_id
          const typed = blob.type ? blob : new Blob([blob], { type: it.mime || 'application/octet-stream' })
          await createOrAdopt({ id, name: `b-${it.path.split('/').slice(-2).join('-')}`, parents: [APP], appProperties: { kh: 'blob', p: it.path }, mimeType: typed.type }, typed)
          await db.call('kh_blob_done', { path: it.path, op: 'up', drive_id: id, size: blob.size, mime: typed.type })
          return true
        } catch (e) {
          if (e instanceof DriveError && (e.auth || e.full)) throw e
          await db.call('kh_blob_fail', { path: it.path, op: it.op, error: String((e as Error).message ?? e), wait_s: Math.min(3600, 30 * 2 ** Math.min(it.tries, 7)) })
          return false
        }
      }
      for (;;) {
        if (now() - t0 > budgetMs) return { done, left: true }
        const batch = await db.call<QueueItem[]>('kh_blob_next', { limit: 6 })
        if (!batch.length) return { done, left: false }
        const results = await Promise.allSettled(batch.map(one))
        for (const r of results) if (r.status === 'rejected') throw r.reason
        done += results.filter((r) => r.status === 'fulfilled' && r.value).length
        progress?.(`رُفع ${done} ملفاً`)
        if (results.every((r) => r.status === 'fulfilled' && !r.value)) return { done, left: true }
      }
    })
  }

  /** bytes kept in Drive by another device; kept on this one too, unless keep is false */
  async function fetchBlob(path: string, opts: { keep?: boolean } = {}): Promise<Blob | null> {
    const where = await db.call<Record<string, string>>('kh_blob_where', { paths: [path] })
    const id = where[path]
    if (!id) return null
    let b: Blob
    try {
      b = await drive.download(id)
    } catch (e) {
      if (gone404(e)) return null
      throw e
    }
    if (opts.keep !== false) await bytes.put(path, b)
    return b
  }

  // ---------------------------------------------------------------- the visible folder «خزانة»
  async function takeLease(dev: string): Promise<boolean> {
    const files = await drive.list(`name = ${qs(LEASE)} and trashed = false`, { spaces: APP })
    const body = new Blob([JSON.stringify({ dev, until: now() + 3 * 60_000 })], { type: 'application/json' })
    if (files.length) {
      try {
        const cur = JSON.parse(await (await drive.download(files[0].id)).text()) as { dev?: string; until?: number }
        if (cur.dev && cur.dev !== dev && Number(cur.until) > now()) return false
      } catch {
        /* unreadable lease: taken over */
      }
      await drive.update(files[0].id, {}, {}, body)
      for (const extra of files.slice(1)) await drive.remove(extra.id).catch(() => undefined)
    } else await drive.create({ name: LEASE, parents: [APP], mimeType: 'application/json' }, body)
    return true
  }

  /** the content of a readable copy: the original, or the scanned pages as one PDF. Bytes brought from
   *  Drive for it are not kept on this device (a phone keeping the folder must not fill up). */
  async function contentOf(it: MirrorItem): Promise<Blob | null> {
    const get = async (p: string) => (await bytes.get(p)) ?? (await fetchBlob(p, { keep: false }))
    if (it.orig) return get(it.orig)
    const pages: Uint8Array[] = []
    for (const p of it.pages ?? []) {
      const b = await get(p.path)
      if (!b) return null
      pages.push(new Uint8Array(await b.arrayBuffer()))
    }
    return pages.length ? jpegPdf(pages, (it.name ?? '').replace(/\.pdf$/i, '')) : null
  }

  const skipped = new Map<string, number>()
  function mirror(budgetMs = 25_000, progress?: Progress): Promise<{ done: number; left: boolean }> {
    return once('mirror', async () => {
      const m = await meta()
      if (m.linked !== '1' || m.mirror === '0') return { done: 0, left: false }
      const t0 = now()
      for (const [k, at] of skipped) if (now() - at > 10 * 60_000) skipped.delete(k)
      let todo = await db.call<{ items: MirrorItem[]; folders: boolean }>('kh_mirror_todo', { limit: 25, exclude: [...skipped.keys()] })
      if (!todo.items.length && !todo.folders) return { done: 0, left: false }
      if (!(await takeLease(m.device))) return { done: 0, left: false }

      // the root folder and the shelf folders this app made (found again by their marks)
      let root = (await drive.list(`appProperties has { key='kh' and value='root' } and trashed = false`))[0]?.id
      if (!root) root = (await drive.create({ name: ROOT_NAME, mimeType: FOLDER, appProperties: { kh: 'root' } })).id
      const folders = new Map<string, DriveFile>()
      for (const f of await drive.list(`appProperties has { key='kh' and value='folder' } and trashed = false`)) {
        const key = f.appProperties?.key
        if (key && !folders.has(key)) folders.set(key, f)
      }
      const cats = new Map((await db.call<{ id: string; parent_id: string | null; name_ar: string }[]>('kh_categories_list', { archived: true })).map((c) => [c.id, c]))
      const folderFor = async (key: string, depth = 0): Promise<string> => {
        const cat = cats.get(key)
        const name = key === 'none' ? NONE_NAME : key === 'trash' ? TRASH_NAME : folderName(cat?.name_ar ?? NONE_NAME)
        const parent = cat?.parent_id && cats.has(cat.parent_id) && depth < 12 ? await folderFor(cat.parent_id, depth + 1) : root!
        const have = folders.get(key)
        if (have) {
          if (have.name !== name || !(have.parents ?? []).includes(parent)) {
            const old = (have.parents ?? []).filter((p) => p !== parent).join(',')
            folders.set(key, await drive.update(have.id, { name }, { addParents: parent, ...(old ? { removeParents: old } : {}) }))
          }
          return have.id
        }
        const f = await drive.create({ name, parents: [parent], mimeType: FOLDER, appProperties: { kh: 'folder', key } })
        folders.set(key, f)
        return f.id
      }

      // shelves renamed or moved: their folders follow
      if (todo.folders) {
        const started = iso(now())
        for (const key of [...folders.keys()]) if (cats.has(key)) await folderFor(key)
        await db.call('kh_mirror_folders_done', { at: started })
      }

      let done = 0
      while (todo.items.length) {
        for (const it of todo.items) {
          if (now() - t0 > budgetMs) return { done, left: true }
          if (it.action === 'drop') {
            // removed for good from Drive (not to its bin): a document moved into the vault leaves no copy anywhere
            if (it.mirror?.drive_id) await drive.remove(it.mirror.drive_id)
            await db.call('kh_mirror_drop', { document_id: it.document_id, dirty_at: it.dirty_at })
            done++
            continue
          }
          const key = it.trashed ? 'trash' : it.category_id && cats.has(it.category_id) ? it.category_id : 'none'
          const folder = await folderFor(key)
          const mime = it.orig ? it.mime || 'application/octet-stream' : 'application/pdf'
          let content: Blob | null = null
          if (!it.mirror || it.mirror.src !== it.src) {
            content = await contentOf(it)
            if (!content) {
              skipped.set(it.document_id, now()) // its bytes are not in Drive yet: later
              continue
            }
          }
          // the very last moment: still outside the vault?
          if (!(await db.call<{ ok: boolean }>('kh_mirror_check', { id: it.document_id })).ok) continue
          let file: DriveFile | null = null
          if (it.mirror) {
            try {
              const moving = it.mirror.folder !== folder
              file = await drive.update(
                it.mirror.drive_id,
                { name: it.name, trashed: false },
                moving ? { addParents: folder, ...(it.mirror.folder ? { removeParents: it.mirror.folder } : {}) } : {},
                content ? new Blob([content], { type: mime }) : undefined,
              )
            } catch (e) {
              if (!gone404(e)) throw e
              file = null // the owner removed it in Drive: it is made again
            }
          }
          if (!file) {
            content ??= await contentOf(it)
            if (!content) {
              skipped.set(it.document_id, now())
              continue
            }
            // a copy made by a device that stopped before noting it is taken over, not doubled
            const twin = (await drive.list(`appProperties has { key='doc' and value=${qs(it.document_id)} } and trashed = false`))[0]
            const elsewhere = (twin?.parents ?? []).filter((p) => p !== folder)
            file = twin
              ? await drive.update(twin.id, { name: it.name }, { addParents: folder, ...(elsewhere.length ? { removeParents: elsewhere.join(',') } : {}) }, new Blob([content], { type: mime }))
              : await createOrAdopt({ id: await newId('drive'), name: it.name!, parents: [folder], mimeType: mime, appProperties: { kh: 'doc', doc: it.document_id } }, new Blob([content], { type: mime }))
          }
          await db.call('kh_mirror_set', { document_id: it.document_id, drive_id: file.id, folder, category_id: it.category_id, trashed: it.trashed, name: it.name, src: it.src, dirty_at: it.dirty_at })
          done++
          progress?.(`نُسخت ${done} وثيقة إلى مجلد «${ROOT_NAME}»`)
        }
        todo = await db.call<{ items: MirrorItem[]; folders: boolean }>('kh_mirror_todo', { limit: 25, exclude: [...skipped.keys()] })
      }
      return { done, left: false }
    })
  }

  // ---------------------------------------------------------------- tidying
  /** now and then: old tombstones and orphans go; a fresh snapshot, and the changesets it covers
   *  (older than two weeks) removed */
  function compact(force = false): Promise<boolean> {
    return once('compact', async () => {
      const m = await meta()
      if (m.linked !== '1' || !m.archive) return false
      if (!force && now() - Number(m.compact_check || 0) < 6 * 3600_000) return false
      await setMeta({ compact_check: String(now()) })
      await db.call('kh_sync_prune')
      const snaps = await snapshots(m.archive)
      const all = await drive.list(`appProperties has { key='kh' and value='cs' } and trashed = false`, { spaces: APP })
      const since = snaps[0] ? all.filter((f) => (f.createdTime ?? '') > (snaps[0].createdTime ?? '')) : all
      if (!force && since.length < 200) return false
      const made = await writeSnapshot(m.archive)
      const cutoff = iso(now() - 14 * 86_400_000)
      for (const f of all) {
        const d = f.appProperties?.dev
        const s = Number(f.appProperties?.seq)
        if (d && s <= (made.vec[d] ?? 0) && (f.createdTime ?? '') < cutoff) await drive.remove(f.id)
      }
      for (const old of (await snapshots(m.archive)).slice(2)) if ((old.createdTime ?? '') < cutoff) await drive.remove(old.id)
      return true
    })
  }

  return {
    inspect,
    create,
    join,
    unlink,
    push,
    pull,
    uploads,
    fetchBlob,
    mirror,
    compact,
    tick: () => db.call<SyncTick>('kh_sync_tick'),
    status: () => db.call<SyncStatus>('kh_sync_status'),
    meta,
    setMeta,
    about: () => drive.about(),
  }
}

export type Engine = ReturnType<typeof createEngine>
