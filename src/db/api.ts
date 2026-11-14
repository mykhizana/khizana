// Every request of the app: one kh_* database function, the same in both modes.
import type { ReminderSource } from '@/drive/calendar'
import { MODE } from '@/lib/config'
import type {
  Category,
  Counts,
  Doc,
  DupCandidate,
  Entity,
  EntityDetail,
  Location,
  Overview,
  Proposal,
  Review,
  SearchFilters,
  SearchResult,
  Settings,
  UsageSummary,
  DeadlineItem,
  Dossier,
  DossierPlan,
  DossierSummary,
  ShareLink,
} from '@/lib/types'

async function call<T>(fn: string, p: unknown = {}): Promise<T> {
  if (MODE === 'cloud') {
    const { cloudCall } = await import('./cloud')
    return cloudCall<T>(fn, p)
  }
  const { localCall } = await import('./local')
  return localCall<T>(fn, p)
}

const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))) as T

export type NewFile = { id?: string; role: string; page_no?: number | null; path: string; mime?: string; size?: number; sha256?: string | null; width?: number; height?: number; name?: string }
export type NewPage = { page_no: number; text?: string; text_source?: string | null; text_hash?: string | null; phash?: string | null; blank?: boolean; width?: number; height?: number }

export const api = {
  call,
  bootstrap: () => call<{ settings: Settings; owner: string }>('kh_bootstrap'),
  settings: () => call<Settings>('kh_settings_get'),
  setSetting: (key: string, value: unknown) => call('kh_setting_set', { key, value }),
  usage: () => call<UsageSummary>('kh_usage_summary'),
  usageAdd: (u: Record<string, unknown>) => call('kh_usage_add', u),
  audit: (action: string, document_id?: string, details?: Record<string, unknown>) => call('kh_audit_add', { action, document_id, details }),

  overview: () => call<Overview>('kh_overview'),
  counts: () => call<Counts>('kh_counts'),
  search: (p: { q?: string; filters?: SearchFilters; sort?: string; limit?: number; offset?: number; facets?: boolean }) =>
    call<SearchResult>('kh_search', { ...p, filters: clean(p.filters ?? {}) }),

  doc: (id: string) => call<Doc | null>('kh_doc_get', { id }),
  shaLookup: (sha256s: string[]) =>
    call<{ sha256: string; document_id: string; title: string; created_at: string; deleted: boolean; category_path: { id: string; name: string }[] }[]>('kh_sha_lookup', { sha256s }),
  createDoc: (p: {
    id: string
    file_name: string
    source: string
    session_id?: string | null
    original_location_id?: string | null
    needs_ocr: boolean
    page_count: number
    text_chars: number
    text_hash?: string | null
    minhash?: number[] | null
    lsh?: string[] | null
    sensitivity?: string
    state?: string
    state_detail?: string | null
    original_note?: string | null
    title?: string
    files: NewFile[]
    pages: NewPage[]
  }) => call<{ id: string }>('kh_doc_create', p),
  setText: (p: { id: string; pages: { page_no: number; text: string; text_source: string; text_hash: string | null; legibility?: string; blank?: boolean }[]; text_hash: string | null; text_chars: number; minhash: number[] | null; lsh: string[] | null; needs_ocr?: boolean }) =>
    call('kh_doc_set_text', p),
  setState: (id: string, state: string, detail?: string | null) => call('kh_doc_state', { id, state, detail }),
  /** `foreign`: another device's document (device mode) — it reads it itself; see kh_pending */
  pending: () => call<{ id: string; state: string; detail: string | null; title: string; needs_ocr: boolean; page_count: number; foreign?: boolean }[]>('kh_pending'),
  updateDoc: (id: string, fields: Record<string, unknown>, by_owner = true) => call<{ ok: boolean; sealed?: boolean }>('kh_doc_update', { id, fields, by_owner }),
  deleteDocs: (ids: string[]) => call('kh_doc_delete', { ids }),
  restoreDoc: (id: string) => call('kh_doc_restore', { id }),
  purgeDocs: (p: { ids?: string[]; trash_older_than_days?: number }) => call<{ paths: string[]; count: number }>('kh_doc_purge', p),
  splitDoc: (id: string, segments: { first_page: number; last_page: number; title_ar?: string }[]) => call<{ ids: string[]; removed_paths: string[] }>('kh_doc_split', { id, segments }),
  applyAi: (id: string, card: unknown, mode: 'claude' | 'demo', model?: string) =>
    call<{ category_id: string | null; proposal_id: string | null; proposal_new: boolean; reviews: number; seal: boolean }>('kh_doc_apply_ai', { id, card, mode, model }),
  /** the end of processing: ready, and into the vault when it belongs there (one step) */
  finishDoc: (id: string, seal: boolean) => call('kh_doc_finish', { id, seal }),
  /** put a document into the vault (works without the second factor: it only hides it) */
  sealDoc: (id: string) => call('kh_doc_seal', { id }),
  /** take a document for processing; false when another tab or device is already on it */
  claim: (id: string, worker: string) => call<{ ok: boolean }>('kh_claim', { id, worker }),
  moveDocs: (ids: string[], category_id: string | null) => call('kh_move_docs', { ids, category_id }),

  dupCandidates: (id: string) => call<DupCandidate[]>('kh_dup_candidates', { id }),
  phashLookup: (phash: string, max = 10) =>
    call<{ document_id: string; title: string; page_no: number; distance: number; category_path: { id: string; name: string }[]; thumb: string | null }[]>('kh_phash_lookup', { phash, max }),
  linkSet: (p: { from_id: string; to_id: string; relation: string; method?: string; confidence?: number; reason?: string; confirmed?: boolean; replace?: boolean }) =>
    call('kh_link_set', p),
  linkRemove: (id: string) => call('kh_link_remove', { id }),

  reviews: () => call<{ items: Review[]; proposals: Proposal[] }>('kh_reviews_list'),
  reviewAdd: (kind: string, document_id: string | null, payload: Record<string, unknown>) => call<{ id: string }>('kh_review_add', { kind, document_id, payload }),
  reviewResolve: (id: string, decision: Record<string, unknown>, dismiss = false) => call('kh_review_resolve', { id, decision, dismiss }),
  proposalResolve: (p: { id: string; action: 'accept' | 'reject' | 'remap'; edits?: Record<string, unknown>; category_id?: string }) =>
    call<{ ok: boolean; category_id: string | null; moved: number; backfill: { id: string; title: string; rank: number }[] }>('kh_proposal_resolve', p),

  categories: () => call<Category[]>('kh_categories_list'),
  categorySave: (c: Partial<Category> & { name_ar: string }) => call<Category>('kh_category_save', c),
  categoryMerge: (from_id: string, into_id: string) => call('kh_category_merge', { from_id, into_id }),
  categoryDelete: (id: string) => call('kh_category_delete', { id }),

  entities: (p: { kind?: string; q?: string; limit?: number }) => call<Entity[]>('kh_entities_list', p),
  entity: (id: string) => call<EntityDetail | null>('kh_entity_get', { id }),
  entitySave: (p: Record<string, unknown>) => call('kh_entity_save', p),
  entityMerge: (from_id: string, into_id: string) => call('kh_entity_merge', { from_id, into_id }),

  locations: () => call<Location[]>('kh_locations_list'),
  locationSave: (p: Partial<Location> & { name: string }) => call<Location>('kh_location_save', p),
  locationDelete: (id: string) => call('kh_location_delete', { id }),
  locationByCode: (code: string) => call<Location | null>('kh_location_by_code', { code }),
  sessionStart: (kind: string, location_id?: string | null, label?: string) => call<{ id: string }>('kh_session_start', { kind, location_id, label }),
  sessionEnd: (id: string) => call('kh_session_end', { id }),

  deadlineDone: (id: string, done = true) => call('kh_deadline_done', { id, done }),
  deadlines: (withDone = false) => call<DeadlineItem[]>('kh_deadlines_list', { with_done: withDone }),
  deadlineAdd: (p: { title: string; due_date: string; document_id?: string | null; kind?: 'expiry' | 'action' | 'reminder' }) => call<{ id: string }>('kh_deadline_add', p),
  deadlineDelete: (id: string) => call('kh_deadline_delete', { id }),
  /** every open deadline for the phone reminders (the vault's without titles) */
  remindersSource: () => call<ReminderSource[]>('kh_reminders_source'),
  /** ready dossiers; with a document id, `has` tells whether it is already in each one */
  dossiers: (document_id?: string) => call<DossierSummary[]>('kh_dossiers_list', document_id ? { document_id } : {}),
  dossier: (id: string) => call<Dossier | null>('kh_dossier_get', { id }),
  dossierSave: (p: { id?: string; new_id?: string; name?: string; notes?: string | null; plan?: DossierPlan | null }) => call<{ id: string }>('kh_dossier_save', p),
  dossierDelete: (id: string, force = false) => call('kh_dossier_delete', { id, force }),
  dossierSetItems: (id: string, items: { document_id: string; requirement?: string | null }[]) => call<{ ok: boolean; items: number }>('kh_dossier_set_items', { id, items }),
  dossierAdd: (id: string, document_id: string, requirement?: string | null) => call('kh_dossier_add', { id, document_id, requirement }),
  dossierRemove: (id: string, document_id: string) => call('kh_dossier_add', { id, document_id, remove: true }),
  shares: (p: { open?: boolean; collection_id?: string; document_id?: string } = {}) => call<ShareLink[]>('kh_shares_list', p),
  shareAdd: (p: { id: string; collection_id?: string | null; document_id?: string | null; label?: string | null; watermark?: string | null; expires_at: string; drive_file: string; permission_id: string; url: string }) =>
    call<{ id: string; expires_at: string }>('kh_share_add', p),
  shareRevoke: (id: string) => call('kh_share_revoke', { id }),
  exportAll: () => call<{ format: string; version: number; exported_at: string; tables: Record<string, unknown[]> }>('kh_export'),
  importAll: (backup: unknown) => call<{ ok: boolean; rows: number }>('kh_import', backup),
  vaultCount: () => call<{ count: number }>('kh_vault_count'),
}
