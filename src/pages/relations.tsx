// «خريطة العلاقات» — who is linked to whom in the documents: people, bodies and places as points, a
// line between two of them when they appear in the same documents (thicker: more documents). A tap on a
// point shows its links and, for each, the documents behind it. Nothing leaves the device.
import { useQuery } from '@tanstack/react-query'
import { Building2, Crosshair, FileText, MapPin, Maximize2, Minus, Network, Plus, Search, User, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api } from '@/db/api'
import { docsAr, fmtDate } from '@/lib/format'
import { layout, neighbours } from '@/lib/graph'
import { typeIcon } from '@/lib/labels'
import type { GraphNode } from '@/lib/types'
import { PageHeader } from '@/ui/bits'
import { Badge, Button, Card, Chip, IconButton, Input, Segmented, Skeleton, Spinner, cn } from '@/ui/kit'

const SIZE = 1000
const KINDS = [
  { key: 'person', label: 'الأشخاص', icon: User, color: 'var(--color-brand-600)' },
  { key: 'org', label: 'الجهات', icon: Building2, color: 'var(--color-brass-500)' },
  { key: 'place', label: 'الأماكن', icon: MapPin, color: 'var(--color-info)' },
] as const
const colorOf = (k: GraphNode['kind']) => KINDS.find((x) => x.key === k)?.color ?? 'var(--color-muted)'
const radius = (n: number) => Math.min(26, 6 + 3 * Math.sqrt(n))
const nameOf = (n: GraphNode) => `${n.honorific ? `${n.honorific} ` : ''}${n.name}`

