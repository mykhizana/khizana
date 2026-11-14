// One PDF for a ready dossier (or for a single document): a cover sheet listing its papers with the
// pages where each one starts, then every page of every document on an A4 sheet with its number.
// Optional watermark («نسخة مقدَّمة إلى … — التاريخ») across every page: a copy of an ID handed over for
// one procedure cannot serve another. Everything happens on this device; nothing is sent anywhere.
import { api } from '@/db/api'
import { files } from '@/db/files'
import { jpegInfo, jpegPdf } from '@/drive/pdf'
import { docTitle, docsAr, fmtDate, pagesAr } from '@/lib/format'
import { typeLabel } from '@/lib/labels'
import type { Doc } from '@/lib/types'
import { decodeImage, makeCanvas, toBlob } from '@/prep/image'

export type PdfEntry = { id: string; requirement?: string | null }
export type PdfProgress = (text: string, ratio: number) => void
export type BuildOptions = { title: string; subtitle?: string | null; watermark?: string | null; cover?: boolean; onProgress?: PdfProgress }
export type BuiltPdf = { blob: Blob; pages: number; docs: number; missing: string[] }

/** long edge of a rendered page: about 170 dpi on A4 — sharp in print, a few hundred KB a page */
const EDGE = 2000
/** an A4 sheet drawn here (cover, text pages): 200 dpi */
const SHEET = { w: 1654, h: 2339 }
const SANS = '"IBM Plex Sans Arabic", "Inter", system-ui, sans-serif'
const SERIF = 'Amiri, "IBM Plex Sans Arabic", Georgia, serif'
const INK = '#14201f'
const MUTED = '#5d6b69'
const BRAND = '#0f5c58'

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/
const isRtl = (s: string) => ARABIC.test(s)

async function fontsReady() {
  try {
    await Promise.all([document.fonts.load(`700 40px ${SERIF}`), document.fonts.load(`400 30px ${SANS}`), document.fonts.load(`600 30px ${SANS}`)])
  } catch {
    /* the system fonts will do */
  }
}

const jpegBytes = async (c: HTMLCanvasElement, q = 0.85) => new Uint8Array(await (await toBlob(c, 'image/jpeg', q)).arrayBuffer())
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8

/** the words of `text` in lines no wider than `max` (the canvas font must be set) */
export function wrapLines(ctx: { measureText(s: string): { width: number } }, text: string, max: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\n/)) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let line = ''
    for (const w of words) {
      const next = line ? `${line} ${w}` : w
      if (line && ctx.measureText(next).width > max) {
        out.push(line)
        line = w
      } else line = next
      // one word longer than the line: cut it
      while (ctx.measureText(line).width > max && line.length > 1) {
        let cut = line.length - 1
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > max) cut--
        out.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    if (line) out.push(line)
  }
  return out
}

