import { useQueryClient } from '@tanstack/react-query'
import { Check, CheckCheck, Copy, FolderPlus, HelpCircle, Inbox, PartyPopper, UserPlus, Users, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { docsAr } from '@/lib/format'
import { RELATION_LABEL, roleLabel, typeLabel } from '@/lib/labels'
import { useReviews } from '@/lib/queries'
import type { Proposal, Review } from '@/lib/types'
import { CatPath, PageHeader, Thumb } from '@/ui/bits'
import { Badge, Button, Card, Empty, Field, Input, Segmented, Skeleton, cn } from '@/ui/kit'
import { CategoryPicker } from '@/ui/pickers'

type Tab = 'all' | 'categories' | 'duplicates' | 'people' | 'other'

export default function ReviewPage() {
  const { data, isLoading } = useReviews()
  const [tab, setTab] = useState<Tab>('all')
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries()
  if (isLoading || !data) return <Skeleton className="h-96" />

  const proposals = data.proposals
  const dups = data.items.filter((r) => r.kind === 'duplicate')
  const people = data.items.filter((r) => r.kind === 'person_match' || r.kind === 'person_new')
  const other = data.items.filter((r) => !['duplicate', 'person_match', 'person_new'].includes(r.kind))
  const total = proposals.length + data.items.length

  const acceptAll = async () => {
    for (const p of proposals) await api.proposalResolve({ id: p.id, action: 'accept' })
    toast.success(`أُنشئت ${proposals.length} رفوف`)
    await refresh()
  }

  return (
    <div>
      <PageHeader
        title="تحتاج قرارك"
        icon={Inbox}
        subtitle="ما لم يكن التطبيق متأكداً منه، أو ما يحتاج موافقتك: رفوف جديدة، تكرارات محتملة، أشخاص."
        actions={
          proposals.length > 1 ? (
            <Button variant="brass" icon={CheckCheck} onClick={acceptAll}>
              اقبل كل الرفوف المقترحة ({proposals.length})
            </Button>
          ) : null
        }
      />
      {total === 0 ? (
        <Card>
          <Empty icon={PartyPopper} title="لا شيء ينتظرك">
            كل الوثائق مصنفة ولا أسئلة معلقة. عندما يقترح التطبيق رفاً جديداً أو يشك في تكرار، ستجده هنا.
          </Empty>
        </Card>
      ) : (
        <>
          <Segmented
            className="mb-5 max-w-full overflow-x-auto"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'all', label: `الكل ${total}` },
              { value: 'categories', label: `رفوف مقترحة ${proposals.length}`, icon: FolderPlus },
              { value: 'duplicates', label: `تكرارات ${dups.length}`, icon: Copy },
              { value: 'people', label: `أشخاص ${people.length}`, icon: Users },
              { value: 'other', label: `أخرى ${other.length}`, icon: HelpCircle },
            ]}
          />
          <div className="space-y-4">
            {(tab === 'all' || tab === 'categories') && proposals.map((p) => <ProposalCard key={p.id} p={p} onDone={refresh} />)}
            {(tab === 'all' || tab === 'duplicates') && dups.map((r) => <DuplicateCard key={r.id} r={r} onDone={refresh} />)}
            {(tab === 'all' || tab === 'people') && people.map((r) => <PersonCard key={r.id} r={r} onDone={refresh} />)}
            {(tab === 'all' || tab === 'other') && other.map((r) => <OtherCard key={r.id} r={r} onDone={refresh} />)}
          </div>
        </>
      )}
    </div>
  )
}

