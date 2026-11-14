// The articles of a legal text (الفصل / المادة / Article / Artículo) found in its pages: the index of the
// constitution, a dahir, a law or a decree, to jump to an article and cite it. Pure (the tests run it).
export type LegalArticle = { label: string; number: string; page_no: number; excerpt: string }

const ORDINALS: Record<string, string> = {
  الأول: '1', الأولى: '1', الثاني: '2', الثانية: '2', الثالث: '3', الثالثة: '3', الرابع: '4', الرابعة: '4', الخامس: '5', الخامسة: '5',
  السادس: '6', السادسة: '6', السابع: '7', السابعة: '7', الثامن: '8', الثامنة: '8', التاسع: '9', التاسعة: '9', العاشر: '10', العاشرة: '10',
  premier: '1', première: '1', '1er': '1', primero: '1', único: '1', unique: '1',
}
const LABELS: Record<string, string> = { الفصل: 'الفصل', المادة: 'المادة', article: 'Article', 'art.': 'Article', artículo: 'Artículo', articulo: 'Artículo' }
const HEAD = /^[\s\-–—•*]*(الفصل|المادة|article|art\.|artículo|articulo)\s+(\S+)(?:\s+(مكرر|bis|ter))?\s*[.:،\-–—)]?\s*(.*)$/i

/** «٢٧» → «27»; ordinals («الأول», «premier», «1er») → «1»; anything else is not an article number */
function number(raw: string): string | null {
  const x = raw.replace(/[.:،\-–—)]+$/, '')
  const digits = x.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  if (/^\d{1,4}$/.test(digits)) return String(Number(digits))
  return ORDINALS[x] ?? ORDINALS[x.toLowerCase()] ?? null
}

/** the articles in reading order, each once (where it first appears), with the start of its text */
export function legalArticles(pages: { page_no: number; text: string }[]): LegalArticle[] {
  const out: LegalArticle[] = []
  const seen = new Set<string>()
  for (const p of [...pages].sort((a, b) => a.page_no - b.page_no)) {
    const lines = (p.text ?? '').split(/\r?\n/)
    lines.forEach((line, i) => {
      const m = HEAD.exec(line.trim())
      if (!m) return
      const n = number(m[2])
      if (!n) return
      const label = LABELS[m[1].toLowerCase()] ?? m[1]
      const num = m[3] ? `${n} ${m[3].toLowerCase() === 'مكرر' ? 'مكرر' : m[3].toLowerCase()}` : n
      const key = `${label}|${num}`
      if (seen.has(key)) return
      seen.add(key)
      const rest = (m[4] || lines[i + 1] || '').trim()
      out.push({ label, number: num, page_no: p.page_no, excerpt: rest.length > 90 ? `${rest.slice(0, 89)}…` : rest })
    })
  }
  return out
}

/** «الفصل 27» / «Article 27» as it is cited */
export const articleName = (a: Pick<LegalArticle, 'label' | 'number'>) => `${a.label} ${a.number}`
