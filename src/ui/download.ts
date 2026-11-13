// Getting documents out: one file, a ZIP of a selection (folders = shelves, with an index), or everything.
import { strToU8, zipSync, type Zippable } from 'fflate'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { files } from '@/db/files'
import { docTitle, extOf, pathText, safeFileName } from '@/lib/format'
import { typeLabel } from '@/lib/labels'
import type { Doc } from '@/lib/types'

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** the files of a document as [name, blob]: the original, else its page images */
async function docFiles(d: Doc): Promise<[string, Blob][]> {
  const base = safeFileName(docTitle(d))
  const orig = d.files.find((f) => f.role === 'original')
  if (orig) {
    const b = await files.get(orig.path)
    if (b) return [[`${base}.${extOf(orig.name) || extOf(orig.path) || 'bin'}`, b]]
  }
  const pages = d.files.filter((f) => f.role === 'page').sort((a, b) => (a.page_no ?? 0) - (b.page_no ?? 0))
  const out: [string, Blob][] = []
  for (const p of pages) {
    const b = await files.get(p.path)
    if (b) out.push([pages.length > 1 ? `${base} - ص${p.page_no}.jpg` : `${base}.jpg`, b])
  }
  return out
}

export async function downloadDoc(d: Doc) {
  const list = await docFiles(d)
  if (!list.length) return toast.error('لا ملف لهذه الوثيقة')
  void api.audit('download', d.id)
  if (list.length === 1) return saveBlob(list[0][1], list[0][0])
  const z: Zippable = {}
  for (const [n, b] of list) z[n] = new Uint8Array(await b.arrayBuffer())
  saveBlob(new Blob([zipSync(z, { level: 0 }) as BlobPart], { type: 'application/zip' }), `${safeFileName(docTitle(d))}.zip`)
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

export async function downloadZip(ids: string[], name: string) {
  const t = toast.loading(`تجهيز ${ids.length} وثيقة…`)
  try {
    const z: Zippable = {}
    const rows = [['العنوان', 'النوع', 'التاريخ', 'الرف', 'الأشخاص', 'الملف'].map(csvCell).join(',')]
    const used = new Set<string>()
    for (const id of ids) {
      const d = await api.doc(id)
      if (!d) continue
      const folder = (d.category_path.length ? d.category_path.map((p) => safeFileName(p.name)).join('/') : 'غير مصنفة') + '/'
      for (const [n, b] of await docFiles(d)) {
        let path = folder + n
        let k = 2
        while (used.has(path)) path = folder + n.replace(/(\.[^.]+)?$/, ` (${k++})$1`)
        used.add(path)
        z[path] = new Uint8Array(await b.arrayBuffer())
        rows.push(
          [docTitle(d), typeLabel(d.doc_type), d.academic_year || d.doc_date || '', pathText(d.category_path), d.entities.filter((e) => e.kind === 'person').map((e) => e.name).join('، '), path]
            .map(csvCell)
            .join(','),
        )
      }
      void api.audit('download', d.id, { zip: true })
    }
    z['فهرس.csv'] = strToU8('﻿' + rows.join('\n'))
    saveBlob(new Blob([zipSync(z, { level: 0 }) as BlobPart], { type: 'application/zip' }), `${safeFileName(name)}.zip`)
    toast.success('جاهز للتحميل', { id: t })
  } catch (e) {
    toast.error((e as Error).message, { id: t })
  }
}

/** a complete backup: every row of the database + every file, in one ZIP that «استرجاع» reads back */
export async function exportEverything(onProgress?: (done: number, total: number) => void) {
  const backup = await api.exportAll()
  const fileRows = (backup.tables.kh_files ?? []) as { path: string }[]
  const z: Zippable = { 'khizana-backup.json': strToU8(JSON.stringify(backup)) }
  let i = 0
  for (const f of fileRows) {
    const b = await files.get(f.path)
    if (b) z[`files/${f.path}`] = new Uint8Array(await b.arrayBuffer())
    onProgress?.(++i, fileRows.length)
  }
  const stamp = new Date().toISOString().slice(0, 10)
  saveBlob(new Blob([zipSync(z, { level: 0 }) as BlobPart], { type: 'application/zip' }), `khizana-backup-${stamp}.zip`)
  void api.audit('export', undefined, { files: fileRows.length })
}

export async function importEverything(zip: File, onProgress?: (done: number, total: number) => void) {
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(new Uint8Array(await zip.arrayBuffer()))
  const json = entries['khizana-backup.json']
  if (!json) throw new Error('هذا الملف ليس نسخة احتياطية من خزانة')
  const backup = JSON.parse(strFromU8(json))
  // files live under <owner>/…: a backup made on another device or account gets the current owner
  const { owner } = await import('@/lib/session')
  const move = (p: string) => p.replace(/^[^/]+\//, `${owner()}/`)
  for (const f of (backup.tables?.kh_files ?? []) as { path: string }[]) f.path = move(f.path)
  const paths = Object.keys(entries).filter((k) => k.startsWith('files/') && !k.endsWith('/'))
  let i = 0
  for (const k of paths) {
    await files.put(move(k.slice(6)), new Blob([entries[k] as BlobPart]))
    onProgress?.(++i, paths.length)
  }
  return api.importAll(backup)
}
