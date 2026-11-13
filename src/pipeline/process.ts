// The life of one document after it arrives:
// read (OCR) → split a scanned stack → duplicates (layers 1-5) → understand → identity / AI judge (layer 6)
// → ready → (sealed into the vault last, when it belongs there).
import { api } from '@/db/api'
import { files } from '@/db/files'
import { judge, split, transcribe, understand } from '@/ai/claude'
import { demoUnderstand } from '@/ai/demo'
import { AiError, aiMode } from '@/ai/transport'
import { MODE } from '@/lib/config'
import { textHash } from '@/lib/hash'
import { docTitle } from '@/lib/format'
import type { Doc, DupCandidate } from '@/lib/types'
import { fingerprints } from '@/prep/prep'
import { decide, type DupAction, type Me } from './dedup'

export type Report = (state: string, detail?: string, ratio?: number) => void

const OCR_BATCH = 4

function pageImages(d: Doc) {
  return d.files.filter((f) => f.role === 'page').sort((a, b) => (a.page_no ?? 0) - (b.page_no ?? 0))
}

async function read(d: Doc, report: Report) {
  const imgs = pageImages(d)
  const todo = imgs.filter((f) => {
    const pg = d.pages.find((p) => p.page_no === f.page_no)
    return !pg || (!pg.text && !pg.blank) || pg.text_source === 'none'
  })
  if (!todo.length) return false
  const texts = new Map(d.pages.map((p) => [p.page_no, p.text]))
  let missing = 0
  for (let i = 0; i < todo.length; i += OCR_BATCH) {
    const chunk = todo.slice(i, i + OCR_BATCH)
    const detail = `قراءة الصفحات ${i + 1}–${i + chunk.length} من ${todo.length}`
    report('reading', detail, i / todo.length)
    // also renews this worker's claim on the document while a long book is read
    await api.setState(d.id, 'reading', detail)
    // every page keeps its own image: the text of page 3 can never land on page 2
    const pairs: { page_no: number; blob: Blob }[] = []
    for (const f of chunk) {
      const b = await files.get(f.path)
      if (b) pairs.push({ page_no: f.page_no ?? 1, blob: b })
      else missing++
    }
    if (missing && MODE === 'cloud') throw new AiError('تعذّر تنزيل صورة صفحة — ستُعاد المحاولة', 'network')
    if (missing && (await import('@/drive/sync')).driveSync.getSnapshot().linked)
      throw new AiError('صور صفحاتها ما تزال على جهازك الآخر: تُقرأ حين تصل إلى Drive', 'files')
    if (!pairs.length) continue
    const res = await transcribe(
      pairs.map((x) => x.blob),
      d.id,
    )
    const batch: { page_no: number; text: string; text_source: string; text_hash: string | null; legibility?: string; blank?: boolean }[] = []
    for (let k = 0; k < pairs.length && k < res.length; k++) {
      batch.push({ page_no: pairs[k].page_no, text: res[k].text, text_source: 'ocr', text_hash: await textHash(res[k].text), legibility: res[k].legibility, blank: res[k].blank })
      texts.set(pairs[k].page_no, res[k].text)
    }
    // saved after each batch: a closed tab never loses what was already paid for
    const fp = await fingerprints([...texts.values()].map((text) => ({ text })))
    const last = i + OCR_BATCH >= todo.length
    await api.setText({ id: d.id, pages: batch, text_hash: fp.textHash, text_chars: fp.textChars, minhash: fp.minhash, lsh: fp.lsh, needs_ocr: !last || missing > 0 })
  }
  return true
}

function meOf(d: Doc): Me {
  const page = d.files.find((f) => f.role === 'page' || f.role === 'original')
  return {
    id: d.id,
    created_at: d.created_at,
    page_count: d.page_count,
    text_chars: d.text_chars,
    needs_ocr: d.needs_ocr,
    languages: d.languages,
    pixels: (page?.width ?? 0) * (page?.height ?? 0),
    size: d.files.find((f) => f.role === 'original')?.size ?? 0,
  }
}

async function firstImage(d: Doc): Promise<Blob | null> {
  const f = pageImages(d)[0] ?? d.files.find((x) => x.role === 'thumb')
  return f ? files.get(f.path) : null
}

async function sideOf(id: string) {
  const o = await api.doc(id)
  if (!o) return null
  return {
    doc: o,
    side: { title: docTitle(o), summary: o.summary_ar, text: o.pages.map((p) => p.text).join('\n').slice(0, 6000), languages: o.languages, pages: o.page_count, image: await firstImage(o) },
  }
}

