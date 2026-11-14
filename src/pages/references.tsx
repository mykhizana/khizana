// «مراجعي» — every book, article, thesis, legal text, report and ruling of the archive with its reference in
// the owner's citation rules; the records still missing are prepared by Claude from the documents; the
// bibliography (Arabic first, legal texts from the highest norm down) is copied or saved as a Word file.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, ClipboardCopy, FileDown, Pencil, Search, Sparkles, Square } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { extractBib } from '@/ai/bib'
import { SONNET } from '@/ai/models'
import { AiError, BudgetError } from '@/ai/transport'
import { api } from '@/db/api'
import { BIB_KINDS, bibliography, cleanBib, fullRef, html, missing, plain, type Bib, type BibKind } from '@/lib/bib'
import { estimateCost, fmtUsd } from '@/lib/cost'
import { DOCX_TYPE, docx, type DocxPara } from '@/lib/docx'
import { useAiMode } from '@/lib/queries'
import type { RefItem } from '@/lib/types'
import { PageHeader } from '@/ui/bits'
import { saveBlob } from '@/ui/download'
import { Badge, Button, Card, IconButton, Input, Progress, Select, Skeleton } from '@/ui/kit'
import { BibEditor, RefText, copyRich, guessBib } from '@/ui/reference'

type Ready = RefItem & { bib: Bib }

const refsAr = (n: number) => (n === 0 ? 'لا مرجع جاهزاً بعد' : n === 1 ? 'مرجع واحد جاهز' : n === 2 ? 'مرجعان جاهزان' : n <= 10 ? `${n} مراجع جاهزة` : `${n} مرجعاً جاهزاً`)

