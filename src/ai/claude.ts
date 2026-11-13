// The five things the archive asks Claude to do. Opus 5.5 by default; for a big import the queue may
// pass Sonnet 5.5 (half the price) as `model` — never for search, which stays with Opus.
import { estimateCost } from '@/lib/cost'
import type { AiCard, Category } from '@/lib/types'
import { blobToBase64 } from '@/prep/image'
import { JUDGE_SYSTEM, SPLIT_SYSTEM, TRANSCRIBE_SYSTEM, UNDERSTAND_SYSTEM, querySystem, taxonomyBlock } from './prompts'
import { JUDGE_SCHEMA, QUERY_SCHEMA, SPLIT_SCHEMA, TRANSCRIBE_SCHEMA, UNDERSTAND_SCHEMA } from './schemas'
import { normalizeCard, normalizeQuery } from './normalize'
import { normaliseSegments } from './segments'
import { send } from './transport'

const fmt = (schema: unknown) => ({ type: 'json_schema' as const, schema })

async function imageBlock(b: Blob) {
  return { type: 'image', source: { type: 'base64', media_type: b.type === 'image/png' ? 'image/png' : 'image/jpeg', data: await blobToBase64(b) } }
}

// ------------------------------------------------------------------ 1. read scanned pages (OCR)
export type Transcribed = { text: string; blank: boolean; legibility: 'good' | 'partial' | 'poor' }

export async function transcribe(images: Blob[], documentId?: string, model?: string): Promise<Transcribed[]> {
  const content: unknown[] = []
  for (const b of images) content.push(await imageBlock(b))
  content.push({ type: 'text', text: `Transcribe these ${images.length} page image(s), in order.` })
  const r = await send<{ pages: { index: number; text: string; blank: boolean; legibility: Transcribed['legibility'] }[] }>(
    'transcribe',
    {
      system: TRANSCRIBE_SYSTEM,
      messages: [{ role: 'user', content }],
      max_tokens: 32000,
      output_config: { effort: 'low', format: fmt(TRANSCRIBE_SCHEMA) },
    },
    { documentId, model, estimate: estimateCost({ images: images.length, outTokens: images.length * 1800, model }) },
  )
  // (read tolerantly: without a schema — see loose.ts — a field may be missing)
  const pages = Array.isArray(r.data?.pages) ? r.data.pages : []
  return images.map((_, i) => {
    const p = pages.find((x) => x && x.index === i + 1) ?? pages[i]
    return p ? { text: typeof p.text === 'string' ? p.text : '', blank: p.blank === true, legibility: ['good', 'partial', 'poor'].includes(p.legibility) ? p.legibility : 'good' } : { text: '', blank: false, legibility: 'poor' }
  })
}

// ------------------------------------------------------------------ 2. understand one document
export type UnderstandInput = {
  documentId: string
  fileName: string
  hint: string
  source: string
  pageCount: number
  pageTexts: string[]
  images: Blob[]
  categories: Category[]
  /** the Claude that reads it (Opus 5.5 unless the queue chose Sonnet 5.5 for a big import) */
  model?: string
}

const EXCERPT = 24_000

export function excerpt(pageTexts: string[]): string {
  const parts: string[] = []
  let used = 0
  for (let i = 0; i < pageTexts.length; i++) {
    const t = pageTexts[i]?.trim()
    if (!t) continue
    const room = EXCERPT - used
    if (room <= 400) {
      // keep a little of the last page: signatures, dates, stamps are often there
      const last = pageTexts[pageTexts.length - 1]?.trim()
      if (last && i < pageTexts.length - 1) parts.push(`--- page ${pageTexts.length} (last) ---\n${last.slice(0, 1500)}`)
      parts.push(`[… ${pageTexts.length - i} more pages not shown …]`)
      break
    }
    const piece = t.length > room ? t.slice(0, room) + ' …' : t
    parts.push(`--- page ${i + 1} ---\n${piece}`)
    used += piece.length
  }
  return parts.join('\n\n')
}

