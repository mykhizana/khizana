// One ready dossier: Claude's checklist of the procedure (found / expired / unsure / missing), the
// documents in the order they will be handed over, and the PDF / share link.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  CircleHelp,
  ClipboardList,
  FileText,
  FolderCheck,
  Link2,
  ListChecks,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { planDossier } from '@/ai/dossier'
import { api } from '@/db/api'
import { fmtUsd } from '@/lib/cost'
import { daysUntil, docsAr, fmtDate, pagesAr, relTime } from '@/lib/format'
import { typeIcon, typeLabel } from '@/lib/labels'
import { useAiMode } from '@/lib/queries'
import { shares } from '@/lib/shares'
import type { Dossier, DossierItem, ReqStatus, Requirement } from '@/lib/types'
import { auth } from '@/drive/auth'
import { Badge, Button, Card, Field, IconButton, Input, Skeleton, Spinner, Textarea, cn } from '@/ui/kit'
import { DocPicker, ShareLinks, SharePanel } from '@/ui/share'
import { useVault, vault } from '@/ui/vault'

const today = () => new Date().toISOString().slice(0, 10)

/** the database's refusals, said in Arabic */
function arabic(e: unknown): string {
  const m = String((e as Error)?.message ?? e)
  if (/open the vault first/.test(m)) return 'افتح الخزنة أولاً: لهذا الملف رابط مفتوح فيه وثائق من الخزنة، وهو مخفي وهي مقفلة.'
  if (/take it back first/.test(m)) return 'اسحب روابط هذا الملف المفتوحة أولاً.'
  if (/vault is closed/.test(m)) return 'الخزنة مقفلة: افتحها لتعديل هذه القائمة.'
  if (/dossier not found/.test(m)) return 'هذا الملف لم يعد موجوداً.'
  if (/document not found/.test(m)) return 'هذه الوثيقة لم تعد موجودة.'
  return m
}

/** the status shown: a paper whose validity ended since the check is expired now */
function statusOf(r: Requirement): ReqStatus {
  if (r.document_id && r.gone) return 'missing'
  if (r.expiry_date && r.expiry_date < today() && r.status !== 'missing') return 'expired'
  return r.status
}

const STATUS: Record<ReqStatus, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral'; icon: typeof Check }> = {
  found: { label: 'موجودة', tone: 'success', icon: Check },
  expired: { label: 'انتهت صلاحيتها', tone: 'danger', icon: AlertTriangle },
  unsure: { label: 'تحتاج نظرة', tone: 'warning', icon: CircleHelp },
  missing: { label: 'تنقص', tone: 'neutral', icon: X },
}

