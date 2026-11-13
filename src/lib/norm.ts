// Text normalisation — must stay identical to kh_norm / kh_stem in supabase/schema.sql
// (the database searches with them; the app highlights and fingerprints with these).

const FROM = 'أإآٱىیئةؤک٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ'
const TO = 'اااايييهوك01234567890123456789aaaaaaceeeeiiiinooooouuuuyyoa'
const DIAC = /[ؐ-ًؚ-ٰٟـۖ-ۭ]/g
const KEEP = /[0-9a-zء-ي]/

const MAP = new Map<string, string>()
for (let i = 0; i < FROM.length; i++) MAP.set(FROM[i], TO[i])

export function norm(t: string | null | undefined): string {
  const s = (t ?? '').toLowerCase().replace(DIAC, '')
  let out = ''
  for (const ch of s) out += MAP.get(ch) ?? ch
  return out.replace(/[^0-9a-zء-ي]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const PREFIXES = ['وال', 'بال', 'كال', 'فال', 'لل', 'ال']
const SUFFIXES = ['ات', 'ون', 'ين', 'ان', 'ها', 'هم', 'هن', 'كم', 'نا', 'يه', 'ه', 'ي']

export function stem(w: string): string {
  if (!w || w.length < 4) return w
  if (/^[a-z]+$/.test(w)) return w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w
  if (!/[ء-ي]/.test(w)) return w
  let s = w
  for (const p of PREFIXES)
    if (s.startsWith(p) && s.length - p.length >= 3) {
      s = s.slice(p.length)
      break
    }
  for (const x of SUFFIXES)
    if (s.endsWith(x) && s.length - x.length >= 3) {
      s = s.slice(0, -x.length)
      break
    }
  return s
}

const STOP = new Set(
  'في من على عن الى الي مع او ثم التي الذي هذا هذه ذلك تلك كل بين عند لدى ما لا ان قد هو هي le la les de des du et en un une pour par sur au aux dans avec est el los las del y una por para con al que the of and in on for to a'.split(' '),
)

export const isStop = (w: string) => STOP.has(w)

/** the words a user typed, normalised, without stop-words (with their stems) */
export function queryTokens(q: string): string[] {
  const out = new Set<string>()
  for (const w of norm(q).split(' ')) {
    if (w.length < 2 || STOP.has(w)) continue
    out.add(w)
    const s = stem(w)
    if (s !== w && s.length >= 3) out.add(s)
  }
  return [...out]
}

/** normalised text with, for each normalised character, its index in the original string */
function normWithMap(t: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  let lastSpace = true
  const lower = t.toLowerCase()
  for (let i = 0; i < lower.length; i++) {
    let ch = lower[i]
    DIAC.lastIndex = 0
    if (DIAC.test(ch)) continue
    ch = MAP.get(ch) ?? ch
    if (KEEP.test(ch)) {
      text += ch
      map.push(i)
      lastSpace = false
    } else if (!lastSpace) {
      text += ' '
      map.push(i)
      lastSpace = true
    }
  }
  return { text, map }
}

export type Segment = { text: string; hit: boolean }

/** split a text into plain/highlighted parts: every word that contains a searched word (or its stem) is marked */
export function highlight(t: string, tokens: string[]): Segment[] {
  if (!t) return []
  const toks = tokens.filter((x) => x.length >= 2)
  if (!toks.length) return [{ text: t, hit: false }]
  const { text, map } = normWithMap(t)
  const ranges: [number, number][] = []
  for (const tok of toks) {
    let from = 0
    for (;;) {
      const at = text.indexOf(tok, from)
      if (at < 0) break
      // a short token must start a word (or follow a one-letter prefix) to count
      const wordStart = text.lastIndexOf(' ', at) + 1
      if (tok.length >= 3 || at - wordStart <= 2) {
        let wEnd = text.indexOf(' ', at + tok.length)
        if (wEnd < 0) wEnd = text.length
        const a = map[wordStart]
        const b = wEnd - 1 < map.length ? map[wEnd - 1] + 1 : t.length
        ranges.push([a, b])
      }
      from = at + tok.length
    }
  }
  if (!ranges.length) return [{ text: t, hit: false }]
  ranges.sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  // extend each range over trailing diacritics of the original word
  const out: Segment[] = []
  let pos = 0
  for (const [a0, b0] of merged) {
    let b = b0
    while (b < t.length && /[ؐ-ًؚ-ٰٟـ]/.test(t[b])) b++
    if (a0 > pos) out.push({ text: t.slice(pos, a0), hit: false })
    out.push({ text: t.slice(a0, b), hit: true })
    pos = b
  }
  if (pos < t.length) out.push({ text: t.slice(pos), hit: false })
  return out
}

/** a window of ~len characters around the first hit, cut on word boundaries */
export function snippetAround(t: string, tokens: string[], len = 260): string {
  if (!t) return ''
  const segs = highlight(t, tokens)
  let at = 0
  let found = -1
  for (const s of segs) {
    if (s.hit) {
      found = at
      break
    }
    at += s.text.length
  }
  if (found < 0) return t.slice(0, len).trim() + (t.length > len ? '…' : '')
  let a = Math.max(0, found - Math.floor(len / 3))
  let b = Math.min(t.length, a + len)
  while (a > 0 && !/\s/.test(t[a - 1])) a--
  while (b < t.length && !/\s/.test(t[b])) b++
  return (a > 0 ? '…' : '') + t.slice(a, b).trim() + (b < t.length ? '…' : '')
}

/** person key: like kh_person_key (titles removed) */
export function personKey(t: string | null | undefined): string {
  return norm(t)
    .split(' ')
    .filter(
      (w) =>
        w &&
        !/^(د|دكتور|الدكتور|دكتوره|الدكتوره|ذ|الاستاذ|استاذ|الاستاذه|استاذه|السيد|السيده|الحاج|pr|prof|professeur|professor|dr|docteur|doctor|doctora|mr|mme|mlle|m|sr|sra|don|dona|dra)$/.test(w),
    )
    .join(' ')
}
