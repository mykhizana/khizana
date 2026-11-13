// From the files the owner drops (or the pages the scanner takes) to new documents in the archive.
// Layer 1 of the duplicate check runs first, on this device, before anything is uploaded.
import { api, type NewFile } from '@/db/api'
import { files } from '@/db/files'
import { sha256Hex } from '@/lib/hash'
import { extOf, pathText, uuid } from '@/lib/format'
import { owner } from '@/lib/session'
import { expandZip } from '@/prep/office'
import { prepareFile, prepareScan, type PreparedDoc } from '@/prep/prep'
import { queue } from './queue'

export type IngestItem = {
  key: string
  name: string
  status: 'waiting' | 'hashing' | 'preparing' | 'saving' | 'done' | 'duplicate' | 'failed'
  detail?: string
  ratio?: number
  docId?: string
  existing?: { document_id: string; title: string; path: string; created_at: string; deleted: boolean }
}

export type IngestOptions = {
  source: string
  sessionId?: string | null
  locationId?: string | null
  onItem?: (item: IngestItem) => void
}

async function expand(input: File[]): Promise<File[]> {
  const out: File[] = []
  for (const f of input) {
    if (extOf(f.name) === 'zip' || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
      try {
        out.push(...expandZip(new Uint8Array(await f.arrayBuffer())))
      } catch {
        out.push(f)
      }
    } else out.push(f)
  }
  return out
}

/**
 * store the bytes, then ONE database call that creates the document with everything it needs.
 * If the bytes or that call fail, the bytes written are removed; once the rows exist nothing is removed.
 */
export async function saveDoc(p: PreparedDoc, opts: { source: string; sessionId?: string | null; locationId?: string | null; detail?: string }): Promise<string> {
  const id = uuid()
  const dir = `${owner()}/${id}`
  const rows: NewFile[] = []
  const written: string[] = []
  const put = async (path: string, blob: Blob) => {
    await files.put(path, blob)
    written.push(path)
  }
  try {
    if (p.original) {
      const path = `${dir}/original${extOf(p.name) ? '.' + extOf(p.name) : ''}`
      await put(path, p.original)
      rows.push({ role: 'original', path, mime: p.mime, size: p.size, sha256: p.sha256, name: p.name })
    }
    for (const pg of p.pages) {
      if (!pg.image) continue
      const path = `${dir}/p${pg.page_no}.jpg`
      await put(path, pg.image)
      rows.push({ role: 'page', page_no: pg.page_no, path, mime: 'image/jpeg', size: pg.image.size, width: pg.width, height: pg.height })
    }
    if (p.thumb) {
      const path = `${dir}/thumb.jpg`
      await put(path, p.thumb)
      rows.push({ role: 'thumb', path, mime: 'image/jpeg', size: p.thumb.size })
    }
    await api.createDoc({
      id,
      file_name: p.name,
      source: opts.source,
      session_id: opts.sessionId,
      original_location_id: opts.locationId,
      needs_ocr: p.needsOcr,
      page_count: p.pages.length,
      text_chars: p.textChars,
      text_hash: p.textHash,
      minhash: p.minhash,
      lsh: p.lsh,
      state: 'new',
      state_detail: opts.detail ?? null,
      original_note: [p.note, p.hint ? `المجلد: ${p.hint}` : ''].filter(Boolean).join(' · ') || null,
      files: rows,
      pages: p.pages.map(({ image: _image, ...rest }) => rest),
    })
  } catch (e) {
    await files.remove(written).catch(() => undefined)
    throw e
  }
  return id
}

export async function ingestFiles(input: File[], opts: IngestOptions) {
  const list = await expand(input)
  const items: IngestItem[] = list.map((f, i) => ({ key: `${i}:${f.name}`, name: f.name, status: 'waiting' }))
  const emit = (i: number, patch: Partial<IngestItem>) => {
    items[i] = { ...items[i], ...patch }
    opts.onItem?.(items[i])
  }
  items.forEach((it) => opts.onItem?.(it))

  // layer 1: fingerprints of every file, compared with the archive before any upload
  const shas: string[] = []
  for (let i = 0; i < list.length; i++) {
    emit(i, { status: 'hashing' })
    shas.push(await sha256Hex(await list[i].arrayBuffer()))
  }
  const known = new Map((await api.shaLookup([...new Set(shas)])).map((x) => [x.sha256, x]))
  const seen = new Map<string, number>()
  const added: string[] = []

  for (let i = 0; i < list.length; i++) {
    const hit = known.get(shas[i])
    if (hit) {
      emit(i, { status: 'duplicate', existing: { document_id: hit.document_id, title: hit.title, path: pathText(hit.category_path), created_at: hit.created_at, deleted: hit.deleted } })
      await api.audit('duplicate_skipped', hit.document_id, { name: list[i].name }).catch(() => undefined)
      continue
    }
    const twin = seen.get(shas[i])
    if (twin !== undefined) {
      emit(i, { status: 'duplicate', detail: `مكررة داخل نفس الدفعة (${list[twin].name})`, existing: items[twin].docId ? { document_id: items[twin].docId!, title: list[twin].name, path: '', created_at: new Date().toISOString(), deleted: false } : undefined })
      continue
    }
    seen.set(shas[i], i)
    try {
      emit(i, { status: 'preparing', ratio: 0 })
      const p = await prepareFile(list[i], (detail, ratio) => emit(i, { detail, ratio }))
      emit(i, { status: 'saving', detail: undefined })
      const id = await saveDoc(p, opts)
      added.push(id)
      emit(i, { status: 'done', docId: id })
      queue.kick()
    } catch (e) {
      emit(i, { status: 'failed', detail: (e as Error).message })
    }
  }
  return { items, added }
}

/** scanner pages → one document, or a «stack» the AI splits into separate documents */
export async function ingestScan(pages: Blob[], o: { name: string; stack: boolean; sessionId?: string | null; locationId?: string | null }) {
  const p = await prepareScan(pages, o.name)
  const id = await saveDoc(p, { source: o.stack && pages.length > 1 ? 'stack' : 'scan', sessionId: o.sessionId, locationId: o.locationId })
  queue.kick()
  return id
}
