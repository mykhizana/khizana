// «المرجع بأسلوبك» on a research document, and the record editor: the reference in the owner's citation
// rules (src/lib/bib.ts), copied with its italics (Word keeps them), in its four forms.
import { useQueryClient } from '@tanstack/react-query'
import { BookMarked, Check, ClipboardCopy, Pencil, Plus, Sparkles, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { extractBib } from '@/ai/bib'
import { api } from '@/db/api'
import { BIB_KINDS, RESEARCH_TYPES, citedBy, cleanBib, firstCite, fullRef, html, ibid, kindOfType, missing, plain, shortRef, type Bib, type BibKind, type Seg } from '@/lib/bib'
import { fmtUsd } from '@/lib/cost'
import { useAiMode } from '@/lib/queries'
import type { Doc } from '@/lib/types'
import { Badge, Button, Card, Dialog, Field, IconButton, Input, Select, cn } from './kit'

/** the reference with its italics: HTML for Word / Google Docs, plain text for the rest */
export async function copyRich(segs: Seg[], rtl: boolean): Promise<void> {
  const text = plain(segs)
  const markup = `<span dir="${rtl ? 'rtl' : 'ltr'}" style="font-family:'Traditional Arabic','Times New Roman',serif">${html(segs)}</span>`
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([markup], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
    } else await navigator.clipboard.writeText(text)
    toast.success('نُسخ: ألصقه في Word وتبقى العناوين مائلة')
  } catch {
    prompt('انسخ المرجع:', text)
  }
}

export function RefText({ segs, className }: { segs: Seg[]; className?: string }) {
  return (
    <span className={className}>
      {segs.map((s, i) =>
        s.i ? (
          <i key={i}>{s.t}</i>
        ) : /\[[؟?] [^\]]+\]/.test(s.t) ? (
          <span key={i} className="rounded bg-warning-bg px-0.5 text-warning">
            {s.t}
          </span>
        ) : (
          <span key={i}>{s.t}</span>
        ),
      )}
    </span>
  )
}

/** a first guess when the owner writes the record by hand: what the archive already knows */
export function guessBib(d: Pick<Doc, 'doc_type' | 'title' | 'title_ar' | 'languages' | 'doc_date' | 'entities'>): Bib {
  const latin = !!d.languages?.length && !d.languages.includes('ar')
  const authors = (d.entities ?? [])
    .filter((e) => e.kind === 'person' && e.role === 'author')
    .map((e) => {
      const words = (e.as_written || e.name).trim().split(/\s+/)
      return words.length > 1 ? { last: words[words.length - 1], first: words.slice(0, -1).join(' ') } : { last: words[0] ?? '', first: '' }
    })
  return { kind: kindOfType(d.doc_type), lang: latin ? 'latin' : 'ar', authors, title: (latin ? d.title || d.title_ar : d.title_ar || d.title) ?? '', year: d.doc_date?.slice(0, 4) }
}

type Key = Exclude<keyof Bib, 'kind' | 'lang' | 'authors' | 'source' | 'checked'>
const L: Record<Key, string> = {
  institution: 'الجهة (مؤلفاً)',
  title: 'العنوان كما هو مطبوع',
  edition: 'الطبعة',
  volume: 'الجزء',
  publisher: 'دار النشر',
  place: 'بلد / مدينة النشر',
  year: 'السنة',
  journal: 'اسم المجلة',
  journal_volume: 'المجلد',
  issue: 'العدد',
  pages: 'الصفحات (من-إلى)',
  book_title: 'عنوان الكتاب الجماعي',
  editors: 'تحت إشراف',
  thesis_type: 'نوع البحث (أطروحة دكتوراه، رسالة ماستر…)',
  specialty: 'التخصص',
  faculty: 'الكلية',
  university: 'الجامعة',
  country: 'البلد',
  legal_type: 'نوع النص (ظهير شريف، مرسوم…)',
  legal_number: 'رقمه',
  issued_hijri: 'تاريخ الصدور بالهجري',
  issued: 'تاريخ الصدور بالميلادي',
  purpose: 'بتنفيذ… / المتعلق ب…',
  bo_number: 'عدد الجريدة الرسمية',
  bo_hijri: 'تاريخ النشر بالهجري',
  bo_date: 'تاريخ النشر بالميلادي',
  court: 'المحكمة',
  ruling_number: 'عدد القرار',
  ruling_date: 'تاريخه',
  file_number: 'عدد الملف',
  url: 'رابط (إن وُجد)',
}
const BY_KIND: Record<BibKind, Key[]> = {
  book: ['title', 'volume', 'edition', 'publisher', 'place', 'year'],
  chapter: ['title', 'book_title', 'editors', 'publisher', 'place', 'year', 'pages'],
  article: ['title', 'journal', 'journal_volume', 'issue', 'year', 'pages'],
  thesis: ['title', 'thesis_type', 'specialty', 'faculty', 'university', 'country', 'year'],
  report: ['institution', 'title', 'publisher', 'place', 'year'],
  legal: ['legal_type', 'legal_number', 'issued_hijri', 'issued', 'purpose', 'bo_number', 'bo_hijri', 'bo_date'],
  ruling: ['court', 'ruling_number', 'ruling_date', 'file_number', 'journal', 'journal_volume', 'issue', 'pages'],
  other: ['institution', 'title', 'publisher', 'place', 'year'],
}
const NO_AUTHORS: BibKind[] = ['legal', 'ruling']

