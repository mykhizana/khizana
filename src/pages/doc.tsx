import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  CalendarClock,
  Check,
  Download,
  Eye,
  FileWarning,
  EyeOff,
  FolderCheck,
  FolderInput,
  Heart,
  HelpCircle,
  Link2,
  Lock,
  MapPin,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  ScanText,
  Share2,
  Tag,
  Trash2,
  Unlink,
  WifiOff,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { isSonnet, modelName } from '@/ai/models'
import { api } from '@/db/api'
import { files } from '@/db/files'
import { MODE } from '@/lib/config'
import { daysUntil, docTitle, docsAr, fmtDate, fmtShortDate, fmtSize } from '@/lib/format'
import { DOC_TYPES, ID_LABELS, METHOD_LABEL, RELATION_LABEL, SENSITIVITY_LABEL, langLabel, roleLabel, typeIcon, typeLabel } from '@/lib/labels'
import { useDoc } from '@/lib/queries'
import type { Doc } from '@/lib/types'
import { queue } from '@/pipeline/queue'
import { CatPath, StateBadge, stateReason } from '@/ui/bits'
import { downloadDoc } from '@/ui/download'
import { Badge, Button, Card, Dialog, Field, IconButton, Input, Menu, MenuItem, Select, Skeleton, Textarea, cn } from '@/ui/kit'
import { CategoryPicker, LocationPicker } from '@/ui/pickers'
import { AddToDossier, ShareDocDialog } from '@/ui/share'
import { Viewer } from '@/ui/viewer'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line/70 py-2.5 text-sm last:border-0">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 text-end text-ink">{children}</span>
    </div>
  )
}

function Masked({ value, hidden }: { value: string; hidden: boolean }) {
  const [show, setShow] = useState(!hidden)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="latin" dir="ltr">
        {show ? value : '•••• ' + value.slice(-3)}
      </span>
      {hidden && (
        <button onClick={() => setShow((s) => !s)} className="text-subtle hover:text-ink" aria-label={show ? 'إخفاء' : 'إظهار'}>
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      )}
    </span>
  )
}