export default function ReferencesPage() {
  const qc = useQueryClient()
  const ai = useAiMode().data
  const list = useQuery({ queryKey: ['references'], queryFn: () => api.references() })
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<BibKind | ''>('')
  const [editing, setEditing] = useState<RefItem | null>(null)
  const [run, setRun] = useState<{ done: number; total: number; cost: number } | null>(null)
  const stop = useRef(false)

  const items = list.data ?? []
  const ready: Ready[] = useMemo(() => items.filter((x) => x.bib).map((x) => ({ ...x, bib: cleanBib(x.bib) })), [items])
  const todo = items.filter((x) => !x.bib && x.state === 'ready')
  const match = (x: RefItem & { bib?: Bib | null }) => {
    if (kind && x.bib?.kind !== kind) return false
    if (!q.trim()) return true
    const hay = `${x.title} ${x.title_latin ?? ''} ${x.bib ? plain(fullRef(x.bib)) : ''} ${x.authors.join(' ')}`.toLowerCase()
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w))
  }
  const shown = ready.filter(match)
  const parts = bibliography(shown)

  const refresh = () => qc.invalidateQueries({ queryKey: ['references'] })
  const save = async (id: string, bib: Bib) => {
    await api.updateDoc(id, { bib }, false)
    await qc.invalidateQueries({ queryKey: ['doc', id] })
    await refresh()
  }

  const prepare = async () => {
    stop.current = false
    setRun({ done: 0, total: todo.length, cost: 0 })
    let cost = 0
    let failed = 0
    for (let i = 0; i < todo.length; i++) {
      if (stop.current) break
      try {
        const d = await api.doc(todo[i].id)
        if (d) {
          const r = await extractBib(d)
          cost += r.costUsd
          await api.updateDoc(d.id, { bib: r.bib }, false)
        }
      } catch (e) {
        failed++
        if (e instanceof BudgetError || (e instanceof AiError && (e.kind === 'credit' || e.kind === 'auth'))) {
          toast.error((e as Error).message)
          break
        }
      }
      setRun({ done: i + 1, total: todo.length, cost })
    }
    setRun(null)
    await refresh()
    toast.success(`حُضّرت المراجع (${fmtUsd(cost)})${failed ? ` · تعذّر ${failed}` : ''}: راجع كل مرجع مع وثيقته`)
  }

  const copyAll = async () => {
    const blocks = parts.map((p) => {
      const dir = p.lang === 'ar' ? 'rtl' : 'ltr'
      const secs = p.sections.map((s) => `<p dir="${dir}"><b>${s.title}</b></p>${s.items.map((x) => `<p dir="${dir}">${html(fullRef(x.bib))}</p>`).join('')}`).join('')
      return `<div dir="${dir}"><p dir="${dir}"><b>${p.title}</b></p>${secs}</div>`
    })
    const text = parts.map((p) => [p.title, ...p.sections.flatMap((s) => [s.title, ...s.items.map((x) => plain(fullRef(x.bib)))])].join('\n')).join('\n\n')
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([blocks.join('')], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
      toast.success('نُسخت لائحة المراجع: ألصقها في Word')
    } catch {
      await navigator.clipboard.writeText(text).catch(() => undefined)
      toast.success('نُسخت لائحة المراجع (نصاً)')
    }
  }

  const word = () => {
    const paras: DocxPara[] = [{ segs: [{ t: 'لائحة المراجع' }], style: 'Title', rtl: true }]
    for (const p of parts) {
      const rtl = p.lang === 'ar'
      paras.push({ segs: [{ t: p.title }], style: 'Heading1', rtl })
      for (const s of p.sections) {
        paras.push({ segs: [{ t: s.title }], style: 'Heading2', rtl })
        for (const x of s.items) paras.push({ segs: fullRef(x.bib), rtl })
      }
    }
    saveBlob(new Blob([docx(paras) as BlobPart], { type: DOCX_TYPE }), 'لائحة المراجع.docx')
  }

  const gaps = ready.filter((x) => missing(x.bib).length).length
  const unchecked = ready.filter((x) => !x.bib.checked).length
  const each = estimateCost({ chars: 12_000, outTokens: 700, model: SONNET })

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="مراجعي"
        icon={BookMarked}
        subtitle="كل كتاب ومقال وأطروحة ونص قانوني وتقرير في أرشيفك، بمرجعه على قواعد توثيقك: يُنسخ إلى Word بعناوينه المائلة، ولائحة المراجع كاملة في ملف Word."
      />

      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="brand">{refsAr(ready.length)}</Badge>
          {todo.length > 0 && <Badge tone="neutral">{todo.length} دون مرجع بعد</Badge>}
          {gaps > 0 && <Badge tone="warning">{gaps} تنقصه بيانات</Badge>}
          {unchecked > 0 && <Badge tone="warning">{unchecked} لم تراجعه بعد</Badge>}
        </div>
        {run ? (
          <div className="mt-4">
            <Progress value={run.done / Math.max(run.total, 1)} />
            <div className="mt-2 flex items-center justify-between text-xs text-muted">
              <span>
                {run.done} / {run.total} · {fmtUsd(run.cost)}
              </span>
              <Button size="sm" variant="ghost" icon={Square} onClick={() => (stop.current = true)}>
                أوقف
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {ai === 'claude' && todo.length > 0 && (
              <Button icon={Sparkles} onClick={() => void prepare()}>
                حضّر الناقصة ({todo.length}) · نحو {fmtUsd(each * todo.length)}
              </Button>
            )}
            <Button variant="secondary" icon={ClipboardCopy} disabled={!shown.length} onClick={() => void copyAll()}>
              انسخ لائحة المراجع
            </Button>
            <Button variant="secondary" icon={FileDown} disabled={!shown.length} onClick={word}>
              لائحة المراجع (Word)
            </Button>
          </div>
        )}
        <p className="mt-3 text-xs leading-relaxed text-muted">
          يستخرج Claude ما تُظهره الوثيقة فقط (صفحة العنوان، الغلاف، رأس الجريدة الرسمية…) ولا يخمّن: ما لا يظهر يبقى بين [؟ …] لتكمله من مصدر موثوق. راجع كل مرجع مع وثيقته قبل استعماله.
        </p>
      </Card>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث في المراجع: مؤلف، عنوان، سنة…" className="ps-9" dir="auto" />
        </div>
        <Select value={kind} onChange={(e) => setKind(e.target.value as BibKind | '')} className="w-44">
          <option value="">كل الأنواع</option>
          {BIB_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.ar}
            </option>
          ))}
        </Select>
      </div>

      {list.isLoading ? (
        <Skeleton className="h-60" />
      ) : !items.length ? (
        <Card className="p-6 text-center text-sm leading-relaxed text-muted">لا كتاب ولا مقال ولا نص قانوني في أرشيفك بعد. حين تضيف مراجعك تظهر هنا بمراجعها الجاهزة.</Card>
      ) : (
        <>
          {parts.map((p) => (
            <section key={p.lang} dir={p.lang === 'ar' ? 'rtl' : 'ltr'} className="space-y-4">
              <h2 className="font-display text-xl text-ink">{p.title}</h2>
              {p.sections.map((s) => (
                <div key={s.title}>
                  <h3 className="mb-2 text-sm font-semibold text-brand-700 dark:text-brand-200">{s.title}</h3>
                  <ul className="space-y-2">
                    {s.items.map((x) => (
                      <li key={x.id} className="flex items-start gap-2 rounded-xl border border-line bg-surface p-3">
                        <div className="min-w-0 flex-1 text-[14px] leading-7 text-ink">
                          <RefText segs={fullRef(x.bib)} />
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" dir="rtl">
                            <Link to={`/doc/${x.id}`} className="text-brand-700 hover:underline dark:text-brand-200">
                              افتح الوثيقة
                            </Link>
                            {!x.bib.checked && <span className="text-warning">· لم تُراجَع</span>}
                          </div>
                        </div>
                        <IconButton icon={ClipboardCopy} label="انسخ" size="sm" onClick={() => void copyRich(fullRef(x.bib), x.bib.lang !== 'latin')} />
                        <IconButton icon={Pencil} label="عدّل" size="sm" onClick={() => setEditing(x)} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
          {todo.filter(match).length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink">دون مرجع بعد</h2>
              <ul className="space-y-1.5">
                {todo.filter(match).map((x) => (
                  <li key={x.id} className="flex items-center gap-2 rounded-xl border border-dashed border-line p-2.5 text-sm">
                    <Link to={`/doc/${x.id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
                      {x.title}
                    </Link>
                    <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(x)}>
                      اكتبه
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {editing && (
        <BibEditor
          key={editing.id}
          open
          onClose={() => setEditing(null)}
          initial={editing.bib ? cleanBib(editing.bib) : guessBib({ doc_type: editing.doc_type, title: editing.title_latin, title_ar: editing.title, languages: editing.languages, doc_date: editing.doc_date, entities: [] })}
          onSave={(b) => save(editing.id, b)}
        />
      )}
    </div>
  )
}
