// Turns any incoming file (PDF, photo, scan, Word, text…) into what the archive stores:
// text per page, page images when the AI must read them, a thumbnail and every fingerprint.
import { OCR_EDGE, PAGE_EDGE, THUMB_EDGE } from '@/lib/config'
import { lshBands, minhash, sha256Hex, textHash } from '@/lib/hash'
import { decodeImage, fitCanvas, inkRatio, pageHash, toBlob } from './image'
import { docxText, mimeOf } from './office'

export type PreparedPage = {
  page_no: number
  text: string
  text_source: 'pdf' | 'docx' | 'txt' | 'ocr' | 'none'
  text_hash: string | null
  phash: string | null
  blank: boolean
  width?: number
  height?: number
  image?: Blob // page image kept for the AI and the viewer (scans and photos)
}

export type PreparedDoc = {
  name: string
  mime: string
  size: number
  sha256: string
  kind: 'pdf' | 'image' | 'docx' | 'text' | 'other' | 'scan'
  original: Blob | null
  needsOcr: boolean
  pages: PreparedPage[]
  thumb: Blob | null
  textChars: number
  textHash: string | null
  minhash: number[] | null
  lsh: string[] | null
  hint: string // folder / archive path: a clue for the classification
  note?: string
}

const TEXT_PAGE = 3500

