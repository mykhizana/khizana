import { useQueryClient } from '@tanstack/react-query'
import { Camera, CheckCircle2, CloudDownload, CopyX, FileUp, FolderUp, Loader2, MapPin, ShieldCheck, Sparkles, Upload, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { idb } from '@/db/idb'
import { fetchPicked, type Picked, type Skipped } from '@/drive/import'
import { drive } from '@/drive/sync'
import { relTime } from '@/lib/format'
import { useAiMode, useLocations } from '@/lib/queries'
import { ingestFiles, type IngestItem } from '@/pipeline/ingest'
import { PageHeader } from '@/ui/bits'
import { FakeDrivePicker, pickFromDrive, prepareDrive, useCanDrive } from '@/ui/drive-import'
import { Badge, Button, Card, LinkButton, Progress, cn } from '@/ui/kit'
import { LocationPicker } from '@/ui/pickers'

export default function AddPage() {
  const [sp] = useSearchParams()
  const qc = useQueryClient()
  const locs = useLocations().data ?? []
  const ai = useAiMode().data
  const [locationId, setLocationId] = useState<string | null>(sp.get('location'))
  const [picking, setPicking] = useState(false)
  const [items, setItems] = useState<IngestItem[]>([])
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const busyRef = useRef(false)
  const filesRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)
  const loc = locs.find((l) => l.id === locationId)
  const canDrive = useCanDrive()
  const [fetching, setFetching] = useState<{ done: number; total: number; name: string } | null>(null)
  const [fakePick, setFakePick] = useState<((p: Picked[]) => void) | null>(null)

  /**
   * `kind`: the batch (one of the session kinds the database allows); `pre`: files that never reached the
   * archive (left in Drive), shown with their reason; `source`: where the documents came from
   */
  const run = async (list: File[], kind: string, pre: IngestItem[] = [], source = kind) => {
    if ((!list.length && !pre.length) || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setItems(pre)
    try {
      if (list.length) {
        const s = await api.sessionStart(kind, locationId, loc?.name)
        await ingestFiles(list, {
          source,
          sessionId: s.id,
          locationId,
          onItem: (it) =>
            setItems((prev) => {
              const i = prev.findIndex((x) => x.key === it.key)
              if (i < 0) return [...prev, it]
              const n = [...prev]
              n[i] = it
              return n
            }),
        })
        await api.sessionEnd(s.id)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
      void qc.invalidateQueries()
    }
  }

  // files chosen in Google Drive: fetched one by one (Google Docs as PDF), then the same way as any file
  const fromDrive = async () => {
    if (busyRef.current) return
    let picked: Picked[]
    try {
      picked = await pickFromDrive(() => new Promise<Picked[]>((resolve) => setFakePick(() => resolve)))
    } catch (e) {
      toast.error((e as Error).message)
      return
    }
    if (!picked.length || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setItems([])
    let got: { files: File[]; skipped: Skipped[] } = { files: [], skipped: [] }
    try {
      got = await fetchPicked(drive, picked, { onStep: (done, total, name) => setFetching({ done, total, name }) })
    } finally {
      setFetching(null)
      busyRef.current = false
      setBusy(false)
    }
    const left: IngestItem[] = got.skipped.map((s, i) => ({ key: `drive:${i}:${s.id}`, name: s.name, status: 'failed', detail: s.why }))
    // (a batch of the kind «import»; each document remembers it came from Drive)
    await run(got.files, 'import', left, 'drive').catch((e: Error) => toast.error(e.message))
  }

  // files shared from another app (WhatsApp, gallery…) arrive through the service worker
  useEffect(() => {
    if (sp.get('shared') !== '1') return
    void idb.get<File[]>('kv', 'shared_files').then(async (shared) => {
      if (shared?.length) {
        await idb.del('kv', 'shared_files')
        void run(shared, 'share')
      }
    })
  }, [])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    if (busyRef.current) return
    const out: File[] = []
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
        Object.defineProperty(f, 'khPath', { value: prefix + f.name })
        out.push(f)
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader()
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
          if (!batch.length) break
          for (const b of batch) await walk(b, `${prefix}${entry.name}/`)
        }
      }
    }
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[]
    if (entries.length) for (const en of entries) await walk(en, '')
    else out.push(...e.dataTransfer.files)
    void run(out, entries.some((x) => x.isDirectory) ? 'folder' : 'upload')
  }

  const done = items.filter((i) => i.status === 'done')
  const dups = items.filter((i) => i.status === 'duplicate')
  const failed = items.filter((i) => i.status === 'failed')
  const finished = !busy && items.length > 0

  return (
    <div>
      <PageHeader title="أضف وثائق" icon={Upload} subtitle="ارمِ كل شيء هنا. خزانة تقرأ وتصنف وتمنع التكرار وحدها." />

      <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
        <MapPin className="size-5 text-brand-600" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium text-ink">أين أوراق هذه الدفعة الأصلية؟</div>
          <div className="text-muted">{loc ? `${loc.name}${loc.place ? ` — ${loc.place}` : ''}` : 'اختياري: صندوق أو ملف تحفظ فيه الورق الأصلي'}</div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
          {loc ? 'تغيير' : 'اختر مكاناً'}
        </Button>
      </Card>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cn(
          'relative flex flex-col items-center justify-center rounded-[28px] border-2 border-dashed px-6 py-14 text-center transition',
          drag ? 'border-brand-500 bg-brand-50' : 'border-line-2 bg-surface',
        )}
      >
        <div className="kh-arch mb-5 grid h-20 w-16 place-items-end bg-brand-700 pb-3 text-white shadow-card">
          <FileUp className="mx-auto size-7" />
        </div>
        <h2 className="text-lg font-semibold text-ink">اسحب الملفات أو المجلدات إلى هنا</h2>
        <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-muted">PDF، صور، مسح ضوئي، Word، نصوص، أو ملف ZIP كامل — حتى مجلدات حاسوبك القديمة كما هي.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button icon={FileUp} onClick={() => filesRef.current?.click()} disabled={busy}>
            اختر ملفات
          </Button>
          <Button variant="secondary" icon={FolderUp} onClick={() => folderRef.current?.click()} disabled={busy}>
            اختر مجلداً
          </Button>
          {canDrive && (
            <Button
              variant="secondary"
              icon={CloudDownload}
              onClick={() => void fromDrive()}
              onPointerEnter={prepareDrive}
              onFocus={prepareDrive}
              onTouchStart={prepareDrive}
              disabled={busy}
              title="اختر ملفات من Google Drive — يبقى الأصل في مكانه"
            >
              من Google Drive
            </Button>
          )}
          <Button variant="secondary" icon={Camera} className="sm:hidden" onClick={() => photoRef.current?.click()} disabled={busy}>
            صورة سريعة
          </Button>
          <LinkButton to={`/scan${locationId ? `?location=${locationId}` : ''}`} variant="outline" icon={Camera} className="hidden sm:inline-flex">
            الماسح الذكي
          </LinkButton>
        </div>
        <input ref={filesRef} type="file" multiple hidden onChange={(e) => run([...(e.target.files ?? [])], 'upload')} />
        <input ref={folderRef} type="file" multiple hidden {...({ webkitdirectory: '', directory: '' } as object)} onChange={(e) => run([...(e.target.files ?? [])], 'folder')} />
        <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => run([...(e.target.files ?? [])], 'upload')} />
        {fetching && (
          <div className="mt-5 w-full max-w-md text-start">
            <div className="flex items-center gap-2 text-sm text-ink">
              <Loader2 className="size-4 shrink-0 animate-spin text-brand-600" />
              <span className="min-w-0 truncate" dir="auto">
                يُجلب من Google Drive: {Math.min(fetching.done + 1, fetching.total)} من {fetching.total}
                {fetching.name ? ` — ${fetching.name}` : ''}
              </span>
            </div>
            <Progress value={fetching.total ? fetching.done / fetching.total : 0} className="mt-2" />
          </div>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-4 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-4 text-success" /> فحص التكرار قبل الرفع
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="size-4 text-brass-500" /> {ai === 'claude' ? 'يقرؤها Claude Opus 5.5' : 'تصنيف تقريبي حتى تربط Claude'}
          </span>
          {canDrive && (
            <span className="inline-flex items-center gap-1.5">
              <CloudDownload className="size-4 text-brand-600" /> من Drive: يبقى الأصل في مكانه
            </span>
          )}
        </div>
      </div>

      {items.length > 0 && (
        <Card className="mt-6 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5">
            <h3 className="flex-1 text-sm font-semibold text-ink">{busy ? 'جارٍ الإضافة…' : 'انتهت الإضافة'}</h3>
            <Badge tone="success" icon={CheckCircle2}>
              {done.length} أضيفت
            </Badge>
            {dups.length > 0 && (
              <Badge tone="brass" icon={CopyX}>
                {dups.length} موجودة سابقاً
              </Badge>
            )}
            {failed.length > 0 && (
              <Badge tone="danger" icon={XCircle}>
                {failed.length} تعذّرت
              </Badge>
            )}
          </div>
          <ul className="max-h-[55vh] divide-y divide-line overflow-y-auto">
            {items.map((it) => (
              <li key={it.key} className="flex items-start gap-3 px-5 py-3 text-sm">
                <span className="mt-0.5">
                  {it.status === 'done' ? (
                    <CheckCircle2 className="size-4 text-success" />
                  ) : it.status === 'duplicate' ? (
                    <CopyX className="size-4 text-brass-500" />
                  ) : it.status === 'failed' ? (
                    <XCircle className="size-4 text-danger" />
                  ) : it.status === 'waiting' ? (
                    <span className="block size-4 rounded-full border-2 border-line-2" />
                  ) : (
                    <Loader2 className="size-4 animate-spin text-brand-600" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div dir="auto" className="truncate text-ink">
                    {it.docId ? <Link to={`/doc/${it.docId}`} className="hover:text-brand-600">{it.name}</Link> : it.name}
                  </div>
                  {it.status === 'duplicate' && it.existing ? (
                    <div className="mt-0.5 text-xs text-muted">
                      {it.detail ?? 'موجودة في خزانتك'}
                      {it.existing.path ? ` في «${it.existing.path}»` : ''} منذ {relTime(it.existing.created_at)} —{' '}
                      <Link to={`/doc/${it.existing.document_id}`} className="text-brand-600 hover:underline">
                        افتحها
                      </Link>
                      {it.existing.deleted ? ' (في سلة المحذوفات)' : ''}
                    </div>
                  ) : it.detail ? (
                    <div className={cn('mt-0.5 text-xs', it.status === 'failed' ? 'text-danger' : 'text-muted')}>{it.detail}</div>
                  ) : null}
                  {it.status === 'preparing' && <Progress value={it.ratio ?? 0.1} className="mt-1.5" />}
                </div>
              </li>
            ))}
          </ul>
          {finished && done.length > 0 && (
            <div className="border-t border-line bg-surface-2 px-5 py-3.5 text-sm text-muted">
              {ai === 'claude' ? 'تُقرأ الوثائق الآن وتُصنف في الخلفية — يمكنك متابعة عملك.' : 'صُنفت تقريبياً. اربط Claude ليقرأ الممسوح منها ويفهمها بدقة.'}{' '}
              <Link to="/search?sort=newest" className="font-medium text-brand-600 hover:underline">
                عرض ما أضيف
              </Link>
            </div>
          )}
        </Card>
      )}

      <LocationPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(id) => {
          setLocationId(id)
          setPicking(false)
        }}
      />
      {fakePick && (
        <FakeDrivePicker
          onDone={(p) => {
            fakePick(p)
            setFakePick(null)
          }}
        />
      )}
    </div>
  )
}