export function BibEditor({ open, onClose, initial, onSave }: { open: boolean; onClose: () => void; initial: Bib; onSave: (b: Bib) => Promise<void> }) {
  const [b, setB] = useState<Bib>(initial)
  const [saving, setSaving] = useState(false)
  const set = (k: Key, v: string) => setB((x) => ({ ...x, [k]: v }))
  const dir = b.lang === 'latin' ? 'ltr' : 'rtl'
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="بيانات المرجع"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            loading={saving}
            icon={Check}
            onClick={async () => {
              setSaving(true)
              try {
                await onSave({ ...cleanBib(b, b.kind), source: 'owner', checked: true })
                onClose()
              } finally {
                setSaving(false)
              }
            }}
          >
            احفظ (راجعتُه مع الوثيقة)
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="النوع">
            <Select value={b.kind} onChange={(e) => setB({ ...b, kind: e.target.value as BibKind })}>
              {BIB_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.ar}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="لغة المرجع">
            <Select value={b.lang} onChange={(e) => setB({ ...b, lang: e.target.value as Bib['lang'] })}>
              <option value="ar">العربية</option>
              <option value="latin">الفرنسية / الإسبانية / الإنجليزية</option>
            </Select>
          </Field>
        </div>
        {!NO_AUTHORS.includes(b.kind) && (
          <div>
            <div className="mb-1.5 text-sm font-medium text-ink">المؤلفون</div>
            <div className="space-y-2">
              {b.authors.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input dir={dir} placeholder={b.lang === 'latin' ? 'Nom' : 'اللقب'} value={p.last} onChange={(e) => setB({ ...b, authors: b.authors.map((x, j) => (j === i ? { ...x, last: e.target.value } : x)) })} />
                  <Input dir={dir} placeholder={b.lang === 'latin' ? 'Prénom' : 'الاسم'} value={p.first} onChange={(e) => setB({ ...b, authors: b.authors.map((x, j) => (j === i ? { ...x, first: e.target.value } : x)) })} />
                  <IconButton icon={Trash2} label="احذف" size="sm" onClick={() => setB({ ...b, authors: b.authors.filter((_, j) => j !== i) })} />
                </div>
              ))}
              <Button size="sm" variant="ghost" icon={Plus} onClick={() => setB({ ...b, authors: [...b.authors, { last: '', first: '' }] })}>
                مؤلف
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {BY_KIND[b.kind].map((k) => (
            <Field key={k} label={L[k]} className={k === 'title' || k === 'purpose' || k === 'book_title' ? 'sm:col-span-2' : ''}>
              <Input dir={dir} value={(b[k] as string | undefined) ?? ''} onChange={(e) => set(k, e.target.value)} />
            </Field>
          ))}
        </div>
        <div className="rounded-xl bg-surface-2 p-3 text-sm leading-7" dir={dir}>
          <RefText segs={fullRef(b)} />
        </div>
      </div>
    </Dialog>
  )
}

