// «اسأل خزانتك»: what the assistant's tools hand to Claude, and how its answer is cut into text and
// citations. Pure functions (no database, no network): the tests check them in Node.
import { docTitle } from '@/lib/format'
import { typeLabel } from '@/lib/labels'
import type { Doc, SearchItem } from '@/lib/types'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** «1-3,7» → [1, 2, 3, 7] within 1..max; nothing usable → null (every page) */
export function parsePages(spec: unknown, max: number): number[] | null {
  if (typeof spec !== 'string' || !spec.trim() || max < 1) return null
  const out = new Set<number>()
  for (const part of spec.split(/[,،\s]+/)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part.trim())
    if (!m) continue
    let a = Number(m[1])
    let b = m[2] ? Number(m[2]) : a
    if (a > b) [a, b] = [b, a]
    for (let p = Math.max(1, a); p <= Math.min(max, b) && out.size < 400; p++) out.add(p)
  }
  return out.size ? [...out].sort((x, y) => x - y) : null
}

const shelf = (path: { name: string }[] | null | undefined) => (path?.length ? path.map((p) => p.name).join(' › ') : 'not filed yet')
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** search hits → a compact list Claude reads (ids, titles, dates, shelves, best passage) */
export function hitsBrief(items: SearchItem[], total: number): string {
  if (!items.length) return 'No document matched. Try other words: synonyms, another language (Arabic, French, Spanish, English), a name in the other script, or a document type.'
  const lines = [`${total} document(s) matched; the best ${items.length}:`]
  for (const d of items) {
    const facts = [
      `id: ${d.id}`,
      docTitle(d),
      `type: ${typeLabel(d.doc_type)}`,
      d.doc_date ? `date: ${d.doc_date}` : d.academic_year ? `academic year: ${d.academic_year}` : null,
      d.expiry_date ? `valid until: ${d.expiry_date}` : null,
      `shelf: ${shelf(d.category_path)}`,
      `pages: ${d.page_count}`,
      d.location ? `paper original kept at: ${d.location}` : null,
      d.sensitivity === 'vault' ? 'in the vault' : null,
    ].filter(Boolean)
    lines.push(`- ${facts.join(' | ')}`)
    if (d.snippet) lines.push(`  best passage${d.best_page ? ` (page ${d.best_page})` : ''}: «${oneLine(d.snippet).slice(0, 320)}»`)
    else if (d.summary_ar) lines.push(`  summary: ${oneLine(d.summary_ar).slice(0, 320)}`)
  }
  return lines.join('\n')
}

/** one document → its card, then the text of the asked pages, cut at `limit` characters */
export function docBrief(d: Doc, pages: number[] | null, limit = 20_000): string {
  const out: string[] = []
  out.push(`Document ${d.id}`)
  out.push(`Title: ${docTitle(d)}${d.title && d.title_ar && d.title !== d.title_ar ? ` (${d.title})` : ''}`)
  out.push(`Type: ${typeLabel(d.doc_type)} · pages: ${d.page_count}${d.languages?.length ? ` · languages: ${d.languages.join(', ')}` : ''}`)
  const dates = [
    d.doc_date ? `date: ${d.doc_date}` : null,
    d.academic_year ? `academic year: ${d.academic_year}` : null,
    d.period_start || d.period_end ? `period: ${d.period_start ?? '?'} → ${d.period_end ?? '?'}` : null,
    d.expiry_date ? `valid until: ${d.expiry_date}` : null,
  ].filter(Boolean)
  if (dates.length) out.push(`Dates: ${dates.join(' · ')}`)
  out.push(`Shelf: ${shelf(d.category_path)}`)
  if (d.summary_ar) out.push(`Summary: ${oneLine(d.summary_ar)}`)
  if (d.identifiers?.length) out.push(`Identifiers: ${d.identifiers.map((i) => `${i.kind}: ${i.value}`).join('; ')}`)
  if (d.entities?.length) out.push(`People and organisations: ${d.entities.map((e) => `${e.name}${e.name_latin && e.name_latin !== e.name ? ` / ${e.name_latin}` : ''} (${e.kind}, ${e.role})`).join('; ')}`)
  const st = d.status ?? {}
  const flags = [st.is_copy && 'a copy', st.certified_copy && 'certified copy', st.apostille && 'apostille', st.sworn_translation && `sworn translation${st.translated_from ? ` from ${st.translated_from}` : ''}`].filter(Boolean)
  if (flags.length) out.push(`Status: ${flags.join(', ')}`)
  if (d.location || d.original_note) out.push(`Paper original kept at: ${[d.location?.name, d.location?.place, d.original_note].filter(Boolean).join(' — ')}`)
  if (d.deadlines?.length) out.push(`Deadlines: ${d.deadlines.map((x) => `${x.due_date} — ${x.title}${x.done ? ' (done)' : ''}`).join('; ')}`)
  if (d.sensitivity === 'vault') out.push('Kept in the vault.')

  const wanted = new Set(pages ?? d.pages.map((p) => p.page_no))
  const texts = d.pages.filter((p) => wanted.has(p.page_no)).sort((a, b) => a.page_no - b.page_no)
  let used = out.join('\n').length
  const shown: number[] = []
  for (const p of texts) {
    const body = p.blank ? '(blank page)' : p.text?.trim() || '(no text could be read on this page)'
    const room = limit - used
    if (room < 400) break
    const piece = body.length > room ? `${body.slice(0, room)} …` : body
    out.push(`--- page ${p.page_no} ---\n${piece}`)
    used += piece.length + 20
    shown.push(p.page_no)
  }
  const missing = texts.map((p) => p.page_no).filter((n) => !shown.includes(n))
  if (missing.length) out.push(`[Pages not shown: ${missing.join(', ')}. Ask for them with pages, e.g. "${missing[0]}-${missing[missing.length - 1]}".]`)
  if (!d.pages.length) out.push('(The text of this document has not been read yet.)')
  return out.join('\n')
}

export type AnswerPart = { kind: 'text'; text: string } | { kind: 'cite'; id: string; page: number | null }

const CITE = /\[\[doc:([0-9a-f-]{36})(?:\s*\|\s*p(?:age)?[:.]?\s*(\d+))?\]\]/gi

/** «… [[doc:ID|p:3]] …» → text and citation parts (a citation still being written is dropped) */
export function splitCitations(text: string): AnswerPart[] {
  const clean = text.replace(/\[\[[^\]]*\]?$/, '')
  const parts: AnswerPart[] = []
  let last = 0
  for (const m of clean.matchAll(CITE)) {
    if (m.index! > last) parts.push({ kind: 'text', text: clean.slice(last, m.index) })
    parts.push({ kind: 'cite', id: m[1].toLowerCase(), page: m[2] ? Number(m[2]) : null })
    last = m.index! + m[0].length
  }
  if (last < clean.length) parts.push({ kind: 'text', text: clean.slice(last) })
  return parts
}

/** the documents an answer cites, in order, once each */
export function citedIds(text: string): string[] {
  return [...new Set(splitCitations(text).flatMap((p) => (p.kind === 'cite' ? [p.id] : [])))]
}
