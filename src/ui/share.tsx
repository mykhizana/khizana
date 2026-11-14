// The pieces the ready dossiers and the document page share: the PDF / link panel, the list of links,
// the document picker, and «أضف إلى ملف جاهز».
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Download, ExternalLink, FilePlus2, FolderCheck, Link2, Link2Off, Plus, QrCode, Search, Share2, Stamp } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { DriveError } from '@/drive/api'
import { auth } from '@/drive/auth'
import { driveSync } from '@/drive/sync'
import { MODE } from '@/lib/config'
import { SHARE_DAYS } from '@/drive/share'
import { daysAr, docTitle, fmtDate, pagesAr, relTime, safeFileName } from '@/lib/format'
import { typeIcon, typeLabel } from '@/lib/labels'
import { shares } from '@/lib/shares'
import type { SearchItem, ShareLink } from '@/lib/types'
import { buildPdf, watermarkFor, type PdfEntry } from '@/pipeline/dossier-pdf'
import { saveBlob } from './download'
import { Badge, Button, Dialog, Field, IconButton, Input, Progress, Select, Spinner, Switch } from './kit'

const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / 864e5)
const DAYS_LABEL: Record<number, string> = { 1: 'يوم واحد', 7: 'أسبوع', 30: 'شهر', 90: 'ثلاثة أشهر' }

/** the Drive error that means «connect Google again» */
const needsGoogle = (e: unknown) => e instanceof DriveError && e.auth

// ------------------------------------------------------------------ links
function Qr({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    void QRCode.toDataURL(url, { margin: 1, width: 260, errorCorrectionLevel: 'M', color: { dark: '#0c2e2b', light: '#ffffff' } }).then(setSrc)
  }, [url])
  return src ? <img src={src} alt="رمز QR للرابط" className="mx-auto size-48 rounded-xl border border-line bg-white p-2" /> : <Spinner className="mx-auto" />
}