export async function understand(input: UnderstandInput): Promise<{ card: AiCard; model: string }> {
  const content: unknown[] = []
  for (const b of input.images.slice(0, 2)) content.push(await imageBlock(b))
  const text = excerpt(input.pageTexts)
  content.push({
    type: 'text',
    text:
      `File name: ${input.fileName}\n` +
      (input.hint ? `Folder: ${input.hint}\n` : '') +
      `Pages: ${input.pageCount} · Source: ${input.source}\n` +
      (input.images.length ? `The first page image(s) are attached for the layout, stamps and logos.\n` : '') +
      (text ? `\nText of the document:\n${text}` : '\n(No text could be extracted; rely on the image and the file name.)'),
  })
  const r = await send<unknown>(
    'understand',
    {
      system: [
        { type: 'text', text: UNDERSTAND_SYSTEM },
        { type: 'text', text: taxonomyBlock(input.categories), cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content }],
      max_tokens: 16000,
      output_config: { effort: 'medium', format: fmt(UNDERSTAND_SCHEMA) },
    },
    { documentId: input.documentId, model: input.model, estimate: estimateCost({ images: Math.min(2, input.images.length), chars: text.length, outTokens: 2500, model: input.model }) },
  )
  // the schema is loose on purpose (schemas.ts): the answer is checked and completed here
  return { card: normalizeCard(r.data), model: r.model }
}

// ------------------------------------------------------------------ 3. one scanned stack → several documents
export async function split(pageTexts: string[], documentId?: string, model?: string): Promise<{ first_page: number; last_page: number; title_ar: string }[]> {
  const body = pageTexts.map((t, i) => `=== page ${i + 1} ===\n${(t || '(blank)').slice(0, 1200)}`).join('\n\n')
  const r = await send<{ documents: { first_page: number; last_page: number; title_ar: string }[] }>(
    'split',
    {
      system: SPLIT_SYSTEM,
      messages: [{ role: 'user', content: `${pageTexts.length} pages:\n\n${body}` }],
      max_tokens: 8000,
      output_config: { effort: 'low', format: fmt(SPLIT_SCHEMA) },
    },
    { documentId, model, estimate: estimateCost({ chars: body.length, outTokens: 800, model }) },
  )
  return normaliseSegments(Array.isArray(r.data?.documents) ? r.data.documents : [], pageTexts.length)
}

// ------------------------------------------------------------------ 4. are these two the same document?
export type Judged = { relation: 'same' | 'better_copy' | 'version' | 'annotated' | 'translation' | 'part' | 'related' | 'different'; confidence: number; reason_ar: string }
type Side = { title: string; summary: string | null; text: string; languages: string[]; pages: number; image?: Blob | null }

export async function judge(fresh: Side, existing: Side, documentId?: string, model?: string): Promise<Judged> {
  const content: unknown[] = []
  const describe = (label: string, s: Side) =>
    `${label}\nTitle: ${s.title}\nLanguages: ${s.languages.join(', ') || '?'} · Pages: ${s.pages}\nSummary: ${s.summary ?? '—'}\nText (start):\n${s.text.slice(0, 5000) || '(no text)'}`
  if (fresh.image) content.push(await imageBlock(fresh.image))
  if (existing.image) content.push(await imageBlock(existing.image))
  content.push({ type: 'text', text: `${describe('NEW document', fresh)}\n\n===\n\n${describe('EXISTING document', existing)}${fresh.image || existing.image ? '\n\n(Images: first the new document, then the existing one, when available.)' : ''}` })
  const r = await send<Judged>(
    'judge',
    { system: JUDGE_SYSTEM, messages: [{ role: 'user', content }], max_tokens: 6000, output_config: { effort: 'medium', format: fmt(JUDGE_SCHEMA) } },
    { documentId, model, estimate: estimateCost({ images: content.length - 1, chars: 10_000, outTokens: 600, model }) },
  )
  const relations: Judged['relation'][] = ['same', 'better_copy', 'version', 'annotated', 'translation', 'part', 'related', 'different']
  const rel = String(r.data?.relation ?? '').toLowerCase() as Judged['relation']
  const conf = Number(r.data?.confidence)
  // an answer that cannot be read changes nothing: «different»
  return { relation: relations.includes(rel) ? rel : 'different', confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5, reason_ar: typeof r.data?.reason_ar === 'string' ? r.data.reason_ar : '' }
}

// ------------------------------------------------------------------ 5. a search phrase → filters
export type ParsedQuery = {
  text: string
  doc_types: string[]
  category_ids: string[]
  person_names: string[]
  year_from: number | null
  year_to: number | null
  languages: string[]
  sensitivity: 'normal' | 'private' | 'vault' | null
}

export async function parseQuery(q: string, categories: Category[]): Promise<ParsedQuery> {
  const r = await send<unknown>(
    'query',
    {
      system: [{ type: 'text', text: querySystem(categories), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: q }],
      max_tokens: 3000,
      output_config: { effort: 'low', format: fmt(QUERY_SCHEMA) },
    },
    { estimate: estimateCost({ chars: 3000, outTokens: 300 }) },
  )
  const ids = new Set(categories.map((c) => c.id))
  const parsed = normalizeQuery(r.data)
  return { ...parsed, category_ids: parsed.category_ids.filter((x) => ids.has(x)) }
}
