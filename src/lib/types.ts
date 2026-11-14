// Shapes returned by the kh_* database functions (see supabase/schema.sql)

export type DocState = 'new' | 'reading' | 'understanding' | 'checking' | 'ready' | 'review' | 'error' | 'waiting'
export type Sensitivity = 'normal' | 'private' | 'vault'
export type PathItem = { id: string; name: string }

export type FileRow = {
  id: string
  document_id: string
  role: 'original' | 'page' | 'thumb' | 'enhanced' | 'export'
  page_no: number | null
  path: string
  mime: string | null
  size: number | null
  sha256: string | null
  width: number | null
  height: number | null
  name: string | null
}

export type PageRow = {
  page_no: number
  text: string
  blank: boolean
  legibility: string | null
  text_source: string | null
  width: number | null
  height: number | null
}

export type Identifier = { kind: string; value: string }

export type DocEntity = {
  id: string
  kind: 'person' | 'org' | 'place'
  name: string
  name_latin: string | null
  honorific: string | null
  role: string
  as_written: string | null
  confirmed: boolean
}

export type DocLink = {
  id: string
  relation: string
  method: string | null
  confidence: number | null
  reason: string | null
  confirmed: boolean
  direction: 'in' | 'out'
  other_id: string
  other_title: string
  other_deleted: boolean
}

export type Deadline = { id: string; document_id: string; kind: string; due_date: string; title: string; done: boolean }

/** a row of the deadline radar */
// ready dossiers («الملفات الجاهزة») and their share links (kh_dossier_*, kh_share_*)
export type DossierSummary = { id: string; name: string; notes: string | null; created_at: string; procedure: string | null; documents: number; missing: number; shared: number; has: boolean | null }
export type DossierItem = {
  document_id: string
  requirement: string | null
  position: number
  title: string
  doc_type: string | null
  page_count: number
  state: string
  sensitivity: string
  doc_date: string | null
  expiry_date: string | null
}
export type ReqStatus = 'found' | 'expired' | 'missing' | 'unsure'
/** one paper the procedure asks for; `hidden`: answered by a document of the closed vault */
export type Requirement = {
  label: string
  status: ReqStatus
  document_id?: string | null
  note?: string | null
  title?: string | null
  expiry_date?: string | null
  gone?: boolean
  hidden?: boolean
}
export type DossierPlan = { procedure: string; summary?: string | null; requirements: Requirement[]; planned_at?: string; cost_usd?: number; model?: string }
export type ShareLink = {
  id: string
  url: string
  label: string | null
  watermark: string | null
  expires_at: string
  revoked: boolean
  expired: boolean
  created_at: string
  drive_file: string | null
  collection_id?: string | null
  document_id?: string | null
  name?: string | null
}
export type Dossier = { id: string; name: string; notes: string | null; created_at: string; items: DossierItem[]; hidden: number; plan: DossierPlan | null; shares: ShareLink[] }

export type DeadlineItem = { id: string; due_date: string; title: string; kind: 'expiry' | 'action' | 'reminder'; done: boolean; document_id: string | null; doc_title: string | null; doc_type: string | null; vault: boolean }

export type Proposal = {
  id: string
  parent_id: string | null
  name_ar: string
  name_fr: string | null
  name_es: string | null
  name_en: string | null
  reason: string | null
  status: string
  created_at: string
  parent_path?: PathItem[]
  docs?: { id: string; title: string; doc_type: string | null; thumb: string | null }[]
}

export type Location = {
  id: string
  code: string
  name: string
  kind: string
  place: string | null
  notes: string | null
  parent_id: string | null
  created_at: string
  doc_count?: number
}

export type Doc = {
  id: string
  state: DocState
  state_detail: string | null
  source: string
  file_name: string | null
  title: string | null
  title_ar: string | null
  summary_ar: string | null
  doc_type: string | null
  languages: string[]
  category_id: string | null
  proposal_id: string | null
  category_confidence: number | null
  doc_date: string | null
  date_precision: string | null
  academic_year: string | null
  period_start: string | null
  period_end: string | null
  expiry_date: string | null
  identifiers: Identifier[]
  status: { is_copy?: boolean; certified_copy?: boolean; apostille?: boolean; sworn_translation?: boolean; translated_from?: string | null }
  sensitivity: Sensitivity
  keywords: string[]
  visual_features: string | null
  ai_reason: string | null
  ai_confidence: number | null
  ai_model: string | null
  ai_mode: string | null
  needs_ocr: boolean
  page_count: number
  text_chars: number
  text_hash: string | null
  original_location_id: string | null
  original_note: string | null
  pinned_offline: boolean
  favorite: boolean
  tags: string[]
  created_at: string
  updated_at: string
  processed_at: string | null
  deleted_at: string | null
  session_id: string | null
  // joined
  category_path: PathItem[]
  proposal: Proposal | null
  location: Location | null
  files: FileRow[]
  pages: PageRow[]
  entities: DocEntity[]
  links: DocLink[]
  deadlines: Deadline[]
  reviews: Review[]
  corrected: string[]
}

export type SearchItem = {
  id: string
  title: string | null
  title_ar: string | null
  file_name: string | null
  summary_ar: string | null
  doc_type: string | null
  doc_date: string | null
  date_precision: string | null
  academic_year: string | null
  expiry_date: string | null
  languages: string[]
  state: DocState
  state_detail: string | null
  page_count: number
  sensitivity: Sensitivity
  favorite: boolean
  pinned_offline: boolean
  created_at: string
  deleted_at: string | null
  category_id: string | null
  category_path: PathItem[]
  proposal_id: string | null
  proposal_name: string | null
  location: string | null
  thumb: string | null
  people: { id: string; name: string; role: string }[]
  rank: number
  best_page: number | null
  snippet: string | null
}