function chunkText(t: string): string[] {
  const out: string[] = []
  let rest = t.trim()
  while (rest.length > TEXT_PAGE) {
    let cut = rest.lastIndexOf('\n', TEXT_PAGE)
    if (cut < TEXT_PAGE * 0.5) cut = rest.lastIndexOf(' ', TEXT_PAGE)
    if (cut < TEXT_PAGE * 0.5) cut = TEXT_PAGE
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

export async function fingerprints(pages: { text: string }[]) {
  const full = pages.map((p) => p.text).join('\n')
  const mh = minhash(full)
  return {
    textChars: full.replace(/\s+/g, '').length,
    textHash: await textHash(full),
    minhash: mh,
    lsh: mh ? lshBands(mh) : null,
  }
}

type Progress = (msg: string, ratio?: number) => void

export async function prepareFile(file: File, onProgress: Progress = () => {}): Promise<PreparedDoc> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sha = await sha256Hex(bytes)
  const mime = file.type || mimeOf(file.name)
  const hint = ((file as File & { khPath?: string }).khPath ?? (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '').replace(/[^/]+$/, '')
  const base: Omit<PreparedDoc, 'kind' | 'needsOcr' | 'pages' | 'thumb' | 'textChars' | 'textHash' | 'minhash' | 'lsh'> = {
    name: file.name,
    mime,
    size: file.size,
    sha256: sha,
    original: file,
    hint,
  }
  const ext = (/\.([^.]+)$/.exec(file.name)?.[1] ?? '').toLowerCase()

  // ------------------------------------------------------------ PDF
  if (mime === 'application/pdf' || ext === 'pdf') {
    const { openPdf, pageText, renderPage, closePdf } = await import('./pdf')
    let doc
    try {
      doc = await openPdf(bytes)
    } catch (e) {
      const locked = /password/i.test(String((e as Error)?.message ?? e))
      return { ...base, kind: 'other', needsOcr: false, pages: [], thumb: null, textChars: 0, textHash: null, minhash: null, lsh: null, note: locked ? 'ملف PDF محمي بكلمة سر' : 'تعذّرت قراءة ملف PDF' }
    }
    const n = doc.numPages
    const texts: string[] = []
    for (let i = 1; i <= n; i++) {
      texts.push(await pageText(doc, i).catch(() => ''))
      if (i % 10 === 0) onProgress(`قراءة النص ${i}/${n}`, (i / n) * 0.3)
    }
    const chars = texts.join('').replace(/\s+/g, '').length
    const needsOcr = chars / Math.max(n, 1) < 25
    const pages: PreparedPage[] = []
    let thumb: Blob | null = null
    for (let i = 1; i <= n; i++) {
      onProgress(needsOcr ? `تجهيز الصفحة ${i}/${n}` : `بصمة الصفحة ${i}/${n}`, 0.3 + (i / n) * 0.7)
      let phash: string | null = null
      let blank = false
      let image: Blob | undefined
      let width: number | undefined
      let height: number | undefined
      if (needsOcr) {
        const c = await renderPage(doc, i, OCR_EDGE)
        phash = pageHash(c)
        blank = inkRatio(c) < 0.0025
        image = await toBlob(c, 'image/jpeg', 0.84)
        width = c.width
        height = c.height
        if (i === 1) thumb = await toBlob(fitCanvas(c, THUMB_EDGE), 'image/jpeg', 0.8)
      } else if (i <= 80 || i === 1) {
        const c = await renderPage(doc, i, i === 1 ? THUMB_EDGE : 220)
        phash = pageHash(c)
        if (i === 1) thumb = await toBlob(c, 'image/jpeg', 0.8)
      }
      pages.push({
        page_no: i,
        text: texts[i - 1] ?? '',
        text_source: needsOcr ? 'none' : 'pdf',
        text_hash: needsOcr ? null : await textHash(texts[i - 1] ?? ''),
        phash,
        blank,
        image,
        width,
        height,
      })
    }
    await closePdf(doc)
    const fp = needsOcr ? { textChars: 0, textHash: null, minhash: null, lsh: null } : await fingerprints(pages)
    return { ...base, kind: 'pdf', needsOcr, pages, thumb, ...fp }
  }

  // ------------------------------------------------------------ photos / images
  if (mime.startsWith('image/')) {
    let bmp: ImageBitmap
    try {
      bmp = await decodeImage(file)
    } catch {
      return { ...base, kind: 'other', needsOcr: false, pages: [], thumb: null, textChars: 0, textHash: null, minhash: null, lsh: null, note: 'صيغة صورة غير مدعومة في هذا المتصفح' }
    }
    onProgress('تجهيز الصورة', 0.5)
    const c = fitCanvas(bmp, PAGE_EDGE)
    const page: PreparedPage = {
      page_no: 1,
      text: '',
      text_source: 'none',
      text_hash: null,
      phash: pageHash(c),
      blank: inkRatio(c) < 0.0025,
      image: await toBlob(c, 'image/jpeg', 0.86),
      width: c.width,
      height: c.height,
    }
    const thumb = await toBlob(fitCanvas(c, THUMB_EDGE), 'image/jpeg', 0.8)
    bmp.close()
    return { ...base, kind: 'image', needsOcr: true, pages: [page], thumb, textChars: 0, textHash: null, minhash: null, lsh: null }
  }

  // ------------------------------------------------------------ Word / plain text
  let text: string | null = null
  let kind: PreparedDoc['kind'] = 'other'
  if (ext === 'docx') {
    try {
      text = docxText(bytes)
      kind = 'docx'
    } catch {
      text = null
    }
  } else if (mime.startsWith('text/') || ['txt', 'md', 'csv', 'json'].includes(ext)) {
    text = new TextDecoder().decode(bytes)
    kind = 'text'
  }
  if (text !== null && text.trim()) {
    const chunks = chunkText(text)
    const pages: PreparedPage[] = []
    for (let i = 0; i < chunks.length; i++)
      pages.push({ page_no: i + 1, text: chunks[i], text_source: kind === 'docx' ? 'docx' : 'txt', text_hash: await textHash(chunks[i]), phash: null, blank: false })
    return { ...base, kind, needsOcr: false, pages, thumb: null, ...(await fingerprints(pages)) }
  }
  return { ...base, kind: 'other', needsOcr: false, pages: [], thumb: null, textChars: 0, textHash: null, minhash: null, lsh: null, note: 'لا يُستخرج نص من هذا النوع من الملفات' }
}

/** pages coming from the scanner (already straightened and cleaned) → one prepared document */
export async function prepareScan(pageBlobs: Blob[], name: string): Promise<PreparedDoc> {
  const pages: PreparedPage[] = []
  let thumb: Blob | null = null
  for (let i = 0; i < pageBlobs.length; i++) {
    const bmp = await decodeImage(pageBlobs[i])
    const c = fitCanvas(bmp, PAGE_EDGE)
    pages.push({
      page_no: i + 1,
      text: '',
      text_source: 'none',
      text_hash: null,
      phash: pageHash(c),
      blank: inkRatio(c) < 0.0025,
      image: pageBlobs[i],
      width: bmp.width,
      height: bmp.height,
    })
    if (i === 0) thumb = await toBlob(fitCanvas(c, THUMB_EDGE), 'image/jpeg', 0.8)
    bmp.close()
  }
  const all = new Uint8Array(await new Blob(pageBlobs).arrayBuffer())
  return {
    name,
    mime: 'image/jpeg',
    size: all.length,
    sha256: await sha256Hex(all),
    kind: 'scan',
    original: null,
    needsOcr: true,
    pages,
    thumb,
    textChars: 0,
    textHash: null,
    minhash: null,
    lsh: null,
    hint: '',
  }
}