function Shared({ a, b }: { a: string; b: string }) {
  const q = useQuery({ queryKey: ['pair', a, b], queryFn: () => api.entityPair(a, b) })
  if (q.isLoading) return <Spinner className="my-2 size-4" />
  return (
    <ul className="mt-1.5 space-y-1">
      {(q.data ?? []).map((d) => {
        const Icon = typeIcon(d.doc_type)
        return (
          <li key={d.id}>
            <Link to={`/doc/${d.id}`} className="flex items-center gap-1.5 text-xs text-brand-700 hover:underline dark:text-brand-200">
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{d.title}</span>
              {d.doc_date && <span className="num shrink-0 text-muted">· {fmtDate(d.doc_date)}</span>}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export default function RelationsPage() {
  const [params, setParams] = useSearchParams()
  const center = params.get('center')
  const [kinds, setKinds] = useState<string[]>(['person', 'org', 'place'])
  const [limit, setLimit] = useState<'40' | '80' | '150'>('80')
  const [selected, setSelected] = useState<string | null>(center)
  const [open, setOpen] = useState<string | null>(null)
  const [find, setFind] = useState('')
  const [view, setView] = useState({ x: 0, y: 0, w: SIZE })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const svg = useRef<SVGSVGElement>(null)

  const g = useQuery({
    queryKey: ['graph', kinds.join(','), limit, center],
    queryFn: () => api.entityGraph({ kinds: kinds.join(','), limit: Number(limit), center }),
  })
  const nodes = g.data?.nodes ?? []
  const edges = g.data?.edges ?? []
  const pos = useMemo(() => layout(nodes, edges, { size: SIZE }), [g.data])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [g.data])
  useEffect(() => setView({ x: 0, y: 0, w: SIZE }), [g.data])
  useEffect(() => setSelected(center), [center])

  const near = useMemo(() => (selected ? neighbours(selected, edges) : []), [selected, g.data])
  const nearSet = new Set(near.map((x) => x.id))
  const labelled = new Set(nodes.slice(0, 14).map((n) => n.id))
  if (selected) {
    labelled.add(selected)
    near.slice(0, 12).forEach((x) => labelled.add(x.id))
  }
  const sel = selected ? byId.get(selected) : null

  // pan by dragging, zoom with the wheel or the buttons
  const zoom = (f: number, at?: { x: number; y: number }) =>
    setView((v) => {
      const w = Math.min(SIZE * 1.5, Math.max(SIZE / 8, v.w * f))
      const c = at ?? { x: v.x + v.w / 2, y: v.y + v.w / 2 }
      return { w, x: c.x - ((c.x - v.x) * w) / v.w, y: c.y - ((c.y - v.y) * w) / v.w }
    })
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      setView((v) => {
        const at = { x: v.x + ((e.clientX - r.left) / r.width) * v.w, y: v.y + ((e.clientY - r.top) / r.height) * v.w }
        const w = Math.min(SIZE * 1.5, Math.max(SIZE / 8, v.w * (e.deltaY > 0 ? 1.15 : 1 / 1.15)))
        return { w, x: at.x - ((at.x - v.x) * w) / v.w, y: at.y - ((at.y - v.y) * w) / v.w }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [g.data])
  const down = (e: RPointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const move = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d || !svg.current) return
    const r = svg.current.getBoundingClientRect()
    const mx = ((e.clientX - d.x) / r.width) * view.w
    const my = ((e.clientY - d.y) / r.height) * view.w
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true
    if (d.moved) setView((v) => ({ ...v, x: d.vx - mx, y: d.vy - my }))
  }
  const up = () => setTimeout(() => (drag.current = null), 0)
  const pick = (id: string) => {
    if (drag.current?.moved) return
    setSelected((s) => (s === id ? null : id))
    setOpen(null)
  }

  const found = find.trim() ? nodes.filter((n) => `${n.name} ${n.name_latin ?? ''}`.toLowerCase().includes(find.trim().toLowerCase())).slice(0, 6) : []

  return (
    <div className="space-y-4">
      <PageHeader
        title="خريطة العلاقات"
        icon={Network}
        subtitle="من يرتبط بمن في وثائقك: الأشخاص والجهات والأماكن نقاطاً، وخطٌّ بين اثنين كلما وردا في وثيقة واحدة (أسمك: وثائق أكثر). اضغط نقطة لترى صلاتها والوثائق التي تجمعها."
      />

      <div className="flex flex-wrap items-center gap-2">
        {KINDS.map((k) => (
          <Chip key={k.key} icon={k.icon} active={kinds.includes(k.key)} onClick={() => setKinds((ks) => (ks.includes(k.key) ? (ks.length > 1 ? ks.filter((x) => x !== k.key) : ks) : [...ks, k.key]))}>
            {k.label}
          </Chip>
        ))}
        <Segmented
          value={limit}
          onChange={setLimit}
          options={[
            { value: '40', label: '40' },
            { value: '80', label: '80' },
            { value: '150', label: '150' },
          ]}
        />
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted" />
          <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="ابحث عن اسم في الخريطة" className="ps-9" dir="auto" />
          {found.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-10 mt-1 rounded-xl border border-line bg-surface p-1 shadow-pop">
              {found.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg px-2.5 py-1.5 text-start text-sm hover:bg-surface-2"
                    onClick={() => {
                      setSelected(n.id)
                      setFind('')
                      const p = pos.get(n.id)
                      if (p) setView({ w: SIZE / 2.5, x: p.x - SIZE / 5, y: p.y - SIZE / 5 })
                    }}
                  >
                    {nameOf(n)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {center && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="brand" icon={Crosshair}>
            حول: {byId.get(center)?.name ?? '…'}
          </Badge>
          <button type="button" className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink" onClick={() => setParams({})}>
            <X className="size-3.5" /> الخريطة كلها
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="relative overflow-hidden p-0 lg:col-span-2">
          {g.isLoading ? (
            <Skeleton className="aspect-square w-full" />
          ) : !nodes.length ? (
            <div className="grid aspect-square place-items-center p-8 text-center text-sm leading-relaxed text-muted">
              {center ? (
                <span>
                  لا صلات تظهر لهذا الاسم بهذه المرشحات: قد ترد صلاته في وثائق الخزنة المقفلة، أو في نوع أخفيته أعلاه.{' '}
                  <button type="button" className="text-brand-700 underline dark:text-brand-200" onClick={() => setParams({})}>
                    اعرض الخريطة كلها
                  </button>
                </span>
              ) : kinds.length < KINDS.length ? (
                'لا شيء بهذه المرشحات: أظهر الأنواع الأخرى أعلاه.'
              ) : (
                'لا أشخاص ولا جهات بعد: تظهر هنا حين يقرأ Claude وثائقك ويتعرّف على من فيها.'
              )}
            </div>
          ) : (
            <>
              <svg
                ref={svg}
                viewBox={`${view.x} ${view.y} ${view.w} ${view.w}`}
                className="aspect-square w-full touch-none select-none bg-surface"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerLeave={up}
                role="img"
                aria-label="خريطة العلاقات"
              >
                <g>
                  {edges.map((e) => {
                    const a = pos.get(e.s)
                    const b = pos.get(e.t)
                    if (!a || !b) return null
                    const on = selected && (e.s === selected || e.t === selected)
                    return (
                      <line
                        key={`${e.s}-${e.t}`}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke={on ? 'var(--color-brand-600)' : 'var(--color-muted)'}
                        strokeOpacity={selected && !on ? 0.12 : on ? 0.9 : 0.35}
                        strokeWidth={Math.min(9, 1 + Math.log2(1 + e.w) * 1.4) * (view.w / SIZE)}
                      />
                    )
                  })}
                </g>
                <g>
                  {nodes.map((n) => {
                    const p = pos.get(n.id)
                    if (!p) return null
                    const r = radius(n.count) * Math.max(0.6, view.w / SIZE)
                    const dim = selected && n.id !== selected && !nearSet.has(n.id)
                    return (
                      <g key={n.id} transform={`translate(${p.x} ${p.y})`} className="cursor-pointer" opacity={dim ? 0.3 : 1} onClick={() => pick(n.id)}>
                        <circle r={r} fill={colorOf(n.kind)} stroke={n.id === selected ? 'var(--color-ink)' : 'var(--color-surface)'} strokeWidth={(n.id === selected ? 4 : 2) * (view.w / SIZE)} />
                        {labelled.has(n.id) && (
                          <text
                            y={r + 16 * (view.w / SIZE)}
                            textAnchor="middle"
                            fontSize={15 * (view.w / SIZE)}
                            fill="var(--color-ink)"
                            stroke="var(--color-surface)"
                            strokeWidth={4 * (view.w / SIZE)}
                            paintOrder="stroke"
                            style={{ fontWeight: n.id === selected ? 700 : 500 }}
                          >
                            {n.name.length > 28 ? `${n.name.slice(0, 27)}…` : n.name}
                          </text>
                        )}
                      </g>
                    )
                  })}
                </g>
              </svg>
              <div className="absolute bottom-3 start-3 flex flex-col gap-1 rounded-xl border border-line bg-surface/90 p-1 shadow-soft">
                <IconButton icon={Plus} label="قرّب" size="sm" onClick={() => zoom(1 / 1.4)} />
                <IconButton icon={Minus} label="بعّد" size="sm" onClick={() => zoom(1.4)} />
                <IconButton icon={Maximize2} label="الخريطة كلها" size="sm" onClick={() => setView({ x: 0, y: 0, w: SIZE })} />
              </div>
              <div className="absolute end-3 top-3 flex flex-wrap gap-2 rounded-xl bg-surface/85 px-2.5 py-1.5 text-[11px] text-muted">
                {KINDS.map((k) => (
                  <span key={k.key} className="inline-flex items-center gap-1">
                    <span className="size-2.5 rounded-full" style={{ background: k.color }} /> {k.label}
                  </span>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card className="p-5">
          {!sel ? (
            <div className="text-sm leading-relaxed text-muted">
              <p>اضغط نقطة في الخريطة لترى من يرتبط بها، والوثائق التي تجمعهما.</p>
              {nodes.length > 0 && (
                <p className="mt-3">
                  في الخريطة <span className="num">{nodes.length}</span> نقطة و<span className="num">{edges.length}</span> صلة. اسحب لتتنقل، واستعمل العجلة أو الأزرار للتقريب.
                </p>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-start gap-3">
                <span className="mt-1 size-3 shrink-0 rounded-full" style={{ background: colorOf(sel.kind) }} />
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold text-ink">{nameOf(sel)}</h2>
                  {sel.name_latin && <p className="text-xs text-muted" dir="ltr">{sel.name_latin}</p>}
                  <p className="mt-0.5 text-xs text-muted">{docsAr(sel.count)}</p>
                </div>
                <IconButton icon={X} label="إغلاق" size="sm" onClick={() => setSelected(null)} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={`/people/${sel.id}`} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-ink hover:bg-surface-2">
                  <FileText className="size-3.5" /> صفحته ووثائقه
                </Link>
                {center !== sel.id && (
                  <Button size="sm" variant="ghost" icon={Crosshair} onClick={() => setParams({ center: sel.id })}>
                    ركّز الخريطة عليه
                  </Button>
                )}
              </div>
              <h3 className="mb-1.5 mt-4 text-xs font-semibold text-muted">صلاته ({near.length})</h3>
              <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
                {near.map((x) => {
                  const n = byId.get(x.id)
                  if (!n) return null
                  return (
                    <li key={x.id} className="rounded-lg border border-line">
                      <button type="button" className={cn('flex w-full items-center gap-2 px-2.5 py-1.5 text-start text-sm', open === x.id && 'bg-surface-2')} onClick={() => setOpen(open === x.id ? null : x.id)}>
                        <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf(n.kind) }} />
                        <span className="min-w-0 flex-1 truncate text-ink">{nameOf(n)}</span>
                        <span className="num shrink-0 text-xs text-muted">{x.w}</span>
                      </button>
                      {open === x.id && (
                        <div className="px-2.5 pb-2">
                          <Shared a={sel.id} b={x.id} />
                        </div>
                      )}
                    </li>
                  )
                })}
                {!near.length && <li className="text-xs text-muted">لا صلة له بغيره في هذه الخريطة.</li>}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
