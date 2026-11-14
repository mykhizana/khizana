import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpDown, Download, FolderInput, Mic, Search as SearchIcon, SearchX, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { parseQuery, type ParsedQuery } from '@/ai/claude'
import { api } from '@/db/api'
import { langLabel, typeLabel } from '@/lib/labels'
import { queryTokens } from '@/lib/norm'
import { useAiMode, useCategories, useSearchPages } from '@/lib/queries'
import type { SearchFilters } from '@/lib/types'
import { DocRow, PageHeader } from '@/ui/bits'
import { CategoryPicker } from '@/ui/pickers'
import { downloadZip } from '@/ui/download'
import { Badge, Button, Card, Chip, Dialog, Empty, Select, Skeleton, cn } from '@/ui/kit'

const SORTS = [
  { v: 'relevance', l: 'الأنسب' },
  { v: 'newest', l: 'الأحدث إضافة' },
  { v: 'doc_date', l: 'تاريخ الوثيقة' },
  { v: 'oldest', l: 'الأقدم' },
  { v: 'title', l: 'العنوان' },
]

function readFilters(sp: URLSearchParams): SearchFilters {
  const f: SearchFilters = {}
  const list = (k: string) => sp.getAll(k).filter(Boolean)
  if (list('cat').length) f.category_ids = list('cat')
  if (list('type').length) f.doc_types = list('type')
  if (list('person').length) f.entity_ids = list('person')
  if (list('lang').length) f.languages = list('lang')
  if (sp.get('from')) f.year_from = Number(sp.get('from'))
  if (sp.get('to')) f.year_to = Number(sp.get('to'))
  if (sp.get('loc')) f.location_id = sp.get('loc')!
  return f
}

// voice search (Chrome / Android / Safari): Arabic of Morocco by default
type SpeechRec = { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; start: () => void }
function useVoice(onText: (t: string) => void) {
  const Ctor = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition
  const [on, setOn] = useState(false)
  const start = () => {
    if (!Ctor) return
    const r = new Ctor()
    r.lang = 'ar-MA'
    r.interimResults = false
    r.onresult = (e) => onText(e.results[0][0].transcript)
    r.onend = () => setOn(false)
    setOn(true)
    r.start()
  }
  return { supported: !!Ctor, on, start }
}

