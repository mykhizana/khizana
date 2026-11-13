// Claude's answers → what the archive stores. The schemas are deliberately loose (plain strings, ""
// for unknown — see schemas.ts), so the values are checked here: empty strings become null, values
// outside the allowed lists fall back to a safe one (compared case-insensitively), empty rows go.
import { DOC_TYPE_KEYS, ID_KINDS, ORG_KINDS, PERSON_ROLES } from '@/lib/labels'
import type { AiCard, Sensitivity } from '@/lib/types'
import type { ParsedQuery } from './claude'

type Raw = Record<string, unknown>
const rec = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []) as Raw[]
const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
/** "", "null", "none", "unknown"… → null */
const orNull = (v: unknown): string | null => {
  const x = s(v)
  return x && !/^(null|none|n\/a|unknown|—|-)$/i.test(x) ? x : null
}
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const x = s(v).toLowerCase().replace(/[\s-]+/g, '_')
  return (allowed as readonly string[]).includes(x) ? (x as T) : fallback
}
const words = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : []).map(s).filter(Boolean))]
const unit = (v: unknown, d = 0.5): number => {
  const x = Number(v)
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d
}

export function normalizeCard(answer: unknown): AiCard {
  const r = rec(answer)
  const cat = rec(r.category)
  const prop = rec(cat.proposal)
  const dates = rec(r.dates)
  const st = rec(r.status)
  const kw = rec(r.keywords)
  const precision = s(dates.precision).toLowerCase()
  return {
    doc_type: oneOf(r.doc_type, DOC_TYPE_KEYS, 'other'),
    title: s(r.title),
    title_ar: s(r.title_ar),
    summary_ar: s(r.summary_ar),
    languages: [...new Set(words(r.languages).map((l) => oneOf(l, ['ar', 'fr', 'es', 'en', 'other'] as const, 'other')))],
    category: {
      existing_id: orNull(cat.existing_id),
      // a proposal without a name is no proposal
      proposal: orNull(prop.name_ar)
        ? { parent_id: orNull(prop.parent_id), name_ar: s(prop.name_ar), name_fr: s(prop.name_fr), name_es: s(prop.name_es), name_en: s(prop.name_en), reason_ar: s(prop.reason_ar) }
        : null,
      confidence: unit(cat.confidence),
    },
    people: rows(r.people)
      .map((p) => ({ name_ar: s(p.name_ar), name_latin: s(p.name_latin), honorific: orNull(p.honorific), role: oneOf(p.role, PERSON_ROLES, 'mentioned'), as_written: s(p.as_written) }))
      .filter((p) => p.name_ar || p.name_latin),
    organizations: rows(r.organizations)
      .map((o) => ({ name: s(o.name), name_latin: s(o.name_latin), kind: oneOf(o.kind, ORG_KINDS, 'other'), city: orNull(o.city) }))
      .filter((o) => o.name || o.name_latin),
    places: rows(r.places)
      .map((p) => ({ name_ar: s(p.name_ar), name_latin: s(p.name_latin), country: orNull(p.country), role: oneOf(p.role, ['issue_place', 'subject', 'mentioned'] as const, 'mentioned') }))
      .filter((p) => p.name_ar || p.name_latin),
    dates: {
      document_date: orNull(dates.document_date),
      precision: precision === 'day' || precision === 'month' || precision === 'year' ? precision : null,
      academic_year: orNull(dates.academic_year),
      period_start: orNull(dates.period_start),
      period_end: orNull(dates.period_end),
      expiry_date: orNull(dates.expiry_date),
    },
    identifiers: rows(r.identifiers)
      .map((i) => ({ kind: oneOf(i.kind, ID_KINDS, 'other'), value: s(i.value) }))
      .filter((i) => i.value),
    status: { is_copy: st.is_copy === true, certified_copy: st.certified_copy === true, apostille: st.apostille === true, sworn_translation: st.sworn_translation === true, translated_from: orNull(st.translated_from) },
    sensitivity: oneOf<Sensitivity>(r.sensitivity, ['normal', 'private', 'vault'], 'normal'),
    keywords: { ar: words(kw.ar), fr: words(kw.fr), es: words(kw.es), en: words(kw.en) },
    visual_features: s(r.visual_features),
    deadlines: rows(r.deadlines)
      .map((d) => ({ date: s(d.date), title_ar: s(d.title_ar) }))
      .filter((d) => d.date && d.title_ar),
    reason_ar: s(r.reason_ar),
    confidence: unit(r.confidence),
  }
}

const year = (v: unknown): number | null => {
  const n = Math.trunc(Number(v))
  return n >= 1000 && n <= 2999 ? n : null
}

export function normalizeQuery(answer: unknown): ParsedQuery {
  const r = rec(answer)
  const sens = s(r.sensitivity).toLowerCase()
  return {
    text: s(r.text),
    doc_types: words(r.doc_types).map((t) => t.toLowerCase()).filter((t) => DOC_TYPE_KEYS.includes(t)),
    category_ids: words(r.category_ids),
    person_names: words(r.person_names),
    year_from: year(r.year_from),
    year_to: year(r.year_to),
    languages: words(r.languages).map((l) => l.toLowerCase()).filter((l) => ['ar', 'fr', 'es', 'en'].includes(l)),
    sensitivity: sens === 'normal' || sens === 'private' || sens === 'vault' ? sens : null,
  }
}