/** the watermark: one line of text repeated across the page, slanted, faint */
function stamp(c: HTMLCanvasElement, text: string) {
  const ctx = c.getContext('2d')!
  const size = Math.max(18, Math.round(Math.min(c.width, c.height) / 22))
  ctx.save()
  ctx.globalAlpha = 0.17
  ctx.fillStyle = '#a11d1d'
  ctx.font = `700 ${size}px ${SANS}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.direction = isRtl(text) ? 'rtl' : 'ltr'
  ctx.translate(c.width / 2, c.height / 2)
  ctx.rotate(-Math.atan2(c.height, c.width))
  const diag = Math.hypot(c.width, c.height)
  for (let y = -diag / 2; y <= diag / 2; y += size * 3.4) ctx.fillText(text, 0, y)
  ctx.restore()
}

/** a picture on a white canvas (transparent PNGs must not turn black), at most EDGE pixels long */
function onWhite(src: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  const k = Math.min(1, EDGE / Math.max(src.width, src.height))
  const c = makeCanvas(src.width * k, src.height * k)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, c.width, c.height)
  return c
}

function sheet(): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = makeCanvas(SHEET.w, SHEET.h)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  return { c, ctx }
}

/** a document with no page pictures (Word, text): its text laid out on A4 sheets */
function textSheets(title: string, texts: string[]): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = []
  const M = 150
  const size = 30
  const lh = Math.round(size * 1.65)
  const body = texts.join('\n\n').trim() || '(لا نص)'
  let s = sheet()
  let y = M
  const head = () => {
    s.ctx.font = `600 24px ${SANS}`
    s.ctx.fillStyle = MUTED
    s.ctx.direction = isRtl(title) ? 'rtl' : 'ltr'
    s.ctx.textAlign = isRtl(title) ? 'right' : 'left'
    s.ctx.fillText(title.slice(0, 90), isRtl(title) ? SHEET.w - M : M, M - 50)
    y = M + 10
  }
  head()
  s.ctx.font = `400 ${size}px ${SANS}`
  for (const para of body.split(/\n/)) {
    const rtl = isRtl(para) || (!/[A-Za-z]/.test(para) && isRtl(title))
    s.ctx.font = `400 ${size}px ${SANS}`
    const lines = para.trim() ? wrapLines(s.ctx, para, SHEET.w - M * 2) : ['']
    for (const line of lines) {
      if (y + lh > SHEET.h - M) {
        out.push(s.c)
        s = sheet()
        head()
        s.ctx.font = `400 ${size}px ${SANS}`
      }
      s.ctx.fillStyle = INK
      s.ctx.direction = rtl ? 'rtl' : 'ltr'
      s.ctx.textAlign = rtl ? 'right' : 'left'
      s.ctx.fillText(line, rtl ? SHEET.w - M : M, y + size)
      y += lh
    }
  }
  out.push(s.c)
  return out
}

/** a file the document has but this device cannot read now (kept only in Drive, Google not connected…) */
export class MissingFile extends Error {}

/**
 * The pages of one document as JPEG bytes, in order — all of them or an error, never a part: a dossier
 * handed over must not lose a page nor swap a scan for its typed text without saying so.
 */
async function docPages(d: Doc, watermark: string | null, progress: (i: number, n: number) => void): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  const title = docTitle(d)
  const finish = async (c: HTMLCanvasElement) => {
    if (watermark) stamp(c, watermark)
    out.push(await jpegBytes(c))
  }
  const orig = d.files.find((f) => f.role === 'original')
  const name = orig?.name ?? d.file_name ?? ''
  const pics = d.files.filter((f) => f.role === 'page').sort((a, b) => (a.page_no ?? 0) - (b.page_no ?? 0))

  // 1. a PDF original: every page rendered (born-digital or scanned)
  if (orig && (orig.mime === 'application/pdf' || /\.pdf$/i.test(name))) {
    const blob = await files.get(orig.path)
    if (!blob) throw new MissingFile(title)
    const { openPdf, renderPage, closePdf } = await import('@/prep/pdf')
    let pdf = null
    try {
      pdf = await openPdf(new Uint8Array(await blob.arrayBuffer()))
      for (let i = 1; i <= pdf.numPages; i++) {
        progress(i, pdf.numPages)
        await finish(await renderPage(pdf, i, EDGE))
      }
      return out
    } catch (e) {
      if (e instanceof MissingFile) throw e
      out.length = 0 // a locked or broken PDF: its page pictures, when it has them
      if (!pics.length) throw new Error(`تعذّرت قراءة ملف PDF «${title}» (محمي بكلمة سر أو تالف)`)
    } finally {
      await closePdf(pdf)
    }
  }

  // 2. the page pictures (scans, photos), every one of them: the JPEG as it is when nothing is drawn on it
  if (pics.length) {
    for (let i = 0; i < pics.length; i++) {
      progress(i + 1, pics.length)
      const blob = await files.get(pics[i].path)
      if (!blob) throw new MissingFile(title)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      // (a picture the PDF writer could not read would vanish from the file and shift the page numbers)
      if (!watermark && isJpeg(bytes) && jpegInfo(bytes)) out.push(bytes)
      else await finish(onWhite(await decodeImage(blob)))
    }
    return out
  }

  // 3. a picture original without page pictures
  if (orig && (orig.mime ?? '').startsWith('image/')) {
    const blob = await files.get(orig.path)
    if (!blob) throw new MissingFile(title)
    try {
      await finish(onWhite(await decodeImage(blob)))
    } catch {
      throw new Error(`تعذّر فتح صورة «${title}» على هذا الجهاز (صيغة لا يقرؤها المتصفح)`)
    }
    return out
  }

  // 4. a document with no picture at all (Word, text): its text laid out on A4 sheets
  for (const c of textSheets(title, (d.pages ?? []).map((p) => p.text ?? ''))) await finish(c)
  return out
}

type CoverLine = { n: number; requirement: string | null; title: string; kind: string; pages: number; first: number }

function coverSheet(o: { title: string; subtitle?: string | null; watermark?: string | null; lines: CoverLine[]; total: number }): HTMLCanvasElement {
  const { c, ctx } = sheet()
  const M = 150
  const R = SHEET.w - M
  ctx.direction = 'rtl'
  ctx.textAlign = 'right'
  // a thin band and the name of the app
  ctx.fillStyle = BRAND
  ctx.fillRect(M, 120, SHEET.w - M * 2, 8)
  ctx.font = `600 26px ${SANS}`
  ctx.fillStyle = BRAND
  ctx.fillText('خزانة · ملف جاهز', R, 190)
  ctx.textAlign = 'left'
  ctx.direction = 'ltr'
  ctx.fillStyle = MUTED
  ctx.fillText(new Date().toLocaleDateString('fr-FR'), M, 190)
  ctx.direction = 'rtl'
  ctx.textAlign = 'right'

  let y = 330
  ctx.fillStyle = INK
  ctx.font = `700 76px ${SERIF}`
  for (const line of wrapLines(ctx, o.title, SHEET.w - M * 2).slice(0, 3)) {
    ctx.fillText(line, R, y)
    y += 100
  }
  if (o.subtitle) {
    ctx.font = `400 32px ${SANS}`
    ctx.fillStyle = MUTED
    for (const line of wrapLines(ctx, o.subtitle, SHEET.w - M * 2).slice(0, 4)) {
      ctx.fillText(line, R, y)
      y += 48
    }
  }
  y += 30
  ctx.font = `600 30px ${SANS}`
  ctx.fillStyle = INK
  ctx.fillText(`محتوى الملف: ${docsAr(o.lines.length)} · ${pagesAr(o.total)}`, R, y)
  y += 30
  ctx.fillStyle = '#d9e0de'
  ctx.fillRect(M, y, SHEET.w - M * 2, 2)
  y += 70

  for (const l of o.lines) {
    if (y > SHEET.h - 330) {
      ctx.font = `400 28px ${SANS}`
      ctx.fillStyle = MUTED
      ctx.fillText(`… و${o.lines.length - l.n + 1} أخرى`, R, y)
      break
    }
    // the number in a circle, the requirement, then the document and its pages
    ctx.fillStyle = BRAND
    ctx.beginPath()
    ctx.arc(R - 26, y - 12, 26, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `700 26px ${SANS}`
    ctx.textAlign = 'center'
    ctx.fillText(String(l.n), R - 26, y - 3)
    ctx.textAlign = 'right'
    const head = l.requirement || l.title
    ctx.fillStyle = INK
    ctx.font = `600 34px ${SANS}`
    const hl = wrapLines(ctx, head, SHEET.w - M * 2 - 90)
    ctx.fillText(hl[0], R - 76, y)
    y += 46
    ctx.font = `400 27px ${SANS}`
    ctx.fillStyle = MUTED
    const pageNote = l.pages > 1 ? `الصفحات ${l.first}–${l.first + l.pages - 1}` : `الصفحة ${l.first}`
    const detail = `${l.requirement ? `${l.title} · ` : ''}${l.kind} · ${pageNote}`
    ctx.fillText(wrapLines(ctx, detail, SHEET.w - M * 2 - 90)[0], R - 76, y)
    y += 70
  }

  // the foot: what this copy is for
  ctx.fillStyle = '#d9e0de'
  ctx.fillRect(M, SHEET.h - 230, SHEET.w - M * 2, 2)
  ctx.font = `400 25px ${SANS}`
  ctx.fillStyle = MUTED
  ctx.fillText(`أُعدّ هذا الملف بتاريخ ${fmtDate(new Date().toISOString().slice(0, 10))}${o.watermark ? ` · ${o.watermark}` : ''}`, R, SHEET.h - 180)
  ctx.fillText('نسخ مطابقة لوثائق محفوظة في أرشيف صاحبها الشخصي.', R, SHEET.h - 140)
  if (o.watermark) stamp(c, o.watermark)
  return c
}

/**
 * The PDF of the given documents, in order. Documents that are gone (or hidden by the closed vault)
 * are left out and named in `missing`.
 */
export async function buildPdf(entries: PdfEntry[], o: BuildOptions): Promise<BuiltPdf> {
  await fontsReady()
  const say = o.onProgress ?? (() => undefined)
  const wm = o.watermark?.trim() || null
  const bodies: Uint8Array[] = []
  const lines: CoverLine[] = []
  const missing: string[] = []
  const away: string[] = []
  const broken: string[] = []
  const first = o.cover === false ? 1 : 2
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k]
    const d = await api.doc(e.id)
    if (!d || d.deleted_at) {
      missing.push(e.requirement || e.id)
      continue
    }
    const title = docTitle(d)
    let pages: Uint8Array[]
    try {
      pages = await docPages(d, wm, (i, n) => say(`«${title.slice(0, 40)}» — الصفحة ${i}/${n}`, (k + i / Math.max(n, 1)) / entries.length))
    } catch (err) {
      if (err instanceof MissingFile) away.push(title)
      else broken.push((err as Error).message)
      continue
    }
    if (!pages.length) {
      missing.push(e.requirement || title)
      continue
    }
    lines.push({ n: lines.length + 1, requirement: e.requirement ?? null, title, kind: typeLabel(d.doc_type), pages: pages.length, first: first + bodies.length })
    bodies.push(...pages)
  }
  // no PDF with a part missing: the owner is told what and why
  if (away.length)
    throw new Error(
      `صفحات ${away.length === 1 ? 'هذه الوثيقة' : 'هذه الوثائق'} ليست على هذا الجهاز ولم تُجلب من Google Drive: ${away.map((t) => `«${t}»`).join('، ')}. اتصل بـ Google ثم أعد المحاولة (أو انتظر حتى يرفعها الجهاز الذي أضافها).`,
    )
  if (broken.length) throw new Error(broken.join(' — '))
  if (!bodies.length) throw new Error('لا صفحة يمكن وضعها في الملف: الوثائق غير موجودة على هذا الجهاز أو في الخزنة المقفلة')
  say('تجميع الملف', 1)
  const all = o.cover === false ? bodies : [await jpegBytes(coverSheet({ title: o.title, subtitle: o.subtitle, watermark: wm, lines, total: bodies.length + 1 }), 0.9), ...bodies]
  return { blob: jpegPdf(all, o.title, { a4: true, numbers: true }), pages: all.length, docs: lines.length, missing }
}

/** the default watermark: «نسخة مقدَّمة إلى … — 14/11/2026» */
export const watermarkFor = (to: string) => `${/[A-Za-z]/.test(to) && !isRtl(to) ? `Copie remise à ${to}` : `نسخة مقدَّمة إلى ${to}`} — ${new Date().toLocaleDateString('fr-FR')}`
