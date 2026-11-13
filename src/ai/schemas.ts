// JSON schemas for Claude's structured outputs (output_config.format): the answers always parse.
import { DOC_TYPE_KEYS, ID_KINDS, ORG_KINDS, PERSON_ROLES } from '@/lib/labels'

const str = { type: 'string' } as const
const num = { type: 'number' } as const
const bool = { type: 'boolean' } as const
const nstr = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const
const strList = { type: 'array', items: str } as const
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})

export const UNDERSTAND_SCHEMA = obj({
  doc_type: { type: 'string', enum: DOC_TYPE_KEYS },
  title: str,
  title_ar: str,
  summary_ar: str,
  languages: { type: 'array', items: { type: 'string', enum: ['ar', 'fr', 'es', 'en', 'other'] } },
  category: obj({
    existing_id: nstr,
    proposal: {
      anyOf: [
        obj({ parent_id: nstr, name_ar: str, name_fr: str, name_es: str, name_en: str, reason_ar: str }),
        { type: 'null' },
      ],
    },
    confidence: num,
  }),
  people: {
    type: 'array',
    items: obj({ name_ar: str, name_latin: str, honorific: nstr, role: { type: 'string', enum: PERSON_ROLES }, as_written: str }),
  },
  organizations: { type: 'array', items: obj({ name: str, name_latin: str, kind: { type: 'string', enum: ORG_KINDS }, city: nstr }) },
  places: { type: 'array', items: obj({ name_ar: str, name_latin: str, country: nstr, role: { type: 'string', enum: ['issue_place', 'subject', 'mentioned'] } }) },
  dates: obj({
    document_date: nstr,
    precision: { anyOf: [{ type: 'string', enum: ['day', 'month', 'year'] }, { type: 'null' }] },
    academic_year: nstr,
    period_start: nstr,
    period_end: nstr,
    expiry_date: nstr,
  }),
  identifiers: { type: 'array', items: obj({ kind: { type: 'string', enum: ID_KINDS }, value: str }) },
  status: obj({ is_copy: bool, certified_copy: bool, apostille: bool, sworn_translation: bool, translated_from: nstr }),
  sensitivity: { type: 'string', enum: ['normal', 'private', 'vault'] },
  keywords: obj({ ar: strList, fr: strList, es: strList, en: strList }),
  visual_features: str,
  deadlines: { type: 'array', items: obj({ date: str, title_ar: str }) },
  reason_ar: str,
  confidence: num,
})

export const TRANSCRIBE_SCHEMA = obj({
  pages: {
    type: 'array',
    items: obj({ index: { type: 'integer' }, text: str, blank: bool, legibility: { type: 'string', enum: ['good', 'partial', 'poor'] } }),
  },
})

export const SPLIT_SCHEMA = obj({
  documents: { type: 'array', items: obj({ first_page: { type: 'integer' }, last_page: { type: 'integer' }, title_ar: str }) },
})

export const JUDGE_SCHEMA = obj({
  relation: { type: 'string', enum: ['same', 'better_copy', 'version', 'annotated', 'translation', 'part', 'related', 'different'] },
  confidence: num,
  reason_ar: str,
})

export const QUERY_SCHEMA = obj({
  text: str,
  doc_types: { type: 'array', items: { type: 'string', enum: DOC_TYPE_KEYS } },
  category_ids: strList,
  person_names: strList,
  year_from: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  year_to: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  languages: { type: 'array', items: { type: 'string', enum: ['ar', 'fr', 'es', 'en'] } },
  sensitivity: { anyOf: [{ type: 'string', enum: ['normal', 'private', 'vault'] }, { type: 'null' }] },
})
