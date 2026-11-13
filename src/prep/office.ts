// Text out of Word (.docx) files and archives (.zip), without heavy libraries.
import { unzipSync, strFromU8 } from 'fflate'

export function docxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' })
  const xml = files['word/document.xml']
  if (!xml) return ''
  const s = strFromU8(xml)
  return s
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  zip: 'application/zip',
}
export const mimeOf = (name: string, fallback = 'application/octet-stream') => MIME[(/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase()] ?? fallback

/** a .zip becomes the list of its files (folders kept in the name as a hint for classification) */
export function expandZip(bytes: Uint8Array): File[] {
  const entries = unzipSync(bytes)
  const out: File[] = []
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/') || !data.length) continue
    if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)/i.test(name)) continue
    const base = name.split('/').pop() ?? name
    const f = new File([data as BlobPart], base, { type: mimeOf(base) })
    Object.defineProperty(f, 'khPath', { value: name })
    out.push(f)
  }
  return out
}
