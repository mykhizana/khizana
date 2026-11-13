// The smart scanner: live paper detection, automatic capture when the phone is still,
// straightening, shadow removal, blur and blank-page warnings, one document / a mixed stack / an ID card.
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Camera, Check, ChevronLeft, ChevronRight, CreditCard, Files, FileText, Flashlight, ImagePlus, Layers, Loader2, MapPin, RotateCw, SearchCheck, Trash2, Wand2, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { pathText } from '@/lib/format'
import { useAiMode, useLocations } from '@/lib/queries'
import { ingestScan } from '@/pipeline/ingest'
import { decodeImage, fitCanvas, pageHash, toBlob } from '@/prep/image'
import type { EnhanceMode } from '@/scan/enhance'
import { fullQuad, luma, type Pt, type Quad } from '@/scan/geometry'
import { detectOn, frameDiff, processCapture, sourceCanvas } from '@/scan/process'
import { Button, Dialog, cn } from '@/ui/kit'
import { LocationPicker } from '@/ui/pickers'

// the captured photo is kept as a JPEG (not a canvas): long stacks stay within a phone's memory
type Page = { id: string; src: Blob; srcW: number; srcH: number; quad: Quad; rotate: number; mode: EnhanceMode; blob: Blob; url: string; sharp: number; blank: boolean }
type ScanMode = 'one' | 'stack' | 'card' | 'check'
type CheckResult = { url: string; page: Omit<Page, 'id'>; matches: Awaited<ReturnType<typeof api.phashLookup>> }

const MODES: { v: ScanMode; l: string; icon: typeof FileText; hint: string }[] = [
  { v: 'one', l: 'وثيقة واحدة', icon: FileText, hint: 'كل الصفحات = وثيقة واحدة' },
  { v: 'stack', l: 'رزمة مختلطة', icon: Layers, hint: 'أوراق مختلفة: يفصلها Claude وحده' },
  { v: 'card', l: 'بطاقة بوجهين', icon: CreditCard, hint: 'الوجه ثم الظهر' },
  { v: 'check', l: 'هل عندي هذه؟', icon: SearchCheck, hint: 'صوّر ورقة لتعرف إن كانت في خزانتك' },
]
const ENHANCE: { v: EnhanceMode; l: string }[] = [
  { v: 'document', l: 'مستند' },
  { v: 'color', l: 'ألوان' },
  { v: 'gray', l: 'رمادي' },
  { v: 'bw', l: 'أبيض وأسود' },
]
const BLURRY = 45