// ------------------------------------------------------------------ the checklist
function Checklist({ d, refresh }: { d: Dossier; refresh: () => Promise<unknown> }) {
  const ai = useAiMode().data
  const v = useVault()
  const [procedure, setProcedure] = useState(d.plan?.procedure || d.name)
  const [official, setOfficial] = useState('')
  const [showOfficial, setShowOfficial] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [linking, setLinking] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const plan = d.plan
  const reqs = plan?.requirements ?? []
  const hiddenReqs = reqs.some((r) => r.hidden)
  const inside = new Set(d.items.map((i) => i.document_id))
  const vaultClosed = v.configured && !v.open

  const run = async () => {
    if (!procedure.trim()) return toast.error('اكتب الإجراء')
    setBusy(true)
    setStatus('يفكّر…')
    try {
      const p = await planDossier(procedure, showOfficial ? official : '', (e) => {
        if (e.kind === 'round') setStatus('يفكّر…')
        else if (e.kind === 'search') setStatus(e.query ? `يبحث في أرشيفك: «${e.query}»` : 'يتصفح أرشيفك')
        else if (e.kind === 'read') setStatus(`يقرأ: ${e.title}`)
      })
      await api.dossierSave({ id: d.id, plan: p })
      await refresh()
      const n = p.requirements.filter((r) => r.status === 'missing' || r.status === 'expired').length
      toast.success(n ? `انتهى الفحص: ${n} من ${p.requirements.length} تنقص أو انتهت صلاحيتها` : `انتهى الفحص: كل الوثائق الـ${p.requirements.length} موجودة`)
    } catch (e) {
      toast.error(arabic(e))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  const savePlan = async (requirements: Requirement[]) => {
    // only what was stored (the titles and dates are read again from the documents)
    const clean = requirements.map(({ label, status, document_id, note }) => ({ label, status, document_id: document_id ?? null, note: note ?? null }))
    await api.dossierSave({ id: d.id, plan: { ...plan!, requirements: clean } })
    await refresh()
  }

  const addFound = async () => {
    setAdding(true)
    try {
      const fromPlan = reqs.filter((r) => r.document_id && !r.gone && (statusOf(r) === 'found' || statusOf(r) === 'unsure'))
      const seen = new Set<string>()
      const ordered: { document_id: string; requirement: string | null }[] = []
      for (const r of fromPlan) {
        if (seen.has(r.document_id!)) continue
        seen.add(r.document_id!)
        ordered.push({ document_id: r.document_id!, requirement: r.label })
      }
      for (const i of d.items) if (!seen.has(i.document_id)) ordered.push({ document_id: i.document_id, requirement: i.requirement })
      await api.dossierSetItems(d.id, ordered)
      await refresh()
      toast.success('رُتّبت وثائق الملف على ترتيب القائمة')
    } catch (e) {
      toast.error(arabic(e))
    } finally {
      setAdding(false)
    }
  }

  if (ai === 'demo')
    return (
      <p className="text-sm leading-relaxed text-muted">
        ليقول لك Claude ما يطلبه هذا الإجراء وما ينقصك، أضف مفتاح Claude في{' '}
        <Link to="/settings" className="text-brand-700 underline dark:text-brand-200">
          الإعدادات
        </Link>
        . ويمكنك الآن جمع الوثائق في الملف بيدك.
      </p>
    )

  return (
    <div className="space-y-4">
      {plan && (
        <>
          {plan.summary && <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm leading-relaxed text-text">{plan.summary}</p>}
          <ul className="space-y-2">
            {reqs.map((r, i) => {
              const st = statusOf(r)
              const S = STATUS[st]
              return (
                <li key={i} className="flex flex-wrap items-start gap-3 rounded-xl border border-line p-3">
                  <div
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-lg',
                      st === 'found' ? 'bg-success-bg text-success' : st === 'expired' ? 'bg-danger-bg text-danger' : st === 'unsure' ? 'bg-warning-bg text-warning' : 'bg-surface-2 text-muted',
                    )}
                  >
                    <S.icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{r.label}</span>
                      <Badge tone={S.tone}>{S.label}</Badge>
                    </div>
                    {r.hidden ? (
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                        <Lock className="size-3" /> وثيقة في الخزنة المقفلة
                      </p>
                    ) : (
                      <>
                        {r.document_id && r.title && (
                          <Link to={`/doc/${r.document_id}`} className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-brand-700 hover:underline dark:text-brand-200">
                            <FileText className="size-3 shrink-0" />
                            <span className="truncate">{r.title}</span>
                            {r.expiry_date && <span className="num text-muted">· صالحة حتى {fmtDate(r.expiry_date)}</span>}
                          </Link>
                        )}
                        {r.gone && <p className="mt-0.5 text-xs text-danger">الوثيقة التي كانت تجيب عنه حُذفت</p>}
                        {r.note && <p className="mt-0.5 text-xs leading-relaxed text-muted">{r.note}</p>}
                      </>
                    )}
                  </div>
                  {!r.hidden && (
                    <div className="flex items-center gap-1">
                      {r.document_id && !r.gone && (st === 'found' || st === 'unsure') && !inside.has(r.document_id) && (
                        <Button
                          size="sm"
                          variant="outline"
                          icon={Plus}
                          onClick={async () => {
                            await api.dossierAdd(d.id, r.document_id!, r.label)
                            await refresh()
                          }}
                        >
                          إلى الملف
                        </Button>
                      )}
                      {r.document_id && inside.has(r.document_id) && (
                        <Badge tone="brand" icon={FolderCheck}>
                          في الملف
                        </Badge>
                      )}
                      {!hiddenReqs && (
                        <IconButton icon={Link2} label={r.document_id ? 'اربط وثيقة أخرى' : 'اربط وثيقة من أرشيفك'} size="sm" onClick={() => setLinking(i)} />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={ListChecks} loading={adding} onClick={() => void addFound()} disabled={!reqs.some((r) => r.document_id && !r.hidden)}>
              ضع الموجود في الملف بترتيب القائمة
            </Button>
            <span className="text-xs text-muted">
              فُحص {relTime(plan.planned_at)}
              {plan.cost_usd ? ` · ${fmtUsd(plan.cost_usd)}` : ''}
            </span>
          </div>
          {hiddenReqs && <p className="text-xs text-muted">افتح الخزنة لتعديل هذه القائمة أو إعادة فحصها.</p>}
        </>
      )}

      {!hiddenReqs && (
        <div className={cn('space-y-3', plan && 'border-t border-line pt-4')}>
          {plan && <h3 className="text-sm font-semibold text-ink">أعد الفحص</h3>}
          <Field label="الإجراء" hint="كلما كان أدق (البلد، الجهة، تاريخ الموعد) كانت القائمة أدق">
            <Input value={procedure} onChange={(e) => setProcedure(e.target.value)} dir="auto" placeholder="مثلاً: تجديد بطاقة الإقامة في مدريد، موعد 10 يناير 2027" />
          </Field>
          {showOfficial ? (
            <Field label="القائمة الرسمية للوثائق" hint="ألصقها من موقع الإدارة أو من الرسالة التي وصلتك: يتبعها Claude بنداً بنداً">
              <Textarea rows={5} value={official} onChange={(e) => setOfficial(e.target.value)} dir="auto" />
            </Field>
          ) : (
            <button type="button" className="text-sm text-brand-700 hover:underline dark:text-brand-200" onClick={() => setShowOfficial(true)}>
              + عندي القائمة الرسمية للوثائق المطلوبة
            </button>
          )}
          {vaultClosed && (
            <p className="flex items-start gap-2 rounded-xl bg-brass-100/60 px-3 py-2 text-xs leading-relaxed text-brass-700 dark:text-brass-400">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              الخزنة مقفلة: لن يرى Claude جوازك وبطاقاتك فيعدّها ناقصة.
              <button type="button" className="font-medium underline" onClick={() => void vault.open()}>
                افتحها أولاً
              </button>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={plan ? RefreshCw : Sparkles} loading={busy} onClick={() => void run()}>
              {plan ? 'افحص من جديد' : 'ما الذي ينقصني؟'}
            </Button>
            {busy && status ? (
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <Spinner className="size-3.5" /> <span className="truncate">{status}</span>
              </span>
            ) : (
              <span className="text-xs text-muted">يبحث Claude في أرشيفك عن كل وثيقة (نحو 0.1 إلى 0.3 دولار).</span>
            )}
          </div>
        </div>
      )}

      <DocPicker
        open={linking !== null}
        onClose={() => setLinking(null)}
        title={linking !== null ? `الوثيقة التي تجيب عن: ${reqs[linking]?.label ?? ''}` : ''}
        onPick={async (doc) => {
          if (linking === null) return
          const next = reqs.map((r, i) => (i === linking ? { ...r, document_id: doc.id, status: 'found' as ReqStatus, note: r.status === 'missing' ? null : r.note } : r))
          await savePlan(next)
          if (!inside.has(doc.id)) await api.dossierAdd(d.id, doc.id, reqs[linking]?.label ?? null)
          await refresh()
          setLinking(null)
          toast.success('رُبطت الوثيقة وأُضيفت إلى الملف')
        }}
      />
    </div>
  )
}

// ------------------------------------------------------------------ the documents, in order
function Items({ d, refresh }: { d: Dossier; refresh: () => Promise<unknown> }) {
  const [picking, setPicking] = useState(false)
  const [edit, setEdit] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const items = d.items
  const save = async (next: DossierItem[]) => {
    try {
      await api.dossierSetItems(
        d.id,
        next.map((i) => ({ document_id: i.document_id, requirement: i.requirement })),
      )
      await refresh()
    } catch (e) {
      toast.error(arabic(e))
    }
  }
  const move = (i: number, by: number) => {
    const next = [...items]
    const [x] = next.splice(i, 1)
    next.splice(i + by, 0, x)
    void save(next)
  }
  return (
    <div>
      {items.length === 0 ? (
        <p className="text-sm text-muted">لا وثيقة في الملف بعد.</p>
      ) : (
        <ol className="space-y-2">
          {items.map((it, i) => {
            const Icon = typeIcon(it.doc_type)
            const expired = it.expiry_date && daysUntil(it.expiry_date) < 0
            return (
              <li key={it.document_id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
                <span className="num grid size-7 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 dark:text-brand-200">{i + 1}</span>
                <Icon className="size-4 shrink-0 text-brand-600" />
                <div className="min-w-0 flex-1">
                  {edit === it.document_id ? (
                    <form
                      className="flex items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault()
                        setEdit(null)
                        void save(items.map((x) => (x.document_id === it.document_id ? { ...x, requirement: label.trim() || null } : x)))
                      }}
                    >
                      <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ما يقابلها في القائمة" dir="auto" className="h-8" />
                      <IconButton type="submit" icon={Check} label="احفظ" size="sm" />
                    </form>
                  ) : (
                    <>
                      {it.requirement && <div className="truncate text-xs font-medium text-brand-700 dark:text-brand-200">{it.requirement}</div>}
                      <Link to={`/doc/${it.document_id}`} className="block truncate text-sm text-ink hover:underline">
                        {it.title}
                      </Link>
                      <div className="text-xs text-muted">
                        {typeLabel(it.doc_type)} · {pagesAr(it.page_count || 1)}
                        {it.expiry_date && (
                          <span className={cn('num', expired && 'font-medium text-danger')}>
                            {' '}
                            · {expired ? 'انتهت صلاحيتها في' : 'صالحة حتى'} {fmtDate(it.expiry_date)}
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className="flex items-center">
                  <IconButton
                    icon={Pencil}
                    label="سمِّ ما تجيب عنه"
                    size="sm"
                    onClick={() => {
                      setLabel(it.requirement ?? '')
                      setEdit(it.document_id)
                    }}
                  />
                  <IconButton icon={ArrowUp} label="إلى الأعلى" size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon={ArrowDown} label="إلى الأسفل" size="sm" disabled={i === items.length - 1} onClick={() => move(i, 1)} />
                  <IconButton
                    icon={X}
                    label="أخرجها من الملف"
                    size="sm"
                    className="hover:text-danger"
                    onClick={async () => {
                      await api.dossierRemove(d.id, it.document_id)
                      await refresh()
                    }}
                  />
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {d.hidden > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <Lock className="size-3.5" /> و{docsAr(d.hidden)} من الخزنة المقفلة
        </p>
      )}
      <Button className="mt-3" variant="secondary" icon={Plus} onClick={() => setPicking(true)}>
        أضف وثيقة
      </Button>
      <DocPicker
        open={picking}
        onClose={() => setPicking(false)}
        exclude={items.map((i) => i.document_id)}
        onPick={async (doc) => {
          await api.dossierAdd(d.id, doc.id)
          await refresh()
          toast.success('أُضيفت')
        }}
      />
    </div>
  )
}

// ------------------------------------------------------------------ the page
export default function DossierPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const v = useVault()
  const q = useQuery({ queryKey: ['dossier', id], queryFn: () => api.dossier(id) })
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const refresh = () => Promise.all([q.refetch(), qc.invalidateQueries({ queryKey: ['dossiers'] }), qc.invalidateQueries({ queryKey: ['shares'] })])

  if (q.isLoading) return <Skeleton className="mx-auto h-96 max-w-3xl" />
  const d = q.data
  if (!d)
    return (
      <Card className="mx-auto max-w-3xl p-10 text-center text-sm text-muted">
        هذا الملف غير موجود.{' '}
        <Link to="/dossiers" className="text-brand-700 underline dark:text-brand-200">
          الملفات الجاهزة
        </Link>
      </Card>
    )

  const live = d.shares.filter((s) => !s.revoked && !s.expired)
  const del = async () => {
    if (!confirm(live.length ? `أتحذف هذا الملف؟ ستُسحب روابطه المفتوحة (${live.length}) أولاً. الوثائق نفسها تبقى في أرشيفك.` : 'أتحذف هذا الملف؟ الوثائق نفسها تبقى في أرشيفك.')) return
    setDeleting(true)
    try {
      if (live.length && !(await shares.ready())) await auth.connect()
      for (const s of live) await shares.revoke({ id: s.id, drive_file: s.drive_file })
      await api.dossierDelete(d.id)
      await qc.invalidateQueries({ queryKey: ['dossiers'] })
      await qc.invalidateQueries({ queryKey: ['shares'] })
      toast.success('حُذف الملف')
      nav('/dossiers')
    } catch (e) {
      toast.error(arabic(e))
    } finally {
      setDeleting(false)
    }
  }

  const blocked = d.hidden > 0 && !v.open ? `افتح الخزنة أولاً: في هذا الملف ${docsAr(d.hidden)} من الخزنة، ولا تدخل الـPDF وهي مقفلة.` : !d.items.length ? 'أضف وثائق إلى الملف أولاً.' : null

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/dossiers" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowRight className="size-4" /> الملفات الجاهزة
      </Link>

      <div className="flex flex-wrap items-start gap-3">
        <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-600">
          <FolderCheck className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!name.trim()) return
                await api.dossierSave({ id: d.id, name: name.trim() })
                setRenaming(false)
                await refresh()
              }}
            >
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
              <Button type="submit" size="sm">
                احفظ
              </Button>
            </form>
          ) : (
            <h1 className="font-display text-[26px] leading-snug text-ink">
              {d.name}
              <button
                type="button"
                className="ms-2 align-middle text-muted hover:text-ink"
                title="غيّر الاسم"
                onClick={() => {
                  setName(d.name)
                  setRenaming(true)
                }}
              >
                <Pencil className="inline size-4" />
              </button>
            </h1>
          )}
          <p className="mt-1 text-sm text-muted">
            {d.items.length + d.hidden ? docsAr(d.items.length + d.hidden) : 'لا وثيقة بعد'} · أُنشئ {relTime(d.created_at)}
            {live.length > 0 && <span className="text-success"> · رابط مفتوح</span>}
          </p>
        </div>
        <Button variant="ghost" icon={Trash2} className="hover:text-danger" loading={deleting} onClick={() => void del()}>
          احذف الملف
        </Button>
      </div>

      {d.hidden > 0 && !v.open && (
        <Card className="flex flex-wrap items-center gap-3 border-brass-400/50 bg-brass-100/50 p-4 text-sm">
          <Lock className="size-5 shrink-0 text-brass-600" />
          <span className="min-w-0 flex-1 leading-relaxed">في هذا الملف {docsAr(d.hidden)} من الخزنة المقفلة: افتحها لتراها وتضعها في الـPDF.</span>
          <Button size="sm" variant="brass" onClick={() => void vault.open()}>
            افتح الخزنة
          </Button>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-3 flex items-center gap-2 font-semibold text-ink">
          <ClipboardList className="size-5 text-brand-600" /> ما يطلبه الإجراء
        </h2>
        <Checklist key={d.plan?.planned_at ?? 'none'} d={d} refresh={refresh} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 flex items-center gap-2 font-semibold text-ink">
          <FileText className="size-5 text-brand-600" /> وثائق الملف بالترتيب
        </h2>
        <Items d={d} refresh={refresh} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 flex items-center gap-2 font-semibold text-ink">
          <Link2 className="size-5 text-brand-600" /> الطباعة والإرسال
        </h2>
        <SharePanel
          entries={d.items.map((i) => ({ id: i.document_id, requirement: i.requirement }))}
          title={d.name}
          subtitle={d.notes}
          target={{ collection_id: d.id }}
          blocked={blocked}
          pages={d.items.reduce((n, i) => n + (i.page_count || 1), 0)}
          onShared={refresh}
        />
        {d.shares.length > 0 && (
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="mb-2 text-sm font-semibold text-ink">روابط هذا الملف</h3>
            <ShareLinks links={d.shares} onChange={refresh} />
          </div>
        )}
      </Card>

      <Card className="p-5">
        <Field label="ملاحظات" hint="الموعد، العنوان، رقم الملف لدى الإدارة… (تظهر تحت العنوان في غلاف الـPDF)">
          <Textarea
            rows={3}
            dir="auto"
            value={notes ?? d.notes ?? ''}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={async () => {
              if (notes === null || notes === (d.notes ?? '')) return
              await api.dossierSave({ id: d.id, notes })
              setNotes(null)
              await refresh()
            }}
          />
        </Field>
      </Card>
    </div>
  )
}
