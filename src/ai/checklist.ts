// Claude's checklist of a procedure (src/ai/dossier.ts) made safe before it is stored: known statuses,
// only document ids the app's tools returned, no empty lines. Pure (the tests run it).
import type { DossierPlan, ReqStatus, Requirement } from '@/lib/types'

const STATUSES: ReqStatus[] = ['found', 'expired', 'missing', 'unsure']

/** Claude's checklist made safe: known statuses, only ids the tools gave, no empty lines */
export function cleanChecklist(raw: unknown, known: Record<string, string>): Omit<DossierPlan, 'planned_at' | 'cost_usd'> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const reqs: Requirement[] = []
  for (const r of Array.isArray(o.requirements) ? o.requirements : []) {
    if (!r || typeof r !== 'object') continue
    const x = r as Record<string, unknown>
    const label = String(x.label ?? '').trim().slice(0, 200)
    if (!label) continue
    let status = String(x.status ?? '').trim().toLowerCase() as ReqStatus
    if (!STATUSES.includes(status)) status = 'unsure'
    const id = String(x.document_id ?? '').trim()
    const document_id = id && known[id] ? id : null
    // a paper said to be there must point at a real document
    if (!document_id && status !== 'missing') status = 'missing'
    reqs.push({ label, status, document_id, note: String(x.note ?? '').trim().slice(0, 300) || null })
  }
  return { procedure: String(o.procedure ?? '').trim().slice(0, 200), summary: String(o.summary ?? '').trim().slice(0, 900) || null, requirements: reqs.slice(0, 40) }
}