function EditDialog({ doc, open, onClose }: { doc: Doc; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    title_ar: doc.title_ar ?? '',
    title: doc.title ?? '',
    summary_ar: doc.summary_ar ?? '',
    doc_type: doc.doc_type ?? 'other',
    doc_date: doc.doc_date ?? '',
    academic_year: doc.academic_year ?? '',
    expiry_date: doc.expiry_date ?? '',
    sensitivity: doc.sensitivity,
  })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const fields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(f)) if ((doc as unknown as Record<string, unknown>)[k] !== v && !((doc as unknown as Record<string, unknown>)[k] == null && v === '')) fields[k] = v
      const r = Object.keys(fields).length ? await api.updateDoc(doc.id, fields) : null
      await qc.invalidateQueries()
      toast.success(r?.sealed ? 'نُقلت إلى الخزنة — تظهر بعد رمز التحقق الثنائي' : 'حُفظ — لن يغيّر الذكاء الاصطناعي ما صحّحته')
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="تعديل البطاقة"
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={save} loading={saving}>
            حفظ
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="العنوان بالعربية" className="sm:col-span-2">
          <Input value={f.title_ar} onChange={(e) => setF({ ...f, title_ar: e.target.value })} />
        </Field>
        <Field label="العنوان الأصلي" className="sm:col-span-2">
          <Input dir="auto" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="الملخص" className="sm:col-span-2">
          <Textarea rows={3} value={f.summary_ar} onChange={(e) => setF({ ...f, summary_ar: e.target.value })} />
        </Field>
        <Field label="النوع">
          <Select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })}>
            {DOC_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.ar}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="الحساسية" hint="الخزنة: الهوية، الجواز، الطبي، البنك">
          <Select value={f.sensitivity} onChange={(e) => setF({ ...f, sensitivity: e.target.value as Doc['sensitivity'] })}>
            {Object.entries(SENSITIVITY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="تاريخ الوثيقة">
          <Input type="date" value={f.doc_date} onChange={(e) => setF({ ...f, doc_date: e.target.value })} />
        </Field>
        <Field label="السنة الجامعية" hint="مثال: 2018/2019">
          <Input value={f.academic_year} onChange={(e) => setF({ ...f, academic_year: e.target.value })} />
        </Field>
        <Field label="تاريخ انتهاء الصلاحية" hint="يدخل رادار الآجال">
          <Input type="date" value={f.expiry_date} onChange={(e) => setF({ ...f, expiry_date: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  )
}

export default function DocPage() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data: doc, isLoading } = useDoc(id)
  const [edit, setEdit] = useState(false)
  const [moving, setMoving] = useState(false)
  const [locating, setLocating] = useState(false)
  const [dossier, setDossier] = useState(false)
  const [sharing, setSharing] = useState(false)
  const page = sp.get('page') ? Number(sp.get('page')) : null
  const hl = sp.get('hl') ?? ''

  if (isLoading)
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Skeleton className="h-[70vh] lg:col-span-3" />
        <Skeleton className="h-96 lg:col-span-2" />
      </div>
    )
  if (!doc)
    return (
      <Card className="p-10 text-center">
        <Lock className="mx-auto size-8 text-brass-500" />
        <p className="mt-3 text-sm text-muted">هذه الوثيقة غير موجودة أو في الخزنة المقفلة.</p>
      </Card>
    )

  const refresh = () => qc.invalidateQueries()
  const Icon = typeIcon(doc.doc_type)
  const people = doc.entities.filter((e) => e.kind === 'person')
  const orgs = doc.entities.filter((e) => e.kind !== 'person')
  const orig = doc.files.find((f) => f.role === 'original')
  const hide = doc.sensitivity !== 'normal'
  const flags = [
    doc.status?.is_copy && 'نسخة',
    doc.status?.certified_copy && 'نسخة مصادق عليها',
    doc.status?.apostille && 'أبوستيل',
    doc.status?.sworn_translation && `ترجمة محلفة${doc.status.translated_from ? ` عن ${langLabel(doc.status.translated_from)}` : ''}`,
  ].filter(Boolean) as string[]

  const del = async () => {
    await api.deleteDocs([doc.id])
    await refresh()
    toast('نُقلت إلى سلة المحذوفات', {
      action: {
        label: 'تراجع',
        onClick: async () => {
          await api.restoreDoc(doc.id)
          await refresh()
        },
      },
    })
    nav(-1)
  }

  const toggle = async (field: 'favorite' | 'pinned_offline') => {
    const v = !doc[field]
    await api.updateDoc(doc.id, { [field]: v }, false)
    if (field === 'pinned_offline') {
      await files.keepOffline(
        doc.files.map((f) => f.path),
        v,
      )
      toast.success(v ? 'ستبقى متاحة على هذا الجهاز بدون إنترنت' : 'أزيلت النسخة المحلية')
    }
    await refresh()
  }

  return (
    <div>
      <button onClick={() => nav(-1)} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowRight className="size-4" /> رجوع
      </button>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-600">
            <Icon className="size-6" />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-[26px] leading-snug text-ink">{docTitle(doc)}</h1>
            {doc.title && doc.title !== doc.title_ar && (
              <p dir="auto" className="mt-0.5 text-sm text-muted">
                {doc.title}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone="brand">{typeLabel(doc.doc_type)}</Badge>
              {doc.sensitivity === 'vault' && (
                <Badge tone="brass" icon={Lock}>
                  في الخزنة
                </Badge>
              )}
              {flags.map((f) => (
                <Badge key={f} tone="info" icon={BadgeCheck}>
                  {f}
                </Badge>
              ))}
              <StateBadge state={doc.state} detail={doc.state_detail} />
              {doc.deleted_at && <Badge tone="danger">في سلة المحذوفات</Badge>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button icon={Download} onClick={() => downloadDoc(doc)}>
            تحميل
          </Button>
          <IconButton icon={Heart} label="مفضلة" className={cn(doc.favorite && 'text-brass-500 [&>svg]:fill-brass-500')} onClick={() => toggle('favorite')} />
          <Menu trigger={(t) => <IconButton icon={MoreHorizontal} label="المزيد" onClick={t} />}>
            {(close) => (
              <>
                <MenuItem icon={Pencil} onClick={() => (close(), setEdit(true))}>
                  تعديل البطاقة
                </MenuItem>
                <MenuItem icon={FolderInput} onClick={() => (close(), setMoving(true))}>
                  نقل إلى رف
                </MenuItem>
                <MenuItem icon={MapPin} onClick={() => (close(), setLocating(true))}>
                  مكان الورقة الأصلية
                </MenuItem>
                {!doc.deleted_at && (
                  <>
                    <MenuItem icon={FolderCheck} onClick={() => (close(), setDossier(true))}>
                      أضف إلى ملف جاهز
                    </MenuItem>
                    <MenuItem icon={Share2} onClick={() => (close(), setSharing(true))}>
                      شارك (PDF أو رابط)
                    </MenuItem>
                  </>
                )}
                <MenuItem
                  icon={RefreshCw}
                  onClick={async () => {
                    close()
                    await queue.retry([doc.id], { opus: true })
                    toast.success('ستُفهم من جديد بـ Claude Opus 5.5 (تصحيحاتك محفوظة)')
                    await refresh()
                  }}
                >
                  أعد القراءة والفهم
                </MenuItem>
                {isSonnet(doc.ai_model) && doc.pages.some((p) => p.text_source === 'ocr') && (
                  <MenuItem
                    icon={ScanText}
                    onClick={async () => {
                      close()
                      await queue.rereadWithOpus(doc)
                      toast.success('ستُقرأ صفحاتها من جديد بـ Claude Opus 5.5، ويبقى نصها الحالي حتى يُستبدل')
                      await refresh()
                    }}
                  >
                    اقرأ الصفحات من جديد بـ Opus 5.5
                  </MenuItem>
                )}
                {MODE === 'cloud' && (
                  <MenuItem icon={WifiOff} onClick={() => (close(), toggle('pinned_offline'))}>
                    {doc.pinned_offline ? 'إلغاء الإتاحة بدون إنترنت' : 'متاحة بدون إنترنت'}
                  </MenuItem>
                )}
                {doc.deleted_at ? (
                  <MenuItem
                    icon={RotateCcw}
                    onClick={async () => {
                      close()
                      await api.restoreDoc(doc.id)
                      await refresh()
                    }}
                  >
                    استرجاع من السلة
                  </MenuItem>
                ) : (
                  <MenuItem icon={Trash2} danger onClick={() => (close(), del())}>
                    حذف
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        </div>
      </div>

      {doc.proposal && <ProposalBanner doc={doc} />}
      {!doc.deleted_at && stateReason(doc.state, doc.state_detail) && (
        <Card className={cn('mb-4 flex flex-wrap items-center gap-3 p-4', doc.state === 'error' ? 'border-danger/30 bg-danger-bg' : 'border-warning/30 bg-warning-bg')}>
          <FileWarning className={cn('size-5 shrink-0', doc.state === 'error' ? 'text-danger' : 'text-warning')} />
          <span dir="auto" className={cn('min-w-0 flex-1 text-sm leading-relaxed', doc.state === 'error' ? 'text-danger' : 'text-warning')}>
            {doc.state === 'error' ? 'لم تكتمل معالجتها بعد ثلاث محاولات: ' : 'تنتظر: '}
            {stateReason(doc.state, doc.state_detail)}
          </span>
          {doc.state === 'error' && (
            <Button
              size="sm"
              variant="secondary"
              icon={RefreshCw}
              onClick={async () => {
                await queue.retry([doc.id], { opus: true })
                toast.success('ستُعاد معالجتها بـ Claude Opus 5.5')
                await refresh()
              }}
            >
              أعد المحاولة
            </Button>
          )}
        </Card>
      )}
      {doc.reviews.length > 0 && (
        <Card className="mb-4 flex flex-wrap items-center gap-3 border-brass-200 bg-brass-100/50 p-4">
          <HelpCircle className="size-5 text-brass-600" />
          <span className="flex-1 text-sm text-text">
            {doc.reviews.length === 1 ? 'سؤال واحد' : `${doc.reviews.length} أسئلة`} حول هذه الوثيقة ينتظر قرارك ({doc.reviews.map((r) => ({ duplicate: 'تكرار محتمل', person_match: 'شخص', person_new: 'أشخاص جدد', low_confidence: 'تصنيف غير مؤكد' } as Record<string, string>)[r.kind] ?? r.kind).join('، ')}).
          </span>
          <Link to="/review" className="text-sm font-medium text-brand-600 hover:underline">
            راجع
          </Link>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Viewer doc={doc} page={page} hl={hl} />
        </div>

        <div className="space-y-4 lg:col-span-2">
          {doc.summary_ar && (
            <Card className="p-5">
              <h3 className="mb-2 text-sm font-semibold text-ink">الملخص</h3>
              <p className="text-[14px] leading-7 text-text">{doc.summary_ar}</p>
            </Card>
          )}

          <Card className="p-5">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">البطاقة</h3>
              <button onClick={() => setEdit(true)} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
                <Pencil className="size-3.5" /> تعديل
              </button>
            </div>
            <Row label="الرف">
              <button onClick={() => setMoving(true)} className="text-end hover:text-brand-600">
                <CatPath path={doc.category_path} link={false} />
              </button>
            </Row>
            {(doc.doc_date || doc.academic_year) && (
              <Row label="التاريخ">
                <span className="num">
                  {doc.doc_date ? fmtDate(doc.doc_date, doc.date_precision) : ''}
                  {doc.academic_year ? `${doc.doc_date ? ' · ' : ''}${doc.academic_year}` : ''}
                </span>
              </Row>
            )}
            {doc.expiry_date && (
              <Row label="تنتهي صلاحيتها">
                <span className="num">{fmtDate(doc.expiry_date)}</span>{' '}
                {(() => {
                  const n = daysUntil(doc.expiry_date!)
                  return <Badge tone={n < 0 ? 'danger' : n < 60 ? 'warning' : 'neutral'}>{n < 0 ? 'منتهية' : `بعد ${n} يوم`}</Badge>
                })()}
              </Row>
            )}
            {doc.languages.length > 0 && <Row label="اللغة">{doc.languages.map(langLabel).join('، ')}</Row>}
            <Row label="الصفحات">
              <span className="num">{doc.page_count}</span>
            </Row>
            <Row label="الحساسية">{SENSITIVITY_LABEL[doc.sensitivity]}</Row>
            <Row label="الورقة الأصلية">
              <button onClick={() => setLocating(true)} className="inline-flex items-center gap-1 hover:text-brand-600">
                <MapPin className="size-3.5" />
                {doc.location ? `${doc.location.name}${doc.location.place ? ` — ${doc.location.place}` : ''}` : 'غير محدد'}
              </button>
            </Row>
            {doc.identifiers.map((x, i) => (
              <Row key={i} label={ID_LABELS[x.kind] ?? 'رقم'}>
                <Masked value={x.value} hidden={hide && !['law_no', 'decree_no', 'isbn'].includes(x.kind)} />
              </Row>
            ))}
          </Card>

          {(people.length > 0 || orgs.length > 0) && (
            <Card className="p-5">
              <h3 className="mb-3 text-sm font-semibold text-ink">الأشخاص والجهات</h3>
              <div className="flex flex-wrap gap-2">
                {people.map((p) => (
                  <Link key={p.id + p.role} to={`/people/${p.id}`} className="rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-sm hover:border-brand-500">
                    <span className="font-medium text-ink">
                      {p.honorific ? `${p.honorific} ` : ''}
                      {p.name}
                    </span>
                    {p.role !== 'mentioned' && <span className="ms-1.5 text-xs text-muted">{roleLabel(p.role)}</span>}
                  </Link>
                ))}
                {orgs.map((p) => (
                  <Link key={p.id + p.role} to={`/people/${p.id}`} className="rounded-xl border border-line px-3 py-1.5 text-sm text-text hover:border-brand-500">
                    {p.kind === 'place' ? <MapPin className="me-1 inline size-3.5 text-muted" /> : null}
                    {p.name}
                  </Link>
                ))}
              </div>
            </Card>
          )}

          {doc.links.length > 0 && (
            <Card className="p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                <Link2 className="size-4 text-brand-600" /> وثائق مرتبطة
              </h3>
              <ul className="space-y-2.5">
                {doc.links.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <span className="text-muted">
                        {l.relation === 'part' ? (l.direction === 'out' ? 'جزء من' : 'تحتوي') : l.relation === 'translation' ? (l.direction === 'out' ? 'ترجمة لـ' : 'لها ترجمة') : RELATION_LABEL[l.relation]}
                        {' '}
                      </span>
                      <Link to={`/doc/${l.other_id}`} className={cn('font-medium text-ink hover:text-brand-600', l.other_deleted && 'line-through opacity-60')}>
                        {l.other_title}
                      </Link>
                      <div className="text-xs text-subtle">
                        {l.reason ? `${l.reason} · ` : ''}
                        {METHOD_LABEL[l.method ?? ''] ?? l.method}
                        {l.confirmed ? ' · مؤكد' : ''}
                      </div>
                    </div>
                    <IconButton
                      icon={Unlink}
                      label="فك الربط"
                      size="sm"
                      onClick={async () => {
                        await api.linkRemove(l.id)
                        await refresh()
                      }}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {!doc.deleted_at && (
            <Card className="p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                <CalendarClock className="size-4 text-brand-600" /> الآجال
              </h3>
              {doc.deadlines.length === 0 && <p className="text-sm text-muted">لا موعد لهذه الوثيقة.</p>}
              <ul className="space-y-2">
                {doc.deadlines.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className={cn(d.done && 'text-subtle line-through')}>{d.title}</span>
                    <span className="flex items-center gap-2">
                      <span className="num text-xs text-muted">{fmtShortDate(d.due_date)}</span>
                      <IconButton
                        icon={d.done ? X : Check}
                        label={d.done ? 'لم يُنجز' : 'أُنجز'}
                        size="sm"
                        onClick={async () => {
                          await api.deadlineDone(d.id, !d.done)
                          await refresh()
                          if (MODE === 'local') void import('@/drive/reminders').then(({ reminders }) => reminders.soon())
                        }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                to={`/deadlines?doc=${doc.id}&title=${encodeURIComponent(docTitle(doc))}`}
                className="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline dark:text-brand-200"
              >
                أضف موعداً لهذه الوثيقة
              </Link>
            </Card>
          )}

          {(doc.keywords.length > 0 || doc.visual_features) && (
            <Card className="p-5">
              {doc.keywords.length > 0 && (
                <>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                    <Tag className="size-4 text-brand-600" /> كلمات للبحث
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {doc.keywords.slice(0, 24).map((k) => (
                      <Link key={k} to={`/search?q=${encodeURIComponent(k)}`} dir="auto" className="rounded-lg bg-surface-2 px-2 py-0.5 text-xs text-text hover:bg-brand-50 hover:text-brand-700">
                        {k}
                      </Link>
                    ))}
                  </div>
                </>
              )}
              {doc.visual_features && (
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  <span className="font-medium text-text">ما تتذكره العين: </span>
                  {doc.visual_features}
                </p>
              )}
            </Card>
          )}

          <Card className="p-5">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
              <Bot className="size-4 text-brand-600" /> لماذا هذا التصنيف؟
            </h3>
            <p className="text-sm leading-relaxed text-text">{doc.ai_reason || '—'}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              <Badge tone={doc.ai_mode === 'claude' ? 'success' : 'warning'}>{doc.ai_mode === 'claude' ? modelName(doc.ai_model) : 'تصنيف تقريبي'}</Badge>
              {doc.ai_confidence != null && <Badge>ثقة {Math.round(doc.ai_confidence * 100)}%</Badge>}
              {doc.corrected.length > 0 && <Badge tone="brand">صحّحتَ {doc.corrected.length} حقلاً</Badge>}
            </div>
          </Card>

          <Card className="p-5 text-xs text-muted">
            <Row label="الملف">
              <span dir="auto" className="break-all">
                {doc.file_name}
              </span>
            </Row>
            {orig?.size ? <Row label="الحجم">{fmtSize(orig.size)}</Row> : null}
            <Row label="أضيفت">{fmtDate(doc.created_at)}</Row>
            {doc.original_note && <Row label="ملاحظة">{doc.original_note}</Row>}
          </Card>
        </div>
      </div>

      <EditDialog key={doc.updated_at} doc={doc} open={edit} onClose={() => setEdit(false)} />
      <AddToDossier documentId={doc.id} open={dossier} onClose={() => setDossier(false)} />
      <ShareDocDialog documentId={doc.id} title={docTitle(doc)} open={sharing} onClose={() => setSharing(false)} />
      <CategoryPicker
        open={moving}
        onClose={() => setMoving(false)}
        allowNone
        onPick={async (cid) => {
          await api.updateDoc(doc.id, { category_id: cid })
          setMoving(false)
          await refresh()
          toast.success('نُقلت — وسيتذكر التطبيق اختيارك')
        }}
      />
      <LocationPicker
        open={locating}
        onClose={() => setLocating(false)}
        onPick={async (lid) => {
          await api.updateDoc(doc.id, { original_location_id: lid }, false)
          setLocating(false)
          await refresh()
        }}
      />
    </div>
  )
}

function ProposalBanner({ doc }: { doc: Doc }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const p = doc.proposal!
  const act = async (action: 'accept' | 'reject' | 'remap', category_id?: string) => {
    setBusy(true)
    try {
      const r = await api.proposalResolve({ id: p.id, action, category_id })
      await qc.invalidateQueries()
      if (action === 'accept') toast.success(`أُنشئ الرف «${p.name_ar}»${r.moved > 1 ? ` ونُقلت إليه ${docsAr(r.moved)}` : ''}${r.backfill.length ? ` — ووجدتُ ${docsAr(r.backfill.length)} سابقة قد تناسبه (في «تحتاج قرارك»)` : ''}`)
      if (action === 'reject') toast('لن يُقترح هذا الرف مرة أخرى')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="mb-4 border-brass-400/60 bg-brass-100/50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-text">
            اقتراح رف جديد: <span className="font-semibold text-ink">«{p.name_ar}»</span>
            {p.name_fr ? <span className="latin text-muted"> · {p.name_fr}</span> : null}
          </div>
          {p.reason && <div className="mt-0.5 text-xs text-muted">{p.reason}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="brass" loading={busy} onClick={() => act('accept')}>
            أنشئه
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
            ضعها في رف موجود
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act('reject')}>
            لا
          </Button>
        </div>
      </div>
      <CategoryPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={async (cid) => {
          setPicking(false)
          if (cid) await act('remap', cid)
        }}
      />
    </Card>
  )
}
