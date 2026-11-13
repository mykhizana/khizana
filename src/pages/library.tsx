import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, FolderOpen, FolderPlus, Heart, Inbox, Library, Merge, MoreHorizontal, Pencil, Trash2, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { categoryIcon, langLabel, typeIcon, typeLabel } from '@/lib/labels'
import { allIds, useCategories, useCounts, useSearch, useSearchPages } from '@/lib/queries'
import type { Category, SearchFilters } from '@/lib/types'
import { DocRow, PageHeader } from '@/ui/bits'
import { Button, Card, Dialog, Empty, Field, IconButton, Input, Menu, MenuItem, Segmented, Skeleton, cn } from '@/ui/kit'
import { buildTree, CategoryPicker } from '@/ui/pickers'

type View = 'shelves' | 'types' | 'years' | 'languages'

export default function LibraryPage() {
  const [sp, setSp] = useSearchParams()
  const qc = useQueryClient()
  const cats = useCategories().data
  const counts = useCounts().data
  const [view, setView] = useState<View>('shelves')
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id?: string; parent_id: string | null; name_ar: string; name_fr: string; name_es: string; name_en: string } | null>(null)
  const [merging, setMerging] = useState<Category | null>(null)

  const cat = sp.get('cat')
  const special = sp.get('special') // uncategorized | favorites | trash
  const type = sp.get('type')
  const year = sp.get('year')
  const lang = sp.get('lang')

  const filters: SearchFilters = {}
  if (cat) filters.category_ids = [cat]
  if (special === 'uncategorized') filters.uncategorized = true
  if (special === 'favorites') filters.favorite = true
  if (special === 'trash') filters.deleted = true
  if (type) filters.doc_types = [type]
  if (year) {
    filters.year_from = Number(year)
    filters.year_to = Number(year)
  }
  if (lang) filters.languages = [lang]

  const docs = useSearchPages({ filters, sort: 'doc_date' })
  const all = useSearch({ filters: {}, limit: 1, facets: true })
  const tree = useMemo(() => buildTree(cats ?? []), [cats])
  const current = cats?.find((c) => c.id === cat)

  const select = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams()
    for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v)
    setSp(n)
  }

  const Node = ({ c, depth }: { c: Category; depth: number }) => {
    const kids = tree.children.get(c.id) ?? []
    const isOpen = openIds.has(c.id) || (cat ? isAncestor(c.id, cat) : false)
    const Icon = categoryIcon(c.icon)
    const total = tree.total(c.id)
    return (
      <div>
        <div className={cn('group flex items-center gap-0.5 rounded-xl', cat === c.id ? 'bg-brand-700 text-white' : 'hover:bg-surface-2')} style={{ paddingInlineStart: depth * 14 }}>
          <button
            className={cn('grid size-7 shrink-0 place-items-center rounded-lg', !kids.length && 'invisible', cat === c.id ? 'text-white/80' : 'text-subtle')}
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
          <button onClick={() => select({ cat: c.id })} className="flex min-w-0 flex-1 items-center gap-2 py-2 text-start text-sm">
            <Icon className={cn('size-4 shrink-0', cat === c.id ? 'text-white' : 'text-brand-600')} />
            <span className="truncate">{c.name_ar}</span>
            {c.origin === 'ai' && <span className={cn('rounded px-1 text-[10px]', cat === c.id ? 'bg-white/20' : 'bg-brass-100 text-brass-700')}>مقترح</span>}
          </button>
          <span className={cn('num px-1 text-xs', cat === c.id ? 'text-white/80' : 'text-subtle')}>{total}</span>
          <Menu trigger={(t) => <IconButton icon={MoreHorizontal} label="خيارات" size="sm" onClick={t} className={cn('opacity-0 group-hover:opacity-100', cat === c.id && 'text-white opacity-100 hover:bg-white/10')} />}>
            {(close) => (
              <>
                <MenuItem icon={FolderPlus} onClick={() => (close(), setEditing({ parent_id: c.id, name_ar: '', name_fr: '', name_es: '', name_en: '' }))}>
                  رف فرعي جديد
                </MenuItem>
                <MenuItem icon={Pencil} onClick={() => (close(), setEditing({ id: c.id, parent_id: c.parent_id, name_ar: c.name_ar, name_fr: c.name_fr ?? '', name_es: c.name_es ?? '', name_en: c.name_en ?? '' }))}>
                  إعادة التسمية
                </MenuItem>
                <MenuItem icon={Merge} onClick={() => (close(), setMerging(c))}>
                  دمجه في رف آخر
                </MenuItem>
                <MenuItem
                  icon={Trash2}
                  danger
                  onClick={async () => {
                    close()
                    await api.categoryDelete(c.id)
                    toast.success(`حُذف الرف «${c.name_ar}» ونُقلت وثائقه إلى الرف الأعلى`)
                    await qc.invalidateQueries()
                  }}
                >
                  حذف الرف (لا تُحذف الوثائق)
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
        {isOpen && kids.map((k) => <Node key={k.id} c={k} depth={depth + 1} />)}
      </div>
    )
  }

  function isAncestor(a: string, of: string): boolean {
    let cur = cats?.find((c) => c.id === of)
    let guard = 0
    while (cur?.parent_id && guard++ < 12) {
      if (cur.parent_id === a) return true
      cur = cats?.find((c) => c.id === cur!.parent_id)
    }
    return false
  }

  const facets = all.data?.facets
  const heading = current?.name_ar ?? (special === 'uncategorized' ? 'غير مصنفة' : special === 'favorites' ? 'المفضلة' : special === 'trash' ? 'سلة المحذوفات' : type ? typeLabel(type) : year ? `سنة ${year}` : lang ? langLabel(lang) : 'كل الوثائق')

  return (
    <div>
      <PageHeader
        title="المكتبة"
        icon={Library}
        subtitle="الوثيقة محفوظة مرة واحدة وتظهر في كل رف يخصها."
        actions={
          <Button variant="secondary" icon={FolderPlus} onClick={() => setEditing({ parent_id: cat, name_ar: '', name_fr: '', name_es: '', name_en: '' })}>
            رف جديد
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[290px_1fr]">
        <aside className="space-y-4">
          <Segmented
            value={view}
            onChange={setView}
            className="w-full justify-between"
            options={[
              { value: 'shelves', label: 'الرفوف' },
              { value: 'types', label: 'الأنواع' },
              { value: 'years', label: 'السنوات' },
              { value: 'languages', label: 'اللغات' },
            ]}
          />
          <Card className="max-h-[70vh] overflow-y-auto p-2">
            {view === 'shelves' &&
              (cats ? (
                <>
                  <button onClick={() => select({})} className={cn('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm', !cat && !special && !type && !year && !lang ? 'bg-brand-700 text-white' : 'hover:bg-surface-2')}>
                    <FolderOpen className="size-4" /> كل الوثائق <span className="num ms-auto text-xs opacity-70">{counts?.documents ?? ''}</span>
                  </button>
                  {(tree.children.get(null) ?? []).map((c) => (
                    <Node key={c.id} c={c} depth={0} />
                  ))}
                  <div className="my-2 border-t border-line" />
                  {[
                    { k: 'uncategorized', l: 'غير مصنفة', I: Inbox },
                    { k: 'favorites', l: 'المفضلة', I: Heart },
                    { k: 'trash', l: `سلة المحذوفات`, I: Trash2, n: counts?.trash },
                  ].map((x) => (
                    <button key={x.k} onClick={() => select({ special: x.k })} className={cn('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm', special === x.k ? 'bg-brand-700 text-white' : 'text-muted hover:bg-surface-2')}>
                      <x.I className="size-4" /> {x.l}
                      {x.n ? <span className="num ms-auto text-xs">{x.n}</span> : null}
                    </button>
                  ))}
                </>
              ) : (
                <Skeleton className="h-64" />
              ))}
            {view === 'types' &&
              facets?.doc_type.map((f) => {
                const I = typeIcon(String(f.key))
                return (
                  <button key={f.key} onClick={() => select({ type: String(f.key) })} className={cn('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm', type === f.key ? 'bg-brand-700 text-white' : 'hover:bg-surface-2')}>
                    <I className="size-4" /> {typeLabel(String(f.key))} <span className="num ms-auto text-xs opacity-70">{f.count}</span>
                  </button>
                )
              })}
            {view === 'years' && (
              <div className="grid grid-cols-3 gap-1.5 p-1">
                {facets?.year.map((f) => (
                  <button key={f.key} onClick={() => select({ year: String(f.key) })} className={cn('num rounded-xl border px-2 py-2 text-sm', year === String(f.key) ? 'border-brand-600 bg-brand-700 text-white' : 'border-line hover:border-brand-500')}>
                    {f.key}
                    <span className="block text-[11px] opacity-60">{f.count}</span>
                  </button>
                ))}
              </div>
            )}
            {view === 'languages' &&
              facets?.language.map((f) => (
                <button key={f.key} onClick={() => select({ lang: String(f.key) })} className={cn('flex w-full items-center rounded-xl px-3 py-2 text-sm', lang === f.key ? 'bg-brand-700 text-white' : 'hover:bg-surface-2')}>
                  {langLabel(f.key)} <span className="num ms-auto text-xs opacity-70">{f.count}</span>
                </button>
              ))}
          </Card>
        </aside>

        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-ink">
              {heading} <span className="num text-sm font-normal text-muted">({docs.data?.total ?? '…'})</span>
            </h2>
            {special === 'trash' && (docs.data?.total ?? 0) > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-danger"
                icon={Trash2}
                onClick={async () => {
                  if (!confirm('حذف كل ما في السلة نهائياً؟ لا يمكن التراجع.')) return
                  const ids = await allIds({ deleted: true })
                  const r = await api.purgeDocs({ ids })
                  const { files } = await import('@/db/files')
                  await files.remove(r.paths)
                  toast.success(`حُذفت ${r.count} وثيقة نهائياً`)
                  await qc.invalidateQueries()
                }}
              >
                إفراغ السلة
              </Button>
            )}
          </div>
          <div className="space-y-3">
            {docs.isLoading ? (
              Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)
            ) : docs.data?.items.length ? (
              docs.data.items.map((d) => (
                <DocRow
                  key={d.id}
                  d={d}
                  extra={
                    special === 'trash' ? (
                      <button
                        className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
                        onClick={async (e) => {
                          e.preventDefault()
                          await api.restoreDoc(d.id)
                          await qc.invalidateQueries()
                        }}
                      >
                        <Undo2 className="size-3.5" /> استرجاع
                      </button>
                    ) : undefined
                  }
                />
              ))
            ) : (
              <Card>
                <Empty icon={FolderOpen} title="لا وثائق هنا بعد" />
              </Card>
            )}
            {docs.data && docs.data.total > docs.data.items.length && (
              <div className="text-center">
                <Button variant="secondary" onClick={() => void docs.fetchNextPage()} loading={docs.isFetchingNextPage}>
                  عرض المزيد
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'إعادة تسمية الرف' : 'رف جديد'}
        footer={
          <Button
            onClick={async () => {
              if (!editing?.name_ar.trim()) return
              await api.categorySave({ ...editing, id: editing.id, name_ar: editing.name_ar.trim() } as Category)
              await qc.invalidateQueries()
              toast.success('حُفظ')
              setEditing(null)
            }}
          >
            حفظ
          </Button>
        }
      >
        {editing && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="الاسم بالعربية" className="sm:col-span-2">
              <Input autoFocus value={editing.name_ar} onChange={(e) => setEditing({ ...editing, name_ar: e.target.value })} />
            </Field>
            <Field label="بالفرنسية">
              <Input dir="ltr" value={editing.name_fr} onChange={(e) => setEditing({ ...editing, name_fr: e.target.value })} />
            </Field>
            <Field label="بالإسبانية">
              <Input dir="ltr" value={editing.name_es} onChange={(e) => setEditing({ ...editing, name_es: e.target.value })} />
            </Field>
            <p className="text-xs text-muted sm:col-span-2">الأسماء بالفرنسية والإسبانية تجعل البحث يجد الرف بكل اللغات.</p>
          </div>
        )}
      </Dialog>
      <CategoryPicker
        open={!!merging}
        onClose={() => setMerging(null)}
        exclude={merging?.id}
        title={`دمج «${merging?.name_ar}» في…`}
        onPick={async (into) => {
          if (!merging || !into) return
          try {
            await api.categoryMerge(merging.id, into)
            toast.success('دُمج الرفان')
          } catch (e) {
            toast.error((e as Error).message)
          }
          setMerging(null)
          await qc.invalidateQueries()
        }}
      />
    </div>
  )
}