export type Facet = { key: string | number; count: number; name?: string }

export type SearchResult = {
  mode: 'none' | 'all' | 'any' | 'fuzzy'
  total: number
  items: SearchItem[]
  facets?: { doc_type: Facet[]; category: Facet[]; year: Facet[]; language: Facet[]; person: Facet[]; location: Facet[] }
  suggestions?: string[] | null
}

export type SearchFilters = {
  category_ids?: string[]
  doc_types?: string[]
  year_from?: number
  year_to?: number
  entity_ids?: string[]
  languages?: string[]
  location_id?: string
  sensitivity?: Sensitivity
  states?: DocState[]
  favorite?: boolean
  pinned?: boolean
  deleted?: boolean
  uncategorized?: boolean
  proposal_id?: string
  session_id?: string
  ids?: string[]
  expiring?: number
  ai_mode?: 'demo' | 'claude' | 'none'
}

export type Category = {
  id: string
  parent_id: string | null
  name_ar: string
  name_fr: string | null
  name_es: string | null
  name_en: string | null
  description: string | null
  aliases: string[]
  icon: string | null
  sort: number
  origin: 'seed' | 'owner' | 'ai'
  archived: boolean
  doc_count: number
}

export type Review = {
  id: string
  kind: 'duplicate' | 'person_match' | 'person_new' | 'low_confidence' | 'split' | 'backfill' | 'error'
  document_id: string | null
  payload: Record<string, any>
  status: string
  created_at: string
  doc?: { id: string; title: string; doc_type: string | null; summary_ar: string | null; page_count: number; category_path: PathItem[]; thumb: string | null } | null
}

export type Entity = {
  id: string
  kind: 'person' | 'org' | 'place'
  name: string
  name_latin: string | null
  honorific: string | null
  details: Record<string, any>
  confirmed: boolean
  created_at: string
  doc_count?: number
  roles?: string[]
  years?: { from: number | null; to: number | null }
}

export type EntityDetail = Entity & {
  aliases: string[]
  docs: { id: string; title: string; doc_type: string | null; doc_date: string | null; date_precision: string | null; academic_year: string | null; role: string; category_path: PathItem[]; thumb: string | null }[]
  related: { id: string; name: string; kind: string; count: number }[]
  categories: { id: string; name: string; count: number }[]
}

export type Overview = {
  documents: number
  pages: number
  people: number
  categories: number
  locations: number
  duplicates_avoided: number
  by_type: Record<string, number>
  deadlines: { id: string; due_date: string; title: string; kind: string; document_id: string }[]
  recent: { id: string; title: string; doc_type: string | null; state: DocState; created_at: string; page_count: number; category_path: PathItem[]; thumb: string | null }[]
}

export type Counts = { reviews: number; proposals: number; pending: number; documents: number; trash: number }

export type UsageSummary = {
  month_cost: number
  month_calls: number
  total_cost: number
  by_op: Record<string, number>
  by_day: { day: string; cost: number }[]
  tokens: { input: number; output: number }
  cap: number
  alert_ratio: number
}

export type Settings = {
  autonomy?: 'ask' | 'ask_top' | 'auto'
  monthly_cap_usd?: number
  alert_ratio?: number
  economy?: boolean
  ai_model?: string
  /** who reads the documents: «auto» (Sonnet 5.5 for a big import), «opus» or «sonnet» — see src/ai/models.ts */
  reading_mode?: 'auto' | 'opus' | 'sonnet'
  [k: string]: unknown
}

export type DupCandidate = {
  id: string
  title: string
  file_name: string | null
  doc_type: string | null
  languages: string[]
  page_count: number
  text_chars: number
  deleted: boolean
  created_at: string
  needs_ocr: boolean
  summary_ar: string | null
  sha256: boolean
  text_equal: boolean
  visual_pages: number
  text_pages: number
  minhash: number | null
  identity: number
  pixels: number | null
  size: number | null
  linked: boolean
}

// ------------------------------------------------------------- what the AI returns for one document
export type AiCard = {
  doc_type: string
  title: string
  title_ar: string
  summary_ar: string
  languages: string[]
  category: {
    existing_id: string | null
    proposal: null | { parent_id: string | null; name_ar: string; name_fr: string; name_es: string; name_en: string; reason_ar: string }
    confidence: number
  }
  people: { name_ar: string; name_latin: string; honorific: string | null; role: string; as_written: string }[]
  organizations: { name: string; name_latin: string; kind: string; city: string | null }[]
  places: { name_ar: string; name_latin: string; country: string | null; role: string }[]
  dates: {
    document_date: string | null
    precision: 'day' | 'month' | 'year' | null
    academic_year: string | null
    period_start: string | null
    period_end: string | null
    expiry_date: string | null
  }
  identifiers: Identifier[]
  status: { is_copy: boolean; certified_copy: boolean; apostille: boolean; sworn_translation: boolean; translated_from: string | null }
  sensitivity: Sensitivity
  keywords: { ar: string[]; fr: string[]; es: string[]; en: string[] }
  visual_features: string
  deadlines: { date: string; title_ar: string }[]
  reason_ar: string
  confidence: number
}