export default function ScanPage() {
  const [sp] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const ai = useAiMode().data
  const locs = useLocations().data ?? []
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [quad, setQuad] = useState<Quad | null>(null)
  const [steady, setSteady] = useState(0)
  const [auto, setAuto] = useState(true)
  const [mode, setMode] = useState<ScanMode>('one')
  const [enh, setEnh] = useState<EnhanceMode>('document')
  const [pages, setPages] = useState<Page[]>([])
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [torch, setTorch] = useState<boolean | null>(null)
  const [locationId, setLocationId] = useState<string | null>(sp.get('location'))
  const [picking, setPicking] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const loc = locs.find((l) => l.id === locationId)
  const armed = useRef(true)
  const busyRef = useRef(false)
  const autoRef = useRef(auto)
  autoRef.current = auto

  // ---------------------------------------------------------------- camera
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        })
        if (!alive) return s.getTracks().forEach((t) => t.stop())
        streamRef.current = s
        const v = videoRef.current!
        v.srcObject = s
        await v.play()
        setDims({ w: v.videoWidth, h: v.videoHeight })
        const caps = (s.getVideoTracks()[0].getCapabilities?.() ?? {}) as { torch?: boolean }
        if (caps.torch) setTorch(false)
      } catch (e) {
        setCamError((e as Error).name === 'NotAllowedError' ? 'لم يُسمح باستعمال الكاميرا' : 'لا توجد كاميرا متاحة على هذا الجهاز')
      }
    })()
    return () => {
      alive = false
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // ---------------------------------------------------------------- capture
  const addFromCanvas = useCallback(
    async (raw: HTMLCanvasElement, knownQuad?: Quad | null) => {
      const source = sourceCanvas(raw)
      const q = knownQuad ? (knownQuad.map((p) => ({ x: (p.x * source.width) / raw.width, y: (p.y * source.height) / raw.height })) as Quad) : null
      const r = await processCapture(source, { quad: q, mode: enh })
      const src = await toBlob(source, 'image/jpeg', 0.9)
      const page: Page = { id: crypto.randomUUID(), src, srcW: source.width, srcH: source.height, quad: r.quad, rotate: 0, mode: enh, blob: r.blob, url: URL.createObjectURL(r.blob), sharp: r.sharp, blank: r.blank }
      if (mode === 'check') {
        // «هل عندي هذه؟»: compare the straightened page with every archived page (layer 3)
        const bmp = await decodeImage(r.blob)
        const hash = pageHash(bmp)
        bmp.close()
        const matches = hash ? await api.phashLookup(hash, 10) : []
        setCheck({ url: page.url, page, matches })
        return
      }
      setPages((p) => [...p, page])
      if (r.sharp < BLURRY) toast.warning('هذه الصفحة ضبابية — يُستحسن إعادة تصويرها', { duration: 4000 })
      else if (r.blank) toast('صفحة فارغة — لن تُحفظ')
    },
    [enh, mode],
  )

  const capture = useCallback(async () => {
    const v = videoRef.current
    if (!v || busyRef.current || !v.videoWidth) return
    busyRef.current = true
    setBusy(true)
    setFlash(true)
    setTimeout(() => setFlash(false), 140)
    try {
      let canvas: HTMLCanvasElement
      const track = streamRef.current?.getVideoTracks()[0]
      const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> } }).ImageCapture
      if (IC && track) {
        try {
          const blob = await new IC(track).takePhoto()
          const bmp = await decodeImage(blob)
          canvas = fitCanvas(bmp, 4000)
          bmp.close()
        } catch {
          canvas = fitCanvas(v as unknown as HTMLCanvasElement & { width: number; height: number }, 4000)
        }
      } else {
        canvas = document.createElement('canvas')
        canvas.width = v.videoWidth
        canvas.height = v.videoHeight
        canvas.getContext('2d')!.drawImage(v, 0, 0)
      }
      await addFromCanvas(canvas)
      armed.current = false
      if (navigator.vibrate) navigator.vibrate(30)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [addFromCanvas])

  // ---------------------------------------------------------------- live detection + steadiness
  useEffect(() => {
    if (!dims) return
    const small = document.createElement('canvas')
    const k = 360 / Math.max(dims.w, dims.h)
    small.width = Math.round(dims.w * k)
    small.height = Math.round(dims.h * k)
    const ctx = small.getContext('2d', { willReadFrequently: true })!
    let prev: Uint8Array | null = null
    let still = 0
    const timer = setInterval(() => {
      const v = videoRef.current
      if (!v || v.readyState < 2) return
      ctx.drawImage(v, 0, 0, small.width, small.height)
      const g = luma(ctx.getImageData(0, 0, small.width, small.height).data, small.width * small.height)
      const q = detectOn(small)
      setQuad(q)
      const diff = prev ? frameDiff(prev, g) : 255
      prev = g
      if (diff > 10) armed.current = true // the page changed: ready for the next capture
      still = diff < 3.2 && q ? still + 1 : 0
      setSteady(Math.min(still, 6))
      if (autoRef.current && armed.current && still >= 6 && !busyRef.current) {
        still = 0
        void capture()
      }
    }, 180)
    return () => clearInterval(timer)
  }, [dims, capture])

  // ---------------------------------------------------------------- photos from the gallery / native camera
  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    for (const f of list) {
      try {
        const bmp = await decodeImage(f)
        const c = fitCanvas(bmp, 4000)
        bmp.close()
        await addFromCanvas(c)
      } catch {
        toast.error(`تعذّرت قراءة ${f.name}`)
      }
    }
    setBusy(false)
  }

  // ---------------------------------------------------------------- save
  const save = async () => {
    const keep = pages.filter((p) => !p.blank)
    if (!keep.length) return toast.error('لا صفحات لحفظها')
    setSaving(true)
    try {
      let sid = sessionId
      if (!sid) {
        sid = (await api.sessionStart('scan', locationId, loc?.name)).id
        setSessionId(sid)
      }
      const name = `مسح ${new Date().toLocaleDateString('fr-MA')} ${new Date().toLocaleTimeString('fr-MA', { hour: '2-digit', minute: '2-digit' })}`
      const id = await ingestScan(
        keep.map((p) => p.blob),
        { name, stack: mode === 'stack', sessionId: sid, locationId },
      )
      pages.forEach((p) => URL.revokeObjectURL(p.url))
      setPages([])
      await qc.invalidateQueries()
      toast.success(mode === 'stack' && keep.length > 1 ? `حُفظت ${keep.length} صفحة — سيفصلها ${ai === 'claude' ? 'Claude' : 'التطبيق'} إلى وثائق` : 'حُفظت الوثيقة', {
        action: { label: 'افتحها', onClick: () => nav(`/doc/${id}`) },
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const close = () => {
    if (pages.length && !confirm('لم تُحفظ الصفحات الممسوحة. الخروج على أي حال؟')) return
    nav(-1)
  }

  const blurry = pages.filter((p) => p.sharp < BLURRY && !p.blank).length
  const cardDone = mode === 'card' && pages.length >= 2

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#05100e] text-white">
      {/* top */}
      <div className="flex items-center gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-2">
        <button onClick={close} className="grid size-10 place-items-center rounded-full bg-white/10" aria-label="خروج">
          <X className="size-5" />
        </button>
        <button onClick={() => setPicking(true)} className="flex min-w-0 items-center gap-1.5 rounded-full bg-white/10 px-3 py-2 text-xs">
          <MapPin className="size-3.5 text-brass-400" />
          <span className="truncate">{loc ? loc.name : 'مكان الأصل؟'}</span>
        </button>
        <div className="ms-auto flex items-center gap-1.5">
          {torch !== null && (
            <button
              onClick={async () => {
                const t = streamRef.current?.getVideoTracks()[0]
                await t?.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }).catch(() => undefined)
                setTorch(!torch)
              }}
              className={cn('grid size-10 place-items-center rounded-full', torch ? 'bg-brass-400 text-brand-950' : 'bg-white/10')}
              aria-label="الضوء"
            >
              <Flashlight className="size-5" />
            </button>
          )}
          <button onClick={() => setAuto((a) => !a)} className={cn('flex items-center gap-1 rounded-full px-3 py-2 text-xs', auto ? 'bg-brass-400 text-brand-950' : 'bg-white/10')}>
            <Zap className="size-3.5" /> {auto ? 'تلقائي' : 'يدوي'}
          </button>
        </div>
      </div>

      {/* modes */}
      <div className="kh-scroll-x flex gap-2 px-3 pb-2">
        {MODES.map((m) => (
          <button key={m.v} onClick={() => setMode(m.v)} className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs', mode === m.v ? 'border-brass-400 bg-brass-400/15 text-brass-200' : 'border-white/15 text-white/75')}>
            <m.icon className="size-3.5" /> {m.l}
          </button>
        ))}
      </div>

      {/* viewfinder */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {camError ? (
          <div className="max-w-xs px-6 text-center">
            <Camera className="mx-auto size-10 text-white/50" />
            <p className="mt-3 text-sm text-white/80">{camError}</p>
            <Button variant="brass" className="mt-5" icon={ImagePlus} onClick={() => fileRef.current?.click()}>
              التقط أو اختر صوراً
            </Button>
          </div>
        ) : (
          <div className="relative max-h-full max-w-full" style={dims ? { aspectRatio: `${dims.w} / ${dims.h}`, height: '100%' } : undefined}>
            <video ref={videoRef} playsInline muted className="size-full object-contain" />
            {dims && quad && (
              <svg className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${Math.round((dims.w * 360) / Math.max(dims.w, dims.h))} ${Math.round((dims.h * 360) / Math.max(dims.w, dims.h))}`} preserveAspectRatio="none">
                <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} fill={steady >= 4 ? 'rgba(207,167,95,0.22)' : 'rgba(207,167,95,0.1)'} stroke="#cfa75f" strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </svg>
            )}
            {flash && <div className="absolute inset-0 bg-white/70" />}
            {mode === 'card' && <div className="absolute inset-x-0 top-3 text-center text-xs text-white/85">{pages.length === 0 ? 'صوّر وجه البطاقة' : pages.length === 1 ? 'اقلبها وصوّر ظهرها' : 'تمّ الوجهان'}</div>}
            {auto && quad && steady > 0 && steady < 6 && (
              <div className="absolute inset-x-0 bottom-4 text-center text-xs text-brass-200">ثبّت الهاتف… {'●'.repeat(steady)}</div>
            )}
          </div>
        )}
        {busy && (
          <div className="absolute end-4 top-4 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin" /> معالجة الصفحة
          </div>
        )}
      </div>

      {/* pages strip */}
      {pages.length > 0 && (
        <div className="kh-scroll-x flex gap-2 px-3 py-2">
          {pages.map((p, i) => (
            <button key={p.id} onClick={() => setEditing(i)} className={cn('relative h-20 w-14 shrink-0 overflow-hidden rounded-lg border-2', p.blank ? 'border-white/20 opacity-50' : p.sharp < BLURRY ? 'border-warning' : 'border-white/30')}>
              <img src={p.url} alt="" className="size-full object-cover" />
              <span className="num absolute bottom-0 inset-x-0 bg-black/55 text-[10px]">{i + 1}</span>
              {p.sharp < BLURRY && !p.blank && <AlertTriangle className="absolute end-0.5 top-0.5 size-3.5 text-warning" />}
            </button>
          ))}
        </div>
      )}

      {/* controls */}
      <div className="flex items-center justify-between gap-3 px-5 pt-2 pb-[max(18px,env(safe-area-inset-bottom))]">
        <div className="flex w-24 flex-col gap-1.5">
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 text-xs text-white/80">
            <ImagePlus className="size-4" /> من المعرض
          </button>
          <select value={enh} onChange={(e) => setEnh(e.target.value as EnhanceMode)} className="rounded-lg border-0 bg-white/10 px-2 py-1 text-xs text-white">
            {ENHANCE.map((x) => (
              <option key={x.v} value={x.v} className="text-black">
                {x.l}
              </option>
            ))}
          </select>
        </div>
        <button onClick={capture} disabled={busy || !!camError || cardDone} className="grid size-[74px] place-items-center rounded-full border-4 border-white/85 disabled:opacity-40" aria-label="التقط">
          <span className={cn('size-[58px] rounded-full bg-white transition', busy && 'scale-90 bg-brass-400')} />
        </button>
        <div className="flex w-24 justify-end">
          <button onClick={save} disabled={!pages.length || saving} className="flex flex-col items-center gap-1 rounded-2xl bg-brass-500 px-3 py-2 text-brand-950 disabled:opacity-40">
            {saving ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
            <span className="text-[11px] font-semibold">
              حفظ <span className="num">{pages.filter((p) => !p.blank).length}</span>
            </span>
          </button>
        </div>
      </div>
      {blurry > 0 && <div className="bg-warning/90 px-4 py-1.5 text-center text-xs text-white">{blurry} صفحة ضبابية — اضغط عليها لإعادة تصويرها أو حذفها</div>}
      <p className="sr-only">{MODES.find((m) => m.v === mode)?.hint}</p>

      <input ref={fileRef} type="file" accept="image/*" multiple capture={camError ? 'environment' : undefined} hidden onChange={(e) => onFiles(e.target.files)} />

      {editing !== null && pages[editing] && (
        <PageEditor
          page={pages[editing]}
          index={editing}
          total={pages.length}
          onNav={(d) => setEditing((i) => Math.max(0, Math.min(pages.length - 1, (i ?? 0) + d)))}
          onClose={() => setEditing(null)}
          onDelete={() => {
            URL.revokeObjectURL(pages[editing].url)
            setPages((p) => p.filter((_, i) => i !== editing))
            setEditing(null)
          }}
          onApply={async (patch) => {
            const p = pages[editing]
            const bmp = await decodeImage(p.src)
            const canvas = fitCanvas(bmp, 3000)
            bmp.close()
            const r = await processCapture(canvas, { quad: patch.quad, mode: patch.mode, rotate: patch.rotate })
            URL.revokeObjectURL(p.url)
            const next: Page = { ...p, ...patch, blob: r.blob, url: URL.createObjectURL(r.blob), sharp: r.sharp, blank: r.blank }
            setPages((list) => list.map((x, i) => (i === editing ? next : x)))
          }}
        />
      )}
      <LocationPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(id) => {
          setLocationId(id)
          setSessionId(null)
          setPicking(false)
        }}
      />
      {check && (
        <Dialog
          open
          onClose={() => setCheck(null)}
          title={!check.matches.length ? 'ليست في خزانتك' : check.matches[0].distance <= 3 ? 'عندك هذه الوثيقة على الأرجح' : 'عندك وثيقة تشبهها'}
          footer={
            <>
              <Button
                icon={Check}
                variant={check.matches.length ? 'secondary' : 'primary'}
                onClick={() => {
                  setPages((p) => [...p, { ...check.page, id: crypto.randomUUID() }])
                  setMode('one')
                  setCheck(null)
                }}
              >
                {check.matches.length ? 'أضفها رغم ذلك' : 'أضفها'}
              </Button>
              <Button variant="secondary" icon={Camera} onClick={() => setCheck(null)}>
                صوّر ورقة أخرى
              </Button>
            </>
          }
        >
          <div className="flex gap-4">
            <img src={check.url} alt="" className="h-36 w-28 shrink-0 rounded-xl border border-line object-cover" />
            {check.matches.length ? (
              <ul className="min-w-0 flex-1 space-y-2">
                {check.matches.map((m) => (
                  <li key={m.document_id + m.page_no}>
                    <Link to={`/doc/${m.document_id}?page=${m.page_no}`} className="block rounded-xl border border-line p-2.5 hover:border-brand-500">
                      <div className="text-sm font-medium text-ink">{m.title}</div>
                      <div className="text-xs text-muted">
                        {pathText(m.category_path) || 'غير مصنفة'} · صفحة {m.page_no} · {m.distance <= 3 ? 'مطابقة شبه تامة' : 'تشابه في الشكل — قد تكون نفس الاستمارة بمحتوى آخر'}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex-1 text-sm leading-relaxed text-muted">لم أجد صفحة تشبهها في أرشيفك. يمكنك إضافتها الآن، أو تصوير ورقة أخرى.</p>
            )}
          </div>
        </Dialog>
      )}
    </div>
  )
}

function PageEditor({
  page,
  index,
  total,
  onNav,
  onClose,
  onDelete,
  onApply,
}: {
  page: Page
  index: number
  total: number
  onNav: (d: number) => void
  onClose: () => void
  onDelete: () => void
  onApply: (p: { quad: Quad; mode: EnhanceMode; rotate: number }) => Promise<void>
}) {
  const [quad, setQuad] = useState<Quad>(page.quad)
  const [mode, setMode] = useState<EnhanceMode>(page.mode)
  const [rotate, setRotate] = useState(page.rotate)
  const [view, setView] = useState<'result' | 'corners'>('result')
  const [busy, setBusy] = useState(false)
  const imgRef = useRef<HTMLDivElement>(null)
  const drag = useRef<number | null>(null)
  const [srcUrl, setSrcUrl] = useState('')
  useEffect(() => {
    setQuad(page.quad)
    setMode(page.mode)
    setRotate(page.rotate)
    const u = URL.createObjectURL(page.src)
    setSrcUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [page.id])

  const toLocal = (e: React.PointerEvent): Pt => {
    const r = imgRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * page.srcW, y: ((e.clientY - r.top) / r.height) * page.srcH }
  }
  const apply = async () => {
    setBusy(true)
    await onApply({ quad, mode, rotate })
    setBusy(false)
    setView('result')
  }

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={
        <span className="flex items-center gap-2">
          صفحة <span className="num">{index + 1}</span> من <span className="num">{total}</span>
        </span>
      }
      footer={
        <>
          <Button variant="ghost" icon={Trash2} className="me-auto text-danger" onClick={onDelete}>
            حذف
          </Button>
          <Button variant="secondary" size="sm" icon={ChevronRight} onClick={() => onNav(-1)} disabled={index === 0}>
            السابقة
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onNav(1)} disabled={index === total - 1}>
            التالية <ChevronLeft className="size-4" />
          </Button>
          <Button icon={Wand2} loading={busy} onClick={apply}>
            طبّق
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-line bg-surface-2 p-1 text-[13px]">
          {(['result', 'corners'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn('rounded-lg px-3 py-1.5', view === v ? 'bg-surface text-ink shadow-soft' : 'text-muted')}>
              {v === 'result' ? 'النتيجة' : 'ضبط الزوايا'}
            </button>
          ))}
        </div>
        <select value={mode} onChange={(e) => setMode(e.target.value as EnhanceMode)} className="h-9 rounded-xl border border-line bg-surface px-2 text-sm text-ink">
          {ENHANCE.map((x) => (
            <option key={x.v} value={x.v}>
              {x.l}
            </option>
          ))}
        </select>
        <Button variant="secondary" size="sm" icon={RotateCw} onClick={() => setRotate((r) => (r + 90) % 360)}>
          تدوير
        </Button>
        <Button variant="ghost" size="sm" icon={Files} onClick={() => setQuad(fullQuad(page.srcW, page.srcH))}>
          الصورة كاملة
        </Button>
        {page.sharp < BLURRY && !page.blank && <span className="text-xs text-warning">ضبابية — أعد تصويرها إن أمكن</span>}
      </div>
      {view === 'result' ? (
        <img src={page.url} alt="" className="mx-auto max-h-[60vh] rounded-xl border border-line bg-white" />
      ) : (
        <div
          ref={imgRef}
          className="relative mx-auto max-h-[60vh] touch-none select-none"
          style={{ aspectRatio: `${page.srcW} / ${page.srcH}`, maxWidth: '100%', height: '60vh' }}
          onPointerMove={(e) => {
            if (drag.current === null) return
            const p = toLocal(e)
            p.x = Math.max(0, Math.min(page.srcW, p.x))
            p.y = Math.max(0, Math.min(page.srcH, p.y))
            setQuad((q) => q.map((x, i) => (i === drag.current ? p : x)) as Quad)
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerLeave={() => (drag.current = null)}
        >
          {srcUrl ? <img src={srcUrl} alt="" className="size-full rounded-xl object-fill" draggable={false} /> : null}
          <svg className="absolute inset-0 size-full" viewBox={`0 0 ${page.srcW} ${page.srcH}`} preserveAspectRatio="none">
            <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(207,167,95,0.15)" stroke="#cfa75f" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          </svg>
          {quad.map((p, i) => (
            <span
              key={i}
              onPointerDown={(e) => {
                ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
                drag.current = i
              }}
              className="absolute size-7 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-[3px] border-white bg-brass-500 shadow-pop"
              style={{ left: `${(p.x / page.srcW) * 100}%`, top: `${(p.y / page.srcH) * 100}%` }}
            />
          ))}
        </div>
      )}
    </Dialog>
  )
}
