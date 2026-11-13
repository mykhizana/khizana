// JSON schemas for Claude's structured outputs (output_config.format): the answers always parse.
//
// Kept small on purpose. Anthropic compiles each schema into a grammar, and the first version of the
// «understand» schema (13 «string or null» unions and long enums inside arrays of objects) was refused
// on Opus 5.5 and Sonnet 5.5 alike: «The compiled grammar is too large». Unions are the expensive part
// (their cost grows exponentially), then long enums. So the two big schemas have no union and no enum:
// «unknown» is an empty string, the allowed values are listed in the instructions (prompts.ts), and
// normalize.ts turns the answer back into the card the archive stores (nulls, checked values).
// Every property is required (an optional one doubles part of the grammar).
const str = { type: 'string' } as const
const num = { type: 'number' } as const
const int = { type: 'integer' } as const
const bool = { type: 'boolean' } as const
const strList = { type: 'array', items: str } as const
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})
const list = (item: Record<string, unknown>) => ({ type: 'array', items: obj(item) })

export const UNDERSTAND_SCHEMA = obj({
  doc_type: str,
  title: str,
  title_ar: str,
  summary_ar: str,
  languages: strList,
  category: obj({
    existing_id: str,
    proposal: obj({ parent_id: str, name_ar: str, name_fr: str, name_es: str, name_en: str, reason_ar: str }),
    confidence: num,
  }),
  people: list({ name_ar: str, name_latin: str, honorific: str, role: str, as_written: str }),
  organizations: list({ name: str, name_latin: str, kind: str, city: str }),
  places: list({ name_ar: str, name_latin: str, country: str, role: str }),
  dates: obj({ document_date: str, precision: str, academic_year: str, period_start: str, period_end: str, expiry_date: str }),
  identifiers: list({ kind: str, value: str }),
  status: obj({ is_copy: bool, certified_copy: bool, apostille: bool, sworn_translation: bool, translated_from: str }),
  sensitivity: str,
  keywords: obj({ ar: strList, fr: strList, es: strList, en: strList }),
  visual_features: str,
  deadlines: list({ date: str, title_ar: str }),
  reason_ar: str,
  confidence: num,
})

// small schemas: their few short enums cost little
export const TRANSCRIBE_SCHEMA = obj({
  pages: list({ index: int, text: str, blank: bool, legibility: { type: 'string', enum: ['good', 'partial', 'poor'] } }),
})

export const SPLIT_SCHEMA = obj({
  documents: list({ first_page: int, last_page: int, title_ar: str }),
})

export const JUDGE_SCHEMA = obj({
  relation: { type: 'string', enum: ['same', 'better_copy', 'version', 'annotated', 'translation', 'part', 'related', 'different'] },
  confidence: num,
  reason_ar: str,
})

/** year_from / year_to: 0 when the phrase gives no year; sensitivity: "" when not asked */
export const QUERY_SCHEMA = obj({
  text: str,
  doc_types: strList,
  category_ids: strList,
  person_names: strList,
  year_from: int,
  year_to: int,
  languages: strList,
  sensitivity: str,
})