export function ShareLinks({ links, onChange, showName }: { links: ShareLink[]; onChange: () => Promise<unknown> | void; showName?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [past, setPast] = useState(false)
  const live = links.filter((l) => !l.revoked && !l.expired)
  const ended = links.filter((l) => l.revoked || l.expired)
  const revoke = async (l: ShareLink) => {
    if (!confirm('أتسحب هذا الرابط؟ لن يفتحه أحد بعد الآن (تُحذف نسخته من Drive).')) return
    setBusy(l.id)
    try {
      if (!(await shares.ready())) await auth.connect()
      await shares.revoke({ id: l.id, drive_file: l.drive_file })
      toast.success('سُحب الرابط: لم يعد يفتح')
      await onChange()
    } catch (e) {
      toast.error(needsGoogle(e) ? 'اتصل بـ Google أولاً (اضغط الزر مرة أخرى)' : (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('نُسخ الرابط')
    } catch {
      prompt('انسخ الرابط:', url)
    }
  }
  if (!links.length) return null
  return (
    <div className="space-y-2">
      {live.map((l) => (
        <div key={l.id} className="rounded-xl border border-success/30 bg-success-bg/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link2 className="size-4 shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">
                {showName && l.name ? `${l.name} · ` : ''}
                {l.label || 'رابط مشاركة'}
              </div>
              <div className="text-xs text-muted">
                يفتح حتى <span className="num">{fmtDate(l.expires_at.slice(0, 10))}</span> ({daysLeft(l.expires_at) <= 1 ? 'آخر يوم' : `بقي ${daysAr(daysLeft(l.expires_at))}`})
                {l.watermark && <> · بعلامة مائية</>}
                {l.vault && <> · فيه وثائق من الخزنة</>}
              </div>
            </div>
            <IconButton icon={Copy} label="انسخ الرابط" size="sm" onClick={() => void copy(l.url)} />
            <IconButton icon={QrCode} label="رمز QR" size="sm" onClick={() => setQr(qr === l.id ? null : l.id)} />
            <a href={l.url} target="_blank" rel="noreferrer" className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" title="افتح">
              <ExternalLink className="size-4" />
            </a>
            <Button size="sm" variant="secondary" icon={Link2Off} loading={busy === l.id} onClick={() => void revoke(l)}>
              اسحب
            </Button>
          </div>
          {qr === l.id && (
            <div className="mt-3 text-center">
              <Qr url={l.url} />
              <p className="mt-2 text-xs text-muted">يصوّره الموظف بهاتفه فيفتح الملف.</p>
            </div>
          )}
        </div>
      ))}
      {ended.length > 0 && (
        <div>
          <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => setPast((x) => !x)}>
            {past ? 'أخفِ الروابط المنتهية' : `روابط انتهت أو سُحبت (${ended.length})`}
          </button>
          {past && (
            <ul className="mt-2 space-y-1">
              {ended.map((l) => (
                <li key={l.id} className="flex items-center gap-2 text-xs text-muted">
                  <Link2Off className="size-3.5" />
                  <span className="truncate">
                    {showName && l.name ? `${l.name} · ` : ''}
                    {l.label || 'رابط مشاركة'} · {l.revoked ? 'سُحب' : 'انتهى'} · {relTime(l.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ PDF and link
type Target = { collection_id?: string; document_id?: string }

export function SharePanel({
  entries,
  title,
  subtitle,
  target,
  cover = true,
  blocked,
  pages,
  onShared,
}: {
  entries: PdfEntry[]
  title: string
  subtitle?: string | null
  target: Target
  /** a dossier has a cover sheet; a single document does not need one */
  cover?: boolean
  /** why it cannot be made now (the vault is closed…) */
  blocked?: string | null
  /** the number of pages (a very big file is confirmed first) */
  pages?: number
  onShared?: () => Promise<unknown> | void
}) {
  const [withCover, setWithCover] = useState(cover)
  const [marked, setMarked] = useState(false)
  const [to, setTo] = useState('')
  const [days, setDays] = useState<number>(7)
  const [busy, setBusy] = useState<null | 'pdf' | 'phone' | 'link'>(null)
  const [progress, setProgress] = useState<{ text: string; ratio: number } | null>(null)
  const [made, setMade] = useState<string | null>(null)
  const watermark = marked ? watermarkFor(to.trim() || '…') : null
  const canPhone = typeof navigator !== 'undefined' && !!navigator.canShare

  const build = () =>
    buildPdf(entries, {
      title,
      subtitle,
      watermark: marked && to.trim() ? watermark : null,
      cover: withCover,
      onProgress: (text, ratio) => setProgress({ text, ratio }),
    })

  const run = async (kind: 'pdf' | 'phone' | 'link') => {
    if (marked && !to.trim()) return toast.error('اكتب لمن تُقدَّم هذه النسخة (يظهر في العلامة المائية)')
    if (!entries.length) return toast.error('لا وثيقة في الملف بعد')
    if (pages && pages > 150 && !confirm(`سيكون الملف ${pagesAr(pages)}: يأخذ تجهيزه بعض الوقت ويكبر حجمه. أتتابع؟`)) return
    // Google's window must open from the click itself, before the long work: a link needs Google, and
    // on a device in the archive a page kept only in Drive must be brought (otherwise the PDF would miss it)
    if (!(await shares.ready()) && (kind === 'link' || (MODE === 'local' && driveSync.getSnapshot().linked))) {
      try {
        await auth.connect()
      } catch (e) {
        if (kind === 'link') return toast.error((e as Error).message)
      }
    }
    setBusy(kind)
    setMade(null)
    try {
      const pdf = await build()
      const name = safeFileName(title)
      if (pdf.missing.length) toast.warning(`لم توضع في الملف: ${pdf.missing.join('، ')}`)
      if (kind === 'pdf') {
        saveBlob(pdf.blob, `${name}.pdf`)
        toast.success(`جاهز: ${pagesAr(pdf.pages)}`)
      } else if (kind === 'phone') {
        const file = new File([pdf.blob], `${name}.pdf`, { type: 'application/pdf' })
        if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title })
        else saveBlob(pdf.blob, `${name}.pdf`)
      } else {
        setProgress({ text: 'رفع الملف إلى Google Drive', ratio: 1 })
        const r = await shares.publish({ pdf: pdf.blob, name, days, ...target, documents: entries.map((x) => x.id), label: to.trim() || null, watermark: marked ? watermark : null })
        setMade(r.url)
        try {
          await navigator.clipboard.writeText(r.url)
          toast.success('الرابط جاهز ونُسخ: ألصقه في رسالتك')
        } catch {
          toast.success('الرابط جاهز')
        }
        await onShared?.()
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      toast.error(needsGoogle(e) ? 'انتهت ساعة Google: اضغط الزر مرة أخرى' : (e as Error).message)
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  if (blocked) return <p className="rounded-xl bg-warning-bg px-3 py-2 text-sm text-warning">{blocked}</p>
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {cover && <Switch checked={withCover} onChange={setWithCover} label="صفحة غلاف بفهرس الوثائق وأرقام صفحاتها" />}
        <Switch checked={marked} onChange={setMarked} label="علامة مائية على كل صفحة (لمن تُقدَّم النسخة وتاريخها)" />
        {marked && (
          <Field label="مقدَّمة إلى" hint={to.trim() ? <span dir="auto">ستظهر: «{watermark}»</span> : 'مثلاً: Extranjería Madrid، القنصلية، الوكالة العقارية'}>
            <Input value={to} onChange={(e) => setTo(e.target.value)} dir="auto" placeholder="الجهة التي ستتسلّم الملف" />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button icon={Download} loading={busy === 'pdf'} disabled={!!busy} onClick={() => void run('pdf')}>
          حمّل PDF
        </Button>
        {canPhone && (
          <Button variant="secondary" icon={Share2} loading={busy === 'phone'} disabled={!!busy} onClick={() => void run('phone')}>
            أرسله من الهاتف
          </Button>
        )}
      </div>
      {MODE === 'local' && (
        <div className="rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="رابط مشاركة يفتح لمدة" className="w-40">
              <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
                {SHARE_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {DAYS_LABEL[d]}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="outline" icon={Link2} loading={busy === 'link'} disabled={!!busy} onClick={() => void run('link')}>
              أنشئ رابطاً
            </Button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            يوضع الملف في Google Drive داخل مجلد «خزانة — ملفات مشتركة»، ويفتحه من معه الرابط فقط (لا يظهر في أي بحث). حين تسحبه تُحذف النسخة فيتوقف في الحال. وعند انتهاء مدته تحذفها خزانة إن كانت مفتوحة على أحد أجهزتك، وإلا فعند أول فتح لها بعد ذلك: Google Drive لا يوقف الرابط وحده.
          </p>
        </div>
      )}
      {progress && (
        <div>
          <Progress value={progress.ratio} />
          <p className="mt-1 truncate text-xs text-muted">{progress.text}</p>
        </div>
      )}
      {made && (
        <div className="rounded-xl bg-success-bg/60 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-success">
            <Check className="size-4" /> الرابط جاهز
          </div>
          <a href={made} target="_blank" rel="noreferrer" className="mt-1 block truncate text-xs text-brand-700 underline dark:text-brand-200" dir="ltr">
            {made}
          </a>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ picking documents
export function DocPicker({ open, onClose, onPick, exclude = [], title = 'أضف وثيقة' }: { open: boolean; onClose: () => void; onPick: (d: SearchItem) => Promise<void> | void; exclude?: string[]; title?: string }) {
  const [q, setQ] = useState('')
  const [deb, setDeb] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setDeb(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const res = useQuery({ queryKey: ['pick', deb], queryFn: () => api.search({ q: deb || undefined, limit: 30 }), enabled: open })
  const items = (res.data?.items ?? []).filter((d) => !d.deleted_at)
  return (
    <Dialog open={open} onClose={onClose} title={title} wide>
      <div className="relative">
        <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث: جواز، شهادة السكنى، contrat…" className="ps-9" dir="auto" />
      </div>
      <ul className="mt-3 max-h-[55dvh] space-y-1.5 overflow-y-auto">
        {res.isLoading && <Spinner className="mx-auto my-6" />}
        {!res.isLoading && !items.length && <li className="py-6 text-center text-sm text-muted">لا نتيجة</li>}
        {items.map((d) => {
          const Icon = typeIcon(d.doc_type)
          const inside = exclude.includes(d.id)
          return (
            <li key={d.id} className="flex items-center gap-3 rounded-xl border border-line p-2.5">
              <Icon className="size-4 shrink-0 text-brand-600" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">{docTitle(d)}</div>
                <div className="truncate text-xs text-muted">
                  {typeLabel(d.doc_type)}
                  {d.doc_date ? ` · ${fmtDate(d.doc_date, d.date_precision)}` : ''}
                  {d.expiry_date ? ` · صالحة حتى ${fmtDate(d.expiry_date)}` : ''}
                </div>
              </div>
              {inside ? (
                <Badge tone="success" icon={Check}>
                  في الملف
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Plus}
                  loading={adding === d.id}
                  onClick={async () => {
                    setAdding(d.id)
                    try {
                      await onPick(d)
                    } finally {
                      setAdding(null)
                    }
                  }}
                >
                  اختر
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </Dialog>
  )
}

// ------------------------------------------------------------------ on a document page
export function AddToDossier({ documentId, open, onClose }: { documentId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['dossiers', documentId], queryFn: () => api.dossiers(documentId), enabled: open })
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const changed = () => Promise.all([qc.invalidateQueries({ queryKey: ['dossiers'] }), qc.invalidateQueries({ queryKey: ['dossier'] })])
  const toggle = async (id: string, has: boolean) => {
    setBusy(id)
    try {
      if (has) await api.dossierRemove(id, documentId)
      else await api.dossierAdd(id, documentId)
      await changed()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const create = async () => {
    if (!name.trim()) return
    setBusy('new')
    try {
      const r = await api.dossierSave({ name: name.trim() })
      await api.dossierAdd(r.id, documentId)
      setName('')
      toast.success('أُنشئ الملف وأُضيفت إليه الوثيقة')
      await changed()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="أضف إلى ملف جاهز">
      <ul className="space-y-1.5">
        {(list.data ?? []).map((d) => (
          <li key={d.id} className="flex items-center gap-3 rounded-xl border border-line p-2.5">
            <FolderCheck className="size-4 shrink-0 text-brand-600" />
            <Link to={`/dossiers/${d.id}`} className="min-w-0 flex-1 truncate text-sm text-ink hover:underline" onClick={onClose}>
              {d.name}
            </Link>
            <Button size="sm" variant={d.has ? 'secondary' : 'outline'} icon={d.has ? Check : Plus} loading={busy === d.id} onClick={() => void toggle(d.id, !!d.has)}>
              {d.has ? 'فيه' : 'أضف'}
            </Button>
          </li>
        ))}
        {list.data && !list.data.length && <li className="py-2 text-sm text-muted">لا ملف جاهزاً بعد: أنشئ أول ملف.</li>}
      </ul>
      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <Field label="ملف جديد" className="flex-1">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: تجديد بطاقة الإقامة 2027" dir="auto" />
        </Field>
        <Button type="submit" icon={FilePlus2} loading={busy === 'new'}>
          أنشئ
        </Button>
      </form>
    </Dialog>
  )
}

export function ShareDocDialog({ documentId, title, pages, open, onClose }: { documentId: string; title: string; pages?: number; open: boolean; onClose: () => void }) {
  const links = useQuery({ queryKey: ['shares', 'doc', documentId], queryFn: () => api.shares({ document_id: documentId }), enabled: open })
  return (
    <Dialog open={open} onClose={onClose} title="شارك هذه الوثيقة">
      <div className="space-y-4">
        <p className="flex items-start gap-2 text-sm leading-relaxed text-muted">
          <Stamp className="mt-0.5 size-4 shrink-0 text-brand-600" />
          نسخة PDF من صفحاتها، بعلامة مائية إن شئت، تُحمَّل أو تُرسل من الهاتف أو بِرابط يُسحب متى شئت.
        </p>
        <SharePanel entries={[{ id: documentId }]} title={title} target={{ document_id: documentId }} cover={false} pages={pages} onShared={() => links.refetch()} />
        {!!links.data?.length && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">روابط هذه الوثيقة</h3>
            <ShareLinks links={links.data} onChange={() => links.refetch()} />
          </div>
        )}
      </div>
    </Dialog>
  )
}

export const useOpenLinks = () => useQuery({ queryKey: ['shares', 'open'], queryFn: () => api.shares({ open: true }) })
