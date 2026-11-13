// PDF reading with pdf.js: text layer per page, page rendering (thumbnails, fingerprints, scans for the AI).
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { makeCanvas } from './image'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfDoc = pdfjs.PDFDocumentProxy

export async function openPdf(data: ArrayBuffer | Uint8Array): Promise<PdfDoc> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  // pdf.js takes ownership of the buffer: give it a copy
  return pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false }).promise
}

export async function closePdf(doc: PdfDoc | null | undefined) {
  try {
    await doc?.loadingTask.destroy()
  } catch {
    /* already closed */
  }
}

/** text of one page, lines rebuilt from the text items (Arabic runs are kept in logical order) */
export async function pageText(doc: PdfDoc, n: number): Promise<string> {
  const page = await doc.getPage(n)
  const content = await page.getTextContent()
  const lines: { y: number; parts: { x: number; s: string }[] }[] = []
  for (const it of content.items) {
    if (!('str' in it) || !it.str) continue
    const y = Math.round(it.transform[5])
    const x = it.transform[4]
    let line = lines.find((l) => Math.abs(l.y - y) <= 3)
    if (!line) {
      line = { y, parts: [] }
      lines.push(line)
    }
    line.parts.push({ x, s: it.str })
  }
  lines.sort((a, b) => b.y - a.y)
  return lines
    .map((l) => {
      const rtl = l.parts.some((p) => /[؀-ۿ]/.test(p.s))
      l.parts.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x))
      return l.parts.map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim()
    })
    .filter(Boolean)
    .join('\n')
}

/** render page n so that its long edge is `edge` pixels */
export async function renderPage(doc: PdfDoc, n: number, edge: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(n)
  const v1 = page.getViewport({ scale: 1 })
  const scale = edge / Math.max(v1.width, v1.height)
  const vp = page.getViewport({ scale })
  const canvas = makeCanvas(vp.width, vp.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
  return canvas
}
