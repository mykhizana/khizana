// What to do with each look-alike found by the six layers. Rule: nothing is deleted automatically
// except a second copy of the very same file, and even that one goes to the trash (never purged).
// Anything uncertain becomes a question for the owner.
import type { DupCandidate } from '@/lib/types'

export type Me = { id: string; created_at: string; page_count: number; text_chars: number; needs_ocr: boolean; languages: string[]; pixels: number; size: number }

export type DupAction =
  | { kind: 'drop'; other: DupCandidate }
  | { kind: 'ask'; other: DupCandidate; relation: string; method: string; reason: string; suggestion: 'keep_new' | 'keep_existing' | 'keep_both' }
  | { kind: 'link'; other: DupCandidate; relation: string; from: 'me' | 'other'; method: string; confidence: number; reason: string }
  | { kind: 'judge'; other: DupCandidate; method: string }

function quality(o: { text_chars: number; needs_ocr: boolean; pixels: number | null; size: number | null }): number {
  return (o.needs_ocr ? 0 : o.text_chars > 40 ? 3 : 0) + Math.log10(Math.max(1, o.pixels ?? 0)) + Math.log10(Math.max(1, o.size ?? 0)) * 0.2
}

export function suggestKeep(me: Me, c: DupCandidate): 'keep_new' | 'keep_existing' {
  return quality(me) > quality(c) + 0.15 ? 'keep_new' : 'keep_existing'
}

/** the copy that came first stays; the same instant is decided by id, so both sides agree */
export function isOlder(c: { id: string; created_at: string }, me: { id: string; created_at: string }): boolean {
  const a = Date.parse(c.created_at)
  const b = Date.parse(me.created_at)
  if (a !== b) return a < b
  return c.id < me.id
}

export function decide(me: Me, cands: DupCandidate[], aiAvailable: boolean): DupAction[] {
  const out: DupAction[] = []
  for (const c of cands) {
    if (c.deleted || c.linked) continue
    if (c.sha256) {
      // only the later copy steps aside; the earlier one keeps its corrections, links and place
      if (isOlder(c, me)) out.push({ kind: 'drop', other: c })
      continue
    }
    const matched = Math.max(c.visual_pages, c.text_pages)
    const allPages = me.page_count > 0 && me.page_count === c.page_count && matched >= me.page_count
    const textless = me.text_chars < 40 && c.text_chars < 40
    const mh = c.minhash ?? null

    if (c.text_equal || (mh !== null && mh >= 0.98) || (allPages && c.text_pages >= me.page_count)) {
      out.push({ kind: 'ask', other: c, relation: 'same', method: c.text_equal ? 'text' : mh !== null && mh >= 0.98 ? 'minhash' : 'pages', reason: 'نفس النص تقريباً', suggestion: suggestKeep(me, c) })
      continue
    }
    if (allPages && textless) {
      out.push({ kind: 'ask', other: c, relation: 'same', method: 'phash', reason: 'تشابه بصري في كل الصفحات', suggestion: suggestKeep(me, c) })
      continue
    }
    if (me.page_count >= 1 && matched >= Math.ceil(me.page_count * 0.8) && c.page_count > me.page_count) {
      out.push({ kind: 'link', other: c, relation: 'part', from: 'me', method: 'pages', confidence: 0.85, reason: `${matched} من صفحاتها موجودة في وثيقة أطول` })
      continue
    }
    if (c.page_count >= 1 && matched >= Math.ceil(c.page_count * 0.8) && me.page_count > c.page_count) {
      out.push({ kind: 'link', other: c, relation: 'part', from: 'other', method: 'pages', confidence: 0.85, reason: 'الوثيقة الموجودة جزء من هذه الوثيقة' })
      continue
    }
    if (aiAvailable && ((mh !== null && mh >= 0.45) || c.identity >= 1 || (matched >= 1 && textless))) {
      out.push({ kind: 'judge', other: c, method: c.identity >= 1 ? 'identity' : mh !== null && mh >= 0.45 ? 'minhash' : 'phash' })
      continue
    }
    // without AI: careful guesses, never confirmed
    if (mh !== null && mh >= 0.75) out.push({ kind: 'link', other: c, relation: 'version', from: 'me', method: 'minhash', confidence: mh, reason: `تشابه النص ${Math.round(mh * 100)}%` })
    else if (c.identity >= 1) {
      const otherLang = c.languages.some((l) => !me.languages.includes(l))
      out.push({ kind: 'link', other: c, relation: otherLang ? 'translation' : 'related', from: 'me', method: 'identity', confidence: 0.7, reason: 'نفس الرقم المرجعي' })
    } else if (mh !== null && mh >= 0.45) out.push({ kind: 'link', other: c, relation: 'related', from: 'me', method: 'minhash', confidence: mh, reason: `تشابه النص ${Math.round(mh * 100)}%` })
  }
  return out
}