function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const [names, setNames] = useState({ name_ar: p.name_ar, name_fr: p.name_fr ?? '', name_es: p.name_es ?? '', name_en: p.name_en ?? '' })
  const [parent, setParent] = useState<{ id: string | null; changed: boolean }>({ id: p.parent_id, changed: false })
  const [pick, setPick] = useState<'parent' | 'remap' | null>(null)
  const [busy, setBusy] = useState(false)
  const docs = p.docs ?? []
  const act = async (action: 'accept' | 'reject' | 'remap', category_id?: string) => {
    setBusy(true)
    try {
      const edits: Record<string, unknown> = { ...names }
      if (parent.changed) edits.parent_id = parent.id
      const r = await api.proposalResolve({ id: p.id, action, edits, category_id })
      if (action === 'accept')
        toast.success(`أُنشئ الرف «${names.name_ar}» ونُقلت إليه ${docsAr(r.moved)}${r.backfill.length ? ` — ووجدتُ ${docsAr(r.backfill.length)} أقدم قد ${r.backfill.length === 1 ? 'تناسبه' : 'تناسبه أيضاً'}، راجعها أسفله` : ''}`)
      else if (action === 'remap') toast.success('نُقلت الوثائق — وسأتذكر اختيارك للمرات القادمة')
      else toast('لن أقترح هذا الرف مرة أخرى')
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="overflow-hidden border-brass-400/40">
      <div className="flex items-center gap-2 border-b border-line bg-brass-100/50 px-5 py-3 text-sm">
        <FolderPlus className="size-4 text-brass-600" />
        <span className="font-semibold text-ink">اقتراح رف جديد</span>
        <span className="text-muted">· {docsAr(docs.length)}</span>
        {docs.length === 1 && <Badge tone="warning">سيضم وثيقة واحدة حالياً</Badge>}
      </div>
      <div className="grid grid-cols-1 gap-5 p-5 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="الاسم بالعربية" className="sm:col-span-2">
              <Input value={names.name_ar} onChange={(e) => setNames({ ...names, name_ar: e.target.value })} className="text-base font-semibold" />
            </Field>
            <Field label="بالفرنسية">
              <Input dir="ltr" value={names.name_fr} onChange={(e) => setNames({ ...names, name_fr: e.target.value })} />
            </Field>
            <Field label="بالإسبانية">
              <Input dir="ltr" value={names.name_es} onChange={(e) => setNames({ ...names, name_es: e.target.value })} />
            </Field>
          </div>
          <div className="text-sm">
            <span className="text-muted">مكانه: </span>
            <button className="font-medium text-brand-600 hover:underline" onClick={() => setPick('parent')}>
              {parent.changed ? (parent.id ? 'داخل الرف المختار' : 'رف رئيسي') : p.parent_path?.length ? <CatPath path={p.parent_path} link={false} /> : 'رف رئيسي'}
            </button>
            <span className="text-muted"> ← {names.name_ar}</span>
          </div>
          {p.reason && <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm leading-relaxed text-text">{p.reason}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="brass" icon={Check} loading={busy} onClick={() => act('accept')}>
              أنشئه وانقل إليه
            </Button>
            <Button variant="secondary" onClick={() => setPick('remap')} disabled={busy}>
              ضعها في رف موجود
            </Button>
            <Button variant="ghost" icon={X} onClick={() => act('reject')} disabled={busy}>
              لا تقترحه
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {docs.slice(0, 5).map((d) => (
            <Link key={d.id} to={`/doc/${d.id}`} className="flex items-center gap-3 rounded-xl border border-line p-2 hover:border-brand-500">
              <Thumb path={d.thumb} type={d.doc_type} className="h-12 w-10" />
              <div className="min-w-0">
                <div className="truncate text-sm text-ink">{d.title}</div>
                <div className="text-xs text-muted">{typeLabel(d.doc_type)}</div>
              </div>
            </Link>
          ))}
          {docs.length > 5 && <div className="text-xs text-muted">و{docs.length - 5} أخرى</div>}
        </div>
      </div>
      <CategoryPicker
        open={pick !== null}
        onClose={() => setPick(null)}
        allowNone={pick === 'parent'}
        title={pick === 'parent' ? 'ضع الرف الجديد داخل…' : 'اختر الرف المناسب'}
        onPick={async (cid) => {
          const mode = pick
          setPick(null)
          if (mode === 'parent') setParent({ id: cid, changed: true })
          else if (cid) await act('remap', cid)
        }}
      />
    </Card>
  )
}

function DuplicateCard({ r, onDone }: { r: Review; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const d = r.doc
  const pl = r.payload as { other_id: string; other_title: string; relation: string; reason?: string; method?: string; suggestion?: string }
  const decide = async (decision: Record<string, unknown>, msg: string) => {
    setBusy(true)
    await api.reviewResolve(r.id, decision)
    toast.success(msg)
    onDone()
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-5 py-3 text-sm">
        <Copy className="size-4 text-brand-600" />
        <span className="font-semibold text-ink">{pl.relation === 'better_copy' ? 'نسخة أوضح من وثيقة موجودة؟' : 'هل هذه نفس الوثيقة؟'}</span>
        {pl.reason && <span className="text-muted">· {pl.reason}</span>}
      </div>
      <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        {[
          { label: 'الجديدة', id: d?.id, title: d?.title, thumb: d?.thumb, type: d?.doc_type, keep: pl.suggestion === 'keep_new' },
          { label: 'الموجودة سابقاً', id: pl.other_id, title: pl.other_title, thumb: null as string | null, type: null as string | null, keep: pl.suggestion === 'keep_existing' },
        ].map((s) => (
          <Link key={s.label} to={`/doc/${s.id}`} className={cn('flex items-center gap-3 rounded-2xl border p-3 hover:border-brand-500', s.keep ? 'border-success/50 bg-success-bg/40' : 'border-line')}>
            <Thumb path={s.thumb} type={s.type} className="h-20 w-16" />
            <div className="min-w-0">
              <div className="text-xs text-muted">{s.label}</div>
              <div className="line-clamp-2 text-sm font-medium text-ink">{s.title}</div>
              {s.keep && <Badge tone="success">الأوضح — نقترح الاحتفاظ بها</Badge>}
            </div>
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3.5">
        <Button
          size="sm"
          loading={busy}
          onClick={() =>
            decide(
              { relation: 'same', discard: pl.suggestion === 'keep_new' ? 'existing' : 'new' },
              'احتُفظ بالنسخة الأوضح، والأخرى في سلة المحذوفات (تُسترجع خلال 30 يوماً)',
            )
          }
        >
          نفس الوثيقة: احتفظ بالأوضح
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide({ relation: pl.relation === 'better_copy' ? 'better_copy' : 'same' }, 'احتُفظ بالاثنتين مربوطتين')}>
          احتفظ بالاثنتين مربوطتين
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide({ relation: 'version' }, 'رُبطتا كإصدارين')}>
          {RELATION_LABEL.version}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide({ relation: 'different' }, 'لن أعتبرهما متكررتين')}>
          ليستا نفس الوثيقة
        </Button>
      </div>
    </Card>
  )
}

function PersonCard({ r, onDone }: { r: Review; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const pl = r.payload as { name?: string; candidate_name?: string; role?: string; similarity?: number; people?: { entity_id: string; name: string; role: string }[] }
  const go = async (decision: Record<string, unknown>, msg: string) => {
    setBusy(true)
    await api.reviewResolve(r.id, decision)
    toast.success(msg)
    onDone()
  }
  if (r.kind === 'person_match')
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <Users className="mt-0.5 size-5 text-brand-600" />
          <div className="flex-1">
            <p className="text-[15px] text-ink">
              هل <span className="font-semibold">«{pl.name}»</span> هو نفسه <span className="font-semibold">«{pl.candidate_name}»</span>؟
            </p>
            <p className="mt-1 text-xs text-muted">
              {pl.role ? `${roleLabel(pl.role)} في ` : 'في '}
              {r.doc ? (
                <Link to={`/doc/${r.doc.id}`} className="text-brand-600 hover:underline">
                  {r.doc.title}
                </Link>
              ) : (
                'وثيقة'
              )}{' '}
              · تشابه الاسمين {Math.round((pl.similarity ?? 0) * 100)}%
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" loading={busy} onClick={() => go({ same: true }, 'دُمجا في شخص واحد')}>
                نعم، نفس الشخص
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => go({ same: false }, 'سُجّلا كشخصين مختلفين')}>
                لا، شخصان مختلفان
              </Button>
            </div>
          </div>
        </div>
      </Card>
    )
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <UserPlus className="mt-0.5 size-5 text-brand-600" />
        <div className="flex-1">
          <p className="text-[15px] text-ink">أشخاص جدد في {r.doc ? <Link to={`/doc/${r.doc.id}`} className="font-semibold text-brand-600 hover:underline">{r.doc.title}</Link> : 'وثيقة'}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(pl.people ?? []).map((x) => (
              <Link key={x.entity_id} to={`/people/${x.entity_id}`} className="rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-sm hover:border-brand-500">
                {x.name} <span className="text-xs text-muted">{roleLabel(x.role)}</span>
              </Link>
            ))}
          </div>
          <div className="mt-3">
            <Button size="sm" icon={Check} loading={busy} onClick={() => go({}, 'أضيفوا إلى سجل الأشخاص')}>
              أكّد
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

function OtherCard({ r, onDone }: { r: Review; onDone: () => void }) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(((r.payload.docs ?? []) as { id: string }[]).map((d) => d.id)))
  const [busy, setBusy] = useState(false)
  if (r.kind === 'backfill') {
    const docs = (r.payload.docs ?? []) as { id: string; title: string }[]
    return (
      <Card className="p-5">
        <p className="text-[15px] text-ink">
          وجدتُ {docsAr(docs.length)} سابقة قد تناسب الرف الجديد <span className="font-semibold">«{r.payload.category_name}»</span> — اختر ما ينقل إليه
        </p>
        <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
          {docs.map((d) => (
            <label key={d.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--brand-600)]"
                checked={sel.has(d.id)}
                onChange={(e) =>
                  setSel((s) => {
                    const n = new Set(s)
                    if (e.target.checked) n.add(d.id)
                    else n.delete(d.id)
                    return n
                  })
                }
              />
              <Link to={`/doc/${d.id}`} className="hover:text-brand-600">
                {d.title}
              </Link>
            </label>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            loading={busy}
            disabled={!sel.size}
            onClick={async () => {
              setBusy(true)
              await api.reviewResolve(r.id, { ids: [...sel] })
              toast.success(`نُقلت ${docsAr(sel.size)}`)
              onDone()
            }}
          >
            انقل المحدد ({sel.size})
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.reviewResolve(r.id, {}, true)
              onDone()
            }}
          >
            تجاهل
          </Button>
        </div>
      </Card>
    )
  }
  return (
    <Card className="flex flex-wrap items-center gap-4 p-5">
      <HelpCircle className="size-5 text-brass-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">
          تصنيف غير مؤكد: {r.doc ? <Link to={`/doc/${r.doc.id}`} className="font-semibold text-brand-600 hover:underline">{r.doc.title}</Link> : 'وثيقة'}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {r.doc?.category_path?.length ? <CatPath path={r.doc.category_path} link={false} /> : 'بدون رف'} {r.payload.reason ? `· ${r.payload.reason}` : ''}
        </p>
      </div>
      <Button
        size="sm"
        icon={Check}
        onClick={async () => {
          await api.reviewResolve(r.id, {})
          onDone()
        }}
      >
        صحيح
      </Button>
      {r.doc && (
        <Link to={`/doc/${r.doc.id}`} className="text-sm text-brand-600 hover:underline">
          تعديل
        </Link>
      )}
    </Card>
  )
}