export function ReferenceCard({ doc }: { doc: Doc }) {
  const qc = useQueryClient()
  const ai = useAiMode().data
  const [page, setPage] = useState('')
  const [edit, setEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const bib = doc.bib ? cleanBib(doc.bib) : null
  if (!bib && !RESEARCH_TYPES.includes(doc.doc_type ?? '')) return null

  const save = async (b: Bib | null) => {
    await api.updateDoc(doc.id, { bib: b }, false)
    await qc.invalidateQueries({ queryKey: ['doc', doc.id] })
    await qc.invalidateQueries({ queryKey: ['references'] })
  }
  const extract = async () => {
    setBusy(true)
    try {
      const r = await extractBib(doc)
      await save(r.bib)
      toast.success(`حُضّر المرجع (${fmtUsd(r.costUsd)}): راجعه مع الوثيقة`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const rtl = bib ? bib.lang !== 'latin' : true
  const gaps = bib ? missing(bib) : []
  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <BookMarked className="size-4 text-brand-600" /> المرجع بأسلوبك
        </h3>
        {bib && (
          <button onClick={() => setEdit(true)} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
            <Pencil className="size-3.5" /> تعديل
          </button>
        )}
      </div>
      {!bib ? (
        <>
          <p className="text-sm leading-relaxed text-muted">مرجع هذه الوثيقة على قواعد توثيقك: كاملاً في أول إحالة، و«مرجع سابق» و«المرجع نفسه» و«نقلاً عن»، يُنسخ إلى Word بعناوينه المائلة.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {ai === 'claude' && (
              <Button size="sm" icon={Sparkles} loading={busy} onClick={() => void extract()}>
                حضّره من الوثيقة
              </Button>
            )}
            <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEdit(true)}>
              اكتبه بيدك
            </Button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl bg-surface-2 p-3 text-[14px] leading-7 text-ink" dir={rtl ? 'rtl' : 'ltr'}>
            <RefText segs={fullRef(bib)} />
          </div>
          {gaps.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> ينقص: {gaps.join('، ')} — لم تظهر في الوثيقة؛ أكملها من مصدر موثوق قبل الاستعمال.
            </p>
          )}
          {!bib.checked && <Badge tone="warning">استخرجه Claude: راجعه مع الوثيقة ثم احفظه</Badge>}
          <div className="flex flex-wrap items-end gap-2">
            <Field label={bib.kind === 'legal' ? 'الموضع (الفصل/المادة أو ص.)' : 'الصفحة'} className="w-36">
              <Input value={page} onChange={(e) => setPage(e.target.value)} dir="auto" placeholder={bib.kind === 'legal' ? 'الفصل 27' : '45'} />
            </Field>
            <Button size="sm" icon={ClipboardCopy} onClick={() => void copyRich(firstCite(bib, page), rtl)}>
              أول إحالة
            </Button>
          </div>
          <ul className="space-y-1.5 text-[13px]" dir={rtl ? 'rtl' : 'ltr'}>
            {[
              { label: rtl ? 'مرجع سابق' : 'op. cit.', segs: shortRef(bib, page) },
              { label: rtl ? 'المرجع نفسه' : 'Ibid.', segs: ibid(bib, page) },
              { label: rtl ? 'نقلاً عن' : 'Cité par', segs: citedBy(bib, page) },
            ].map((f) => (
              <li key={f.label} className="flex items-start gap-2">
                <button type="button" title="انسخ" className={cn('mt-0.5 shrink-0 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink')} onClick={() => void copyRich(f.segs, rtl)}>
                  <ClipboardCopy className="size-3.5" />
                </button>
                <span className="min-w-0 leading-6 text-text">
                  <RefText segs={f.segs} />
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-relaxed text-muted">«نقلاً عن» حين لم تطّلع على الأصل: يُذكر المصدر الحامل وحده. وإن أعدت الإحالة بعد مرجع آخر فـ«مرجع سابق».</p>
          {ai === 'claude' && (
            <button type="button" className="text-xs text-brand-700 hover:underline dark:text-brand-200" disabled={busy} onClick={() => void extract()}>
              {busy ? 'يقرأ الوثيقة…' : 'أعد استخراجه من الوثيقة'}
            </button>
          )}
        </div>
      )}
      <BibEditor key={`${doc.updated_at}-${edit}`} open={edit} onClose={() => setEdit(false)} initial={bib ?? guessBib(doc)} onSave={(b) => save(b)} />
    </Card>
  )
}