export default function SearchPage() {
  const [sp, setSp] = useSearchParams()
  const qc = useQueryClient()
  const q = sp.get('q') ?? ''
  const sort = sp.get('sort') ?? (q ? 'relevance' : 'newest')
  const smartOff = sp.get('smart') === '0'
  const filters = useMemo(() => readFilters(sp), [sp])
  const cats = useCategories().data ?? []
  const ai = useAiMode().data
  const [input, setInput] = useState(q)
  const [parsed, setParsed] = useState<ParsedQuery | null>(null)
  const [parsing, setParsing] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moveOpen, setMoveOpen] = useState(false)
  const voice = useVoice((t) => {
    setInput(t)
    update({ q: t })
  })

  useEffect(() => setInput(q), [q])
  useEffect(() => {
    setSelected(new Set())
  }, [q, sp])

  // the AI reads multi-word phrases («محاضرات بنعلي في الإداري 2018») and turns them into filters
  useEffect(() => {
    setParsed(null)
    const words = q.trim().split(/\s+/).filter(Boolean)
    if (ai !== 'claude' || smartOff || (words.length < 3 && !/\d{4}/.test(q))) return
    let alive = true
    setParsing(true)
    parseQuery(q, cats)
      .then(async (p) => {
        if (!alive) return
        // people named in the phrase → their ids in the registry
        const ids: string[] = []
        for (const name of p.person_names.slice(0, 3)) {
          const found = await api.entities({ kind: 'person', q: name, limit: 1 })
          if (found[0]) ids.push(found[0].id)
        }
        const useful = p.doc_types.length || p.category_ids.length || ids.length || p.year_from || p.year_to || p.languages.length
        if (alive && useful) setParsed({ ...p, person_names: ids })
      })
      .catch(() => undefined)
      .finally(() => alive && setParsing(false))
    return () => {
      alive = false
    }
  }, [q, ai, smartOff, cats.length])

  const effective = useMemo(() => {
    if (!parsed) return { q, filters }
    const f: SearchFilters = { ...filters }
    if (parsed.doc_types.length && !f.doc_types) f.doc_types = parsed.doc_types
    if (parsed.category_ids.length && !f.category_ids) f.category_ids = parsed.category_ids
    if (parsed.person_names.length && !f.entity_ids) f.entity_ids = parsed.person_names
    if (parsed.year_from && !f.year_from) f.year_from = parsed.year_from
    if (parsed.year_to && !f.year_to) f.year_to = parsed.year_to
    if (parsed.languages.length && !f.languages) f.languages = parsed.languages
    return { q: parsed.text, filters: f }
  }, [parsed, q, filters])

  const res = useSearchPages({ q: effective.q, filters: effective.filters, sort })
  const data = res.data
  const tokens = useMemo(() => queryTokens(effective.q || q), [effective.q, q])

  function update(patch: Record<string, string | string[] | null>) {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) {
      next.delete(k)
      if (Array.isArray(v)) v.forEach((x) => next.append(k, x))
      else if (v) next.set(k, v)
    }
    setSp(next)
  }
  const toggleIn = (k: string, v: string) => {
    const cur = sp.getAll(k)
    update({ [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    update({ q: input.trim() || null, smart: null })
  }
  const catName = (id: string) => cats.find((c) => c.id === id)?.name_ar ?? '…'
  const personName = (id: string) => data?.facets?.person.find((p) => p.key === id)?.name ?? 'شخص'

  const chips: { label: string; remove: () => void }[] = []
  filters.category_ids?.forEach((id) => chips.push({ label: catName(id), remove: () => toggleIn('cat', id) }))
  filters.doc_types?.forEach((t) => chips.push({ label: typeLabel(t), remove: () => toggleIn('type', t) }))
  filters.entity_ids?.forEach((id) => chips.push({ label: personName(id), remove: () => toggleIn('person', id) }))
  filters.languages?.forEach((l) => chips.push({ label: langLabel(l), remove: () => toggleIn('lang', l) }))
  if (filters.year_from || filters.year_to)
    chips.push({ label: filters.year_from === filters.year_to ? `${filters.year_from}` : `${filters.year_from ?? '…'} – ${filters.year_to ?? '…'}`, remove: () => update({ from: null, to: null }) })

  const facets = data?.facets
  const FacetList = () => (
    <div className="space-y-6">
      {facets?.doc_type.length ? (
        <FacetGroup title="النوع">
          {facets.doc_type.map((f) => (
            <FacetItem key={f.key} active={sp.getAll('type').includes(String(f.key))} onClick={() => toggleIn('type', String(f.key))} label={typeLabel(String(f.key))} count={f.count} />
          ))}
        </FacetGroup>
      ) : null}
      {facets?.category.length ? (
        <FacetGroup title="الرف">
          {[...facets.category]
            .sort((a, b) => b.count - a.count)
            .slice(0, 12)
            .map((f) => (
              <FacetItem key={f.key} active={sp.getAll('cat').includes(String(f.key))} onClick={() => toggleIn('cat', String(f.key))} label={catName(String(f.key))} count={f.count} />
            ))}
        </FacetGroup>
      ) : null}
      {facets?.year.length ? (
        <FacetGroup title="السنة">
          <div className="flex flex-wrap gap-1.5">
            {facets.year.map((f) => (
              <button
                key={f.key}
                onClick={() => (filters.year_from === Number(f.key) && filters.year_to === Number(f.key) ? update({ from: null, to: null }) : update({ from: String(f.key), to: String(f.key) }))}
                className={cn(
                  'num rounded-lg border px-2 py-1 text-xs',
                  filters.year_from === Number(f.key) && filters.year_to === Number(f.key) ? 'border-brand-600 bg-brand-700 text-white' : 'border-line bg-surface text-text hover:border-brand-500',
                )}
              >
                {f.key} <span className="opacity-60">{f.count}</span>
              </button>
            ))}
          </div>
        </FacetGroup>
      ) : null}
      {facets?.person.length ? (
        <FacetGroup title="الأشخاص">
          {facets.person.map((f) => (
            <FacetItem key={f.key} active={sp.getAll('person').includes(String(f.key))} onClick={() => toggleIn('person', String(f.key))} label={f.name ?? ''} count={f.count} />
          ))}
        </FacetGroup>
      ) : null}
      {facets?.language.length ? (
        <FacetGroup title="اللغة">
          {facets.language.map((f) => (
            <FacetItem key={f.key} active={sp.getAll('lang').includes(String(f.key))} onClick={() => toggleIn('lang', String(f.key))} label={langLabel(f.key)} count={f.count} />
          ))}
        </FacetGroup>
      ) : null}
      {facets?.location.length ? (
        <FacetGroup title="مكان الأصل">
          {facets.location.map((f) => (
            <FacetItem key={f.key} active={sp.get('loc') === String(f.key)} onClick={() => update({ loc: sp.get('loc') === String(f.key) ? null : String(f.key) })} label={f.name ?? ''} count={f.count} />
          ))}
        </FacetGroup>
      ) : null}
    </div>
  )

  const items = data?.items ?? []
  const allSelected = items.length > 0 && items.every((d) => selected.has(d.id))

  return (
    <div>
      <PageHeader title={q ? 'نتائج البحث' : 'كل الوثائق'} icon={SearchIcon} subtitle={data ? `${data.total} وثيقة` : undefined} />

      <form onSubmit={submit} className="relative mb-4">
        <SearchIcon className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2 text-subtle" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="اكتب كما تتذكر: «محاضرات بنعلي في الإداري 2018»"
          className="h-13 w-full rounded-2xl border border-line bg-surface py-3.5 ps-12 pe-24 text-[15px] text-ink shadow-soft outline-none placeholder:text-subtle focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15"
        />
        <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {voice.supported && (
            <button type="button" onClick={voice.start} className={cn('grid size-9 place-items-center rounded-xl', voice.on ? 'bg-danger text-white' : 'text-muted hover:bg-surface-2')} aria-label="بحث بالصوت">
              <Mic className="size-[18px]" />
            </button>
          )}
          <Button type="submit" size="sm">
            ابحث
          </Button>
        </div>
      </form>

      {(parsing || parsed) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-brass-200 bg-brass-100/60 px-4 py-3 text-sm">
          <Sparkles className={cn('size-4 text-brass-600', parsing && 'animate-pulse')} />
          {parsing ? (
            <span className="text-muted">Claude يفهم طلبك…</span>
          ) : parsed ? (
            <>
              <span className="text-text">فهمتُ:</span>
              {parsed.doc_types.map((t) => (
                <Badge key={t} tone="brass">
                  {typeLabel(t)}
                </Badge>
              ))}
              {parsed.category_ids.map((c) => (
                <Badge key={c} tone="brass">
                  {catName(c)}
                </Badge>
              ))}
              {parsed.person_names.map((p) => (
                <Badge key={p} tone="brass">
                  {personName(p)}
                </Badge>
              ))}
              {(parsed.year_from || parsed.year_to) && <Badge tone="brass">{parsed.year_from === parsed.year_to ? parsed.year_from : `${parsed.year_from ?? '…'}–${parsed.year_to ?? '…'}`}</Badge>}
              {parsed.text && <span className="text-muted">+ «{parsed.text}»</span>}
              <button className="ms-auto text-xs text-brand-600 hover:underline" onClick={() => update({ smart: '0' })}>
                ابحث بالكلمات فقط
              </button>
            </>
          ) : null}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {chips.map((c, i) => (
          <Chip key={i} active onRemove={c.remove}>
            {c.label}
          </Chip>
        ))}
        {chips.length > 0 && (
          <button className="text-xs text-muted hover:text-danger" onClick={() => update({ cat: null, type: null, person: null, lang: null, from: null, to: null, loc: null })}>
            مسح المرشحات
          </button>
        )}
        <div className="ms-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" icon={SlidersHorizontal} className="lg:hidden" onClick={() => setFiltersOpen(true)}>
            المرشحات
          </Button>
          <div className="relative">
            <ArrowUpDown className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
            <Select value={sort} onChange={(e) => update({ sort: e.target.value })} className="h-8 w-auto rounded-lg ps-7 text-[13px]">
              {SORTS.map((s) => (
                <option key={s.v} value={s.v}>
                  {s.l}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {data?.mode === 'fuzzy' && q && (
        <p className="mb-3 text-sm text-muted">
          لم أجد الكلمات حرفياً، هذه أقرب النتائج.
          {data.suggestions?.length ? (
            <>
              {' '}
              هل تقصد:{' '}
              {data.suggestions.map((s) => (
                <button key={s} className="mx-1 font-medium text-brand-600 hover:underline" onClick={() => update({ q: s })}>
                  {s}
                </button>
              ))}
            </>
          ) : null}
        </p>
      )}
      {data?.mode === 'any' && q && <p className="mb-3 text-sm text-muted">لا وثيقة تحتوي كل الكلمات؛ هذه وثائق تحتوي بعضها.</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_250px]">
        <div className="min-w-0 space-y-3">
          {items.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--brand-600)]"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? new Set(items.map((d) => d.id)) : new Set())}
                />
                تحديد الكل
              </label>
              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="num font-semibold text-ink">{selected.size} محددة</span>
                  <Button size="sm" variant="secondary" icon={Download} onClick={() => downloadZip([...selected], q || 'khizana')}>
                    تحميل ZIP
                  </Button>
                  <Button size="sm" variant="secondary" icon={FolderInput} onClick={() => setMoveOpen(true)}>
                    نقل إلى رف
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash2}
                    className="text-danger"
                    onClick={async () => {
                      const { shares, trashLinksChoice } = await import('@/lib/shares')
                      const r = await api.deleteDocs([...selected], await trashLinksChoice([...selected]))
                      // their share links were taken back with them (the owner chose so): the copies leave Drive now if Google is connected
                      if (r?.links) void shares.sweep(true)
                      toast.success(`نُقلت إلى سلة المحذوفات (تُسترجع خلال 30 يوماً)${r?.links ? '، وسُحبت روابط مشاركتها' : ''}`)
                      setSelected(new Set())
                      void qc.invalidateQueries()
                    }}
                  >
                    حذف
                  </Button>
                  <button onClick={() => setSelected(new Set())} aria-label="إلغاء التحديد" className="p-1 hover:text-ink">
                    <X className="size-4" />
                  </button>
                </div>
              )}
            </div>
          )}
          {res.isLoading ? (
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)
          ) : items.length === 0 ? (
            <Card>
              <Empty icon={SearchX} title={q ? 'لا نتائج' : 'لا وثائق بعد'}>
                {q ? 'جرّب كلمة أخرى، أو اسم الدكتور بالحروف اللاتينية، أو احذف بعض المرشحات.' : 'أضف وثائق بالمسح أو الرفع لتظهر هنا.'}
              </Empty>
            </Card>
          ) : (
            items.map((d) => (
              <DocRow
                key={d.id}
                d={d}
                tokens={tokens}
                query={effective.q || q}
                selected={selected.has(d.id)}
                onSelect={(v) =>
                  setSelected((s) => {
                    const n = new Set(s)
                    if (v) n.add(d.id)
                    else n.delete(d.id)
                    return n
                  })
                }
              />
            ))
          )}
          {data && data.total > items.length && (
            <div className="pt-2 text-center">
              <Button variant="secondary" onClick={() => void res.fetchNextPage()} loading={res.isFetchingNextPage}>
                عرض المزيد ({data.total - items.length})
              </Button>
            </div>
          )}
        </div>
        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <FacetList />
          </div>
        </aside>
      </div>

      <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title="المرشحات">
        <FacetList />
      </Dialog>
      <CategoryPicker
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title={`نقل ${selected.size} وثيقة إلى رف`}
        onPick={async (cid) => {
          await api.moveDocs([...selected], cid)
          toast.success('نُقلت الوثائق')
          setMoveOpen(false)
          setSelected(new Set())
          void qc.invalidateQueries()
        }}
      />
    </div>
  )
}

function FacetGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold tracking-wide text-subtle">{title}</h4>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function FacetItem({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-start text-[13px]', active ? 'bg-brand-700 text-white' : 'text-text hover:bg-surface-2')}>
      <span className="truncate">{label}</span>
      <span className={cn('num text-xs', active ? 'text-white/80' : 'text-subtle')}>{count}</span>
    </button>
  )
}
