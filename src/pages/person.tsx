import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, Merge, Network, Pencil, Search, User } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { fmtDate } from '@/lib/format'
import { roleLabel, typeLabel } from '@/lib/labels'
import { useEntities, useEntity } from '@/lib/queries'
import { CatPath, Thumb } from '@/ui/bits'
import { Badge, Button, Card, Dialog, Field, Input, LinkButton, Skeleton } from '@/ui/kit'

export default function PersonPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data: e, isLoading } = useEntity(id)
  const [editing, setEditing] = useState(false)
  const [merging, setMerging] = useState(false)
  const [form, setForm] = useState({ name: '', name_latin: '', honorific: '' })
  const [mq, setMq] = useState('')
  const candidates = useEntities(e?.kind ?? 'person', mq).data ?? []

  const byYear = useMemo(() => {
    const m = new Map<string, NonNullable<typeof e>['docs']>()
    for (const d of e?.docs ?? []) {
      const y = d.doc_date?.slice(0, 4) ?? d.academic_year?.slice(0, 4) ?? 'بدون تاريخ'
      if (!m.has(y)) m.set(y, [])
      m.get(y)!.push(d)
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [e])

  if (isLoading) return <Skeleton className="h-96" />
  if (!e) return <Card className="p-10 text-center text-muted">غير موجود</Card>

  const roles = [...new Set(e.docs.map((d) => d.role))].filter((r) => r !== 'mentioned')

  return (
    <div>
      <button onClick={() => nav(-1)} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowRight className="size-4" /> رجوع
      </button>
      <Card className="mb-6 overflow-hidden">
        <div className="kh-hero px-6 py-7 text-white">
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid size-16 place-items-center rounded-3xl bg-white/15 text-2xl font-semibold">
              <User className="size-8" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-[30px] leading-tight">
                {e.honorific ? `${e.honorific} ` : ''}
                {e.name}
              </h1>
              {e.name_latin && (
                <div className="latin text-white/75" dir="ltr">
                  {e.name_latin}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs">{e.docs.length} وثيقة</span>
                {roles.map((r) => (
                  <span key={r} className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs">
                    {roleLabel(r)}
                  </span>
                ))}
                {e.details?.institution && <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs">{e.details.institution}</span>}
              </div>
            </div>
            <div className="flex gap-2">
              {!e.confirmed && (
                <Button
                  variant="brass"
                  size="sm"
                  icon={Check}
                  onClick={async () => {
                    await api.entitySave({ id: e.id, confirmed: true })
                    await qc.invalidateQueries()
                  }}
                >
                  أكّد
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={Pencil}
                onClick={() => {
                  setForm({ name: e.name, name_latin: e.name_latin ?? '', honorific: e.honorific ?? '' })
                  setEditing(true)
                }}
              >
                تعديل
              </Button>
              <Button variant="secondary" size="sm" icon={Merge} onClick={() => setMerging(true)}>
                دمج
              </Button>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold text-subtle">المجالات</h3>
            <div className="flex flex-wrap gap-1.5">
              {e.categories.length ? (
                e.categories.map((c) => (
                  <Link key={c.id} to={`/library?cat=${c.id}`}>
                    <Badge tone="brand">
                      {c.name} · {c.count}
                    </Badge>
                  </Link>
                ))
              ) : (
                <span className="text-sm text-muted">—</span>
              )}
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold text-subtle">يرد مع</h3>
            <div className="flex flex-wrap gap-1.5">
              {e.related.length ? (
                e.related.map((r) => (
                  <Link key={r.id} to={`/people/${r.id}`}>
                    <Badge>
                      {r.name} · {r.count}
                    </Badge>
                  </Link>
                ))
              ) : (
                <span className="text-sm text-muted">—</span>
              )}
            </div>
          </div>
        </div>
      </Card>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">وثائقه عبر السنوات</h2>
        <div className="flex flex-wrap gap-2">
          <LinkButton to={`/relations?center=${e.id}`} variant="ghost" size="sm" icon={Network}>
            شبكة صلاته
          </LinkButton>
          <LinkButton to={`/search?person=${e.id}`} variant="secondary" size="sm" icon={Search}>
            ابحث داخلها
          </LinkButton>
        </div>
      </div>
      <div className="space-y-6">
        {byYear.map(([y, docs]) => (
          <div key={y} className="relative ps-6">
            <div className="absolute start-1.5 top-2 h-full w-px bg-line" />
            <div className="absolute start-0 top-1.5 size-3.5 rounded-full border-2 border-brand-600 bg-surface" />
            <div className="num mb-2 text-sm font-semibold text-brand-700 dark:text-brand-200">{y}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {docs.map((d) => (
                <Link key={d.id + d.role} to={`/doc/${d.id}`} className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-2.5 shadow-soft hover:border-brand-200">
                  <Thumb path={d.thumb} type={d.doc_type} className="h-16 w-12" />
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-sm font-medium text-ink">{d.title}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {typeLabel(d.doc_type)} · {roleLabel(d.role)}
                      {d.doc_date ? ` · ${fmtDate(d.doc_date, d.date_precision)}` : ''}
                    </div>
                    <CatPath path={d.category_path} link={false} className="text-[11px] text-subtle" />
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="تعديل"
        footer={
          <Button
            onClick={async () => {
              await api.entitySave({ id: e.id, ...form, confirmed: true })
              await qc.invalidateQueries()
              setEditing(false)
              toast.success('حُفظ')
            }}
          >
            حفظ
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-3">
          <Field label="الاسم">
            <Input value={form.name} onChange={(x) => setForm({ ...form, name: x.target.value })} />
          </Field>
          <Field label="بالحروف اللاتينية">
            <Input dir="ltr" value={form.name_latin} onChange={(x) => setForm({ ...form, name_latin: x.target.value })} />
          </Field>
          <Field label="اللقب" hint="د. / الأستاذ / Pr.">
            <Input value={form.honorific} onChange={(x) => setForm({ ...form, honorific: x.target.value })} />
          </Field>
        </div>
      </Dialog>
      <Dialog open={merging} onClose={() => setMerging(false)} title={`دمج «${e.name}» في…`}>
        <Input autoFocus value={mq} onChange={(x) => setMq(x.target.value)} placeholder="ابحث عن الاسم الصحيح" />
        <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
          {candidates
            .filter((c) => c.id !== e.id)
            .map((c) => (
              <button
                key={c.id}
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-start text-sm hover:bg-brand-50"
                onClick={async () => {
                  await api.entityMerge(e.id, c.id)
                  await qc.invalidateQueries()
                  toast.success('دُمجا في شخص واحد')
                  nav(`/people/${c.id}`, { replace: true })
                }}
              >
                <span>
                  {c.name} {c.name_latin ? <span className="latin text-xs text-muted">· {c.name_latin}</span> : null}
                </span>
                <span className="num text-xs text-muted">{c.doc_count}</span>
              </button>
            ))}
        </div>
      </Dialog>
    </div>
  )
}
