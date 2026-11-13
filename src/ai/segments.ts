// A scanned stack split into documents: segments must cover pages 1..n in order, without gaps or overlaps.
export type Segment = { first_page: number; last_page: number; title_ar: string }

export function normaliseSegments(segs: Segment[], n: number): Segment[] {
  const sorted = [...segs].filter((s) => s.first_page >= 1 && s.first_page <= n).sort((a, b) => a.first_page - b.first_page)
  const out: Segment[] = []
  let next = 1
  for (const s of sorted) {
    const a = Math.max(s.first_page, next)
    if (a > n) break
    if (a > next) out.push({ first_page: next, last_page: a - 1, title_ar: '' })
    const b = Math.min(Math.max(s.last_page, a), n)
    out.push({ first_page: a, last_page: b, title_ar: s.title_ar })
    next = b + 1
  }
  if (next <= n) out.push({ first_page: next, last_page: n, title_ar: '' })
  return out.length ? out : [{ first_page: 1, last_page: n, title_ar: '' }]
}
