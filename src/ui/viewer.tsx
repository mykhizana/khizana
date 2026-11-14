// Shows a document: page images (scans, photos), PDF pages rendered on demand, or the text.
import { FileText, ImageIcon, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { files } from '@/db/files'
import { norm, queryTokens, stem } from '@/lib/norm'
import type { Doc } from '@/lib/types'
import { Hl, useFileUrl } from './bits'
import { Segmented, Spinner, cn } from './kit'

function PageImage({ path, n, active }: { path: string; n: number; active: boolean }) {
  const url = useFileUrl(path)
  return (
    <figure id={`page-${n}`} className={cn('overflow-hidden rounded-xl border bg-white shadow-soft', active ? 'border-brass-500 ring-2 ring-brass-400/40' : 'border-line')}>
      {url ? <img src={url} alt={`صفحة ${n}`} loading="lazy" className="w-full" /> : <div className="kh-skeleton aspect-[3/4] w-full" />}
      <figcaption className="num border-t border-line bg-surface px-3 py-1 text-center text-[11px] text-muted">{n}</figcaption>
    </figure>
  )
}

function PdfPages({ path, pageCount, active }: { path: string; pageCount: number; active: number | null }) {
  const [doc, setDoc] = useState<import('@/prep/pdf').PdfDoc | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    let opened: import('@/prep/pdf').PdfDoc | null = null
    void (async () => {
      try {
        const blob = await files.get(path)
        if (!blob) throw new Error('missing')
        const { openPdf } = await import('@/prep/pdf')
        opened = await openPdf(await blob.arrayBuffer())
        if (alive) setDoc(opened)
      } catch {
        if (alive) setErr(true)
      }
    })()
    return () => {
      alive = false
      void import('@/prep/pdf').then(({ closePdf }) => closePdf(opened))
    }
  }, [path])
  if (err) return <p className="p-6 text-center text-sm text-muted">تعذّر عرض ملف PDF — يمكنك تحميله.</p>
  if (!doc) return <div className="grid h-60 place-items-center"><Spinner /></div>
  return (
    <div className="space-y-4">
      {Array.from({ length: Math.min(doc.numPages, pageCount || doc.numPages) }, (_, i) => (
        <PdfPage key={i} doc={doc} n={i + 1} active={active === i + 1} />
      ))}
    </div>
  )
}

function PdfPage({ doc, n, active }: { doc: import('@/prep/pdf').PdfDoc; n: number; active: boolean }) {
  const holder = useRef<HTMLDivElement>(null)
  const [img, setImg] = useState<string | null>(null)
  useEffect(() => {
    const el = holder.current
    if (!el) return
    let done = false
    const io = new IntersectionObserver(
      async (entries) => {
        if (done || !entries.some((e) => e.isIntersecting)) return
        done = true
        const { renderPage } = await import('@/prep/pdf')
        const c = await renderPage(doc, n, 1400)
        setImg(c.toDataURL('image/jpeg', 0.85))
      },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [doc, n])
  return (
    <figure id={`page-${n}`} ref={holder} className={cn('overflow-hidden rounded-xl border bg-white shadow-soft', active ? 'border-brass-500 ring-2 ring-brass-400/40' : 'border-line')}>
      {img ? <img src={img} alt={`صفحة ${n}`} className="w-full" /> : <div className="kh-skeleton aspect-[3/4] w-full" />}
      <figcaption className="num border-t border-line bg-surface px-3 py-1 text-center text-[11px] text-muted">{n}</figcaption>
    </figure>
  )
}

export function Viewer({ doc, page, hl }: { doc: Doc; page: number | null; hl: string }) {
  const pages = doc.files.filter((f) => f.role === 'page').sort((a, b) => (a.page_no ?? 0) - (b.page_no ?? 0))
  const orig = doc.files.find((f) => f.role === 'original')
  const isPdf = !!orig && (orig.mime === 'application/pdf' || /\.pdf$/i.test(orig.path))
  const hasVisual = pages.length > 0 || isPdf
  const hasText = doc.pages.some((p) => p.text.trim())
  const [tab, setTab] = useState<'pages' | 'text'>(hasVisual ? 'pages' : 'text')
  const [zoom, setZoom] = useState(1)
  const [find, setFind] = useState(hl)
  const tokens = useMemo(() => queryTokens(find), [find])
  // a new place to show (a citation, an article of the index): its words are looked for again
  useEffect(() => {
    if (hl) setFind(hl)
  }, [hl])

  useEffect(() => {
    if (!page) return
    const t = setTimeout(() => document.getElementById(tab === 'pages' ? `page-${page}` : `text-${page}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400)
    return () => clearTimeout(t)
  }, [page, tab])

  const textPages = tokens.length ? doc.pages.filter((p) => tokens.some((t) => normIncludes(p.text, t))) : doc.pages

  return (
    <div className="rounded-2xl border border-line bg-surface-2/60 p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {hasVisual && hasText ? (
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'pages', label: 'الصفحات', icon: ImageIcon },
              { value: 'text', label: 'النص', icon: FileText },
            ]}
          />
        ) : null}
        {tab === 'text' || !hasVisual ? (
          <div className="relative min-w-40 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
            <input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="ابحث داخل الوثيقة"
              className="h-9 w-full rounded-xl border border-line bg-surface ps-9 pe-3 text-sm outline-none focus:border-brand-500"
            />
          </div>
        ) : (
          <div className="ms-auto flex items-center gap-1">
            <button className="grid size-8 place-items-center rounded-lg hover:bg-surface" onClick={() => setZoom((z) => Math.max(0.6, z - 0.2))} aria-label="تصغير">
              <ZoomOut className="size-4" />
            </button>
            <span className="num w-10 text-center text-xs text-muted">{Math.round(zoom * 100)}%</span>
            <button className="grid size-8 place-items-center rounded-lg hover:bg-surface" onClick={() => setZoom((z) => Math.min(2.4, z + 0.2))} aria-label="تكبير">
              <ZoomIn className="size-4" />
            </button>
          </div>
        )}
      </div>

      {tab === 'pages' && hasVisual ? (
        <div className="overflow-x-auto">
          <div className="mx-auto space-y-4" style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? 820 : undefined }}>
            {pages.length ? pages.map((p) => <PageImage key={p.id} path={p.path} n={p.page_no ?? 1} active={page === p.page_no} />) : orig ? <PdfPages path={orig.path} pageCount={doc.page_count} active={page} /> : null}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {!hasText && <p className="p-6 text-center text-sm text-muted">{doc.needs_ocr ? 'لم تُقرأ صفحات هذه الوثيقة بعد — يقرؤها Claude عند ربطه.' : 'لا نص مستخرج.'}</p>}
          {textPages.map((p) => (
            <div key={p.page_no} id={`text-${p.page_no}`} className={cn('rounded-xl border bg-surface p-4', page === p.page_no ? 'border-brass-500' : 'border-line')}>
              <div className="num mb-2 text-[11px] text-muted">صفحة {p.page_no}{p.text_source === 'ocr' ? ' · قرأها Claude' : ''}</div>
              <p dir="auto" className="whitespace-pre-wrap text-[14px] leading-7 text-text">
                <Hl text={p.text} tokens={tokens} />
              </p>
            </div>
          ))}
          {tokens.length > 0 && textPages.length === 0 && <p className="p-4 text-center text-sm text-muted">لا توجد هذه الكلمات في نص الوثيقة.</p>}
        </div>
      )}
    </div>
  )
}

function normIncludes(text: string, token: string) {
  const n = norm(text)
  return n.includes(token) || n.includes(stem(token))
}
