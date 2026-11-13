// Choosing a shelf (category) or the place of a paper original.
import { ChevronDown, ChevronLeft, FolderPlus, MapPin, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/db/api'
import { categoryIcon, LOCATION_KINDS } from '@/lib/labels'
import { norm } from '@/lib/norm'
import { useCategories, useLocations } from '@/lib/queries'
import type { Category } from '@/lib/types'
import { Button, Dialog, Field, Input, Select, cn } from './kit'

export function buildTree(cats: Category[]) {
  const children = new Map<string | null, Category[]>()
  for (const c of cats) {
    const k = c.parent_id ?? null
    if (!children.has(k)) children.set(k, [])
    children.get(k)!.push(c)
  }
  for (const list of children.values()) list.sort((a, b) => a.sort - b.sort || a.name_ar.localeCompare(b.name_ar, 'ar'))
  const totals = new Map<string, number>()
  const total = (id: string): number => {
    if (totals.has(id)) return totals.get(id)!
    const c = cats.find((x) => x.id === id)
    const t = (c?.doc_count ?? 0) + (children.get(id) ?? []).reduce((s, k) => s + total(k.id), 0)
    totals.set(id, t)
    return t
  }
  return { children, total }
}

export function CategoryPicker({ open, onClose, onPick, title = 'اختر رفاً', allowNone, exclude }: { open: boolean; onClose: () => void; onPick: (id: string | null) => void; title?: string; allowNone?: boolean; exclude?: string }) {
  const cats = (useCategories().data ?? []).filter((c) => c.id !== exclude)
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<{ parent: string | null; name: string } | null>(null)
  const { children } = useMemo(() => buildTree(cats), [cats])
  const nq = norm(q)
  const matches = nq ? cats.filter((c) => [c.name_ar, c.name_fr, c.name_es, c.name_en].some((n) => norm(n).includes(nq))) : null

  const Row = ({ c, depth }: { c: Category; depth: number }) => {
    const kids = children.get(c.id) ?? []
    const isOpen = openIds.has(c.id)
    const Icon = categoryIcon(c.icon)
    return (
      <div>
        <div className="flex items-center gap-1" style={{ paddingInlineStart: depth * 18 }}>
          <button
            className={cn('grid size-7 place-items-center rounded-lg text-subtle hover:bg-surface-2', !kids.length && 'invisible')}
            onClick={() =>
              setOpenIds((s) => {
                const n = new Set(s)
                if (n.has(c.id)) n.delete(c.id)
                else n.add(c.id)
                return n
              })
            }
            aria-label="فتح"
          >
            {isOpen ? <ChevronDown className="size-4" /> : <ChevronLeft className="size-4" />}
          </button>
          <button onClick={() => onPick(c.id)} className="flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-start text-sm hover:bg-brand-50">
            <Icon className="size-4 text-brand-600" />
            <span className="flex-1">{c.name_ar}</span>
          </button>
          <button className="grid size-7 place-items-center rounded-lg text-subtle hover:bg-surface-2 hover:text-brand-600" title="رف فرعي جديد هنا" onClick={() => setCreating({ parent: c.id, name: '' })}>
            <FolderPlus className="size-4" />
          </button>
        </div>
        {isOpen && kids.map((k) => <Row key={k.id} c={k} depth={depth + 1} />)}
      </div>
    )
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث عن رف…" className="ps-9" />
      </div>
      <div className="max-h-[50vh] overflow-y-auto">
        {allowNone && (
          <button onClick={() => onPick(null)} className="mb-1 w-full rounded-lg px-3 py-2 text-start text-sm text-muted hover:bg-surface-2">
            بدون رف (غير مصنفة)
          </button>
        )}
        {matches
          ? matches.map((c) => (
              <button key={c.id} onClick={() => onPick(c.id)} className="block w-full rounded-lg px-3 py-2 text-start text-sm hover:bg-brand-50">
                {c.name_ar}
              </button>
            ))
          : (children.get(null) ?? []).map((c) => <Row key={c.id} c={c} depth={0} />)}
      </div>
      {creating ? (
        <form
          className="mt-3 flex gap-2 border-t border-line pt-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!creating.name.trim()) return
            const c = await api.categorySave({ name_ar: creating.name.trim(), parent_id: creating.parent })
            await qc.invalidateQueries({ queryKey: ['categories'] })
            toast.success(`أُنشئ الرف «${c.name_ar}»`)
            setCreating(null)
            onPick(c.id)
          }}
        >
          <Input autoFocus value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder={creating.parent ? 'اسم الرف الفرعي' : 'اسم الرف'} />
          <Button type="submit">إنشاء</Button>
        </form>
      ) : (
        <Button variant="ghost" size="sm" icon={Plus} className="mt-2" onClick={() => setCreating({ parent: null, name: '' })}>
          رف رئيسي جديد
        </Button>
      )}
    </Dialog>
  )
}

export function LocationPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string | null) => void }) {
  const locs = useLocations().data ?? []
  const qc = useQueryClient()
  const [form, setForm] = useState<{ name: string; kind: string; place: string } | null>(null)
  return (
    <Dialog open={open} onClose={onClose} title="أين الورقة الأصلية؟">
      <div className="max-h-[45vh] space-y-1 overflow-y-auto">
        <button onClick={() => onPick(null)} className="w-full rounded-lg px-3 py-2 text-start text-sm text-muted hover:bg-surface-2">
          غير محدد
        </button>
        {locs.map((l) => (
          <button key={l.id} onClick={() => onPick(l.id)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm hover:bg-brand-50">
            <MapPin className="size-4 text-brand-600" />
            <span className="flex-1">
              {l.name}
              {l.place ? <span className="text-muted"> — {l.place}</span> : null}
            </span>
            <span className="num rounded bg-surface-2 px-1.5 text-[11px] text-muted">{l.code}</span>
          </button>
        ))}
      </div>
      {form ? (
        <form
          className="mt-3 space-y-3 border-t border-line pt-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!form.name.trim()) return
            const l = await api.locationSave({ name: form.name.trim(), kind: form.kind, place: form.place })
            await qc.invalidateQueries({ queryKey: ['locations'] })
            setForm(null)
            onPick(l.id)
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="الاسم">
              <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="صندوق 1" />
            </Field>
            <Field label="النوع">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {Object.entries(LOCATION_KINDS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="المكان">
            <Input value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} placeholder="بيت العائلة — تطوان" />
          </Field>
          <Button type="submit" className="w-full">
            إضافة واختيار
          </Button>
        </form>
      ) : (
        <Button variant="ghost" size="sm" icon={Plus} className="mt-2" onClick={() => setForm({ name: `صندوق ${locs.length + 1}`, kind: 'box', place: '' })}>
          مكان جديد
        </Button>
      )}
    </Dialog>
  )
}