async function applyActions(d: Doc, actions: DupAction[], ai: boolean, report: Report): Promise<'dropped' | void> {
  let judged = 0
  for (const a of actions) {
    if (a.kind === 'drop') {
      // the very same file arrived earlier: this later copy goes to the trash (restorable for 30 days)
      await api.deleteDocs([d.id])
      await api.audit('duplicate_skipped', a.other.id, { name: d.file_name, copy: d.id })
      return 'dropped'
    }
    if (a.kind === 'ask') {
      await api.reviewAdd('duplicate', d.id, { other_id: a.other.id, other_title: a.other.title, relation: a.relation, method: a.method, reason: a.reason, suggestion: a.suggestion })
      continue
    }
    if (a.kind === 'link') {
      const [from_id, to_id] = a.from === 'me' ? [d.id, a.other.id] : [a.other.id, d.id]
      await api.linkSet({ from_id, to_id, relation: a.relation, method: a.method, confidence: a.confidence, reason: a.reason })
      continue
    }
    if (a.kind === 'judge' && ai && judged < 3) {
      judged++
      report('checking', 'مقارنة وثيقتين متشابهتين')
      const me = await sideOf(d.id)
      const other = await sideOf(a.other.id)
      if (!me || !other) continue
      const j = await judge(me.side, other.side, d.id)
      if (j.relation === 'different') continue
      if (j.relation === 'same' || j.relation === 'better_copy') {
        await api.reviewAdd('duplicate', d.id, {
          other_id: a.other.id,
          other_title: a.other.title,
          relation: j.relation,
          method: 'ai',
          reason: j.reason_ar,
          suggestion: j.relation === 'better_copy' ? 'keep_new' : 'keep_existing',
        })
      } else {
        await api.linkSet({ from_id: d.id, to_id: a.other.id, relation: j.relation, method: 'ai', confidence: j.confidence, reason: j.reason_ar })
      }
    }
  }
}

export async function processDoc(id: string, report: Report): Promise<void> {
  let d = await api.doc(id)
  if (!d || d.deleted_at) return
  const mode = await aiMode()
  const ai = mode === 'claude'

  // 1. read the scanned pages
  if (ai && d.needs_ocr) {
    if (await read(d, report)) d = (await api.doc(id))!
    if (!d) return
  }

  // 2. a scanned stack becomes separate documents
  if (d.source === 'stack') {
    let segments = [{ first_page: 1, last_page: d.page_count, title_ar: '' }]
    if (ai && d.page_count > 1) {
      report('reading', 'فصل الوثائق داخل الرزمة')
      segments = await split(
        d.pages.map((p) => p.text),
        d.id,
      )
    }
    if (segments.length > 1) {
      const r = await api.splitDoc(d.id, segments)
      await files.remove(r.removed_paths ?? []).catch(() => undefined)
      for (const nid of r.ids) {
        const nd = await api.doc(nid)
        if (!nd) continue
        const fp = await fingerprints(nd.pages)
        await api.setText({ id: nid, pages: [], text_hash: fp.textHash, text_chars: fp.textChars, minhash: fp.minhash, lsh: fp.lsh, needs_ocr: false })
      }
      return // the new documents go through the queue on their own
    }
    await api.updateDoc(d.id, { source: 'scan' }, false)
    d = (await api.doc(id))!
    if (!d) return
  }

  // 3. duplicates, before spending on understanding
  report('checking', 'فحص التكرار')
  await api.setState(d.id, 'checking')
  if ((await applyActions(d, decide(meOf(d), await api.dupCandidates(d.id), ai), ai, report)) === 'dropped') return

  // 4. understand
  report('understanding', ai ? 'Claude يفهم الوثيقة' : 'تصنيف تقريبي')
  await api.setState(d.id, 'understanding')
  const categories = await api.categories()
  const pageTexts = d.pages.map((p) => p.text)
  const hint = /المجلد: ([^·]+)/.exec(d.original_note ?? '')?.[1]?.trim() ?? ''
  const img = ai ? await firstImage(d) : null
  let seal = false
  // nothing to read (an unsupported file type): the file name is all there is — no need to pay for that
  if (ai && (img || pageTexts.some((t) => t.trim()))) {
    const second = pageImages(d)[1]
    const images = [img, second && d.page_count <= 4 ? await files.get(second.path) : null].filter(Boolean) as Blob[]
    const r = await understand({ documentId: d.id, fileName: d.file_name ?? '', hint, source: d.source, pageCount: d.page_count, pageTexts, images, categories })
    seal = (await api.applyAi(d.id, r.card, 'claude', r.model)).seal === true
  } else {
    seal = (await api.applyAi(d.id, demoUnderstand({ fileName: d.file_name ?? '', hint, pageTexts, categories }), 'demo')).seal === true
  }

  // 5. after understanding: same reference numbers (layer 6) and near texts, judged by the AI
  const after = await api.doc(id)
  if (after) {
    const cands = (await api.dupCandidates(id)).filter((c: DupCandidate) => !c.linked)
    await applyActions(
      after,
      decide(meOf(after), cands, ai).filter((a) => a.kind !== 'ask' || !after.reviews.some((r) => r.kind === 'duplicate' && r.payload.other_id === a.other.id)),
      ai,
      report,
    )
  }
  // 6. ready — and an identity paper, a passport, a medical file… into the vault, in the same step
  await api.finishDoc(id, seal)
}
