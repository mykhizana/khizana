// References in the owner's own citation rules (a Moroccan public-law thesis): the full reference of a
// first citation, the short one («مرجع سابق» / op. cit.), «المرجع نفسه» / Ibid., «نقلاً عن» / Cité par,
// and a bibliography in the order the rules ask (legal texts from the highest norm down).
// Titles of books, journals, theses and reports are italic; article titles go in « » (Latin: " ").
// Nothing is invented: a missing part shows as [؟ …] so that it is filled before the text is handed in.
// No colon is ever added (titles keep their own). Pure: no app imports (the tests run it).

export type BibKind = 'book' | 'chapter' | 'article' | 'thesis' | 'report' | 'legal' | 'ruling' | 'other'
export type Person = { last: string; first: string }
export type Bib = {
  kind: BibKind
  /** the language of the work: an Arabic reference, or a Latin-script one (French, Spanish, English) */
  lang: 'ar' | 'latin'
  authors: Person[]
  /** a body as author (المجلس الأعلى للحسابات…) */
  institution?: string
  title: string
  edition?: string
  volume?: string
  publisher?: string
  place?: string
  year?: string
  journal?: string
  journal_volume?: string
  issue?: string
  pages?: string
  /** a chapter: the book it is in, and who directed it */
  book_title?: string
  editors?: string
  thesis_type?: string
  specialty?: string
  faculty?: string
  university?: string
  country?: string
  /** ظهير شريف، قانون تنظيمي، مرسوم، قرار… */
  legal_type?: string
  legal_number?: string
  issued_hijri?: string
  issued?: string
  /** بتنفيذ الدستور، بتنفيذ القانون رقم … المتعلق ب… */
  purpose?: string
  bo_number?: string
  bo_hijri?: string
  bo_date?: string
  court?: string
  ruling_number?: string
  ruling_date?: string
  file_number?: string
  url?: string
  /** who wrote the record, and whether the owner checked it against the document */
  source?: 'claude' | 'owner'
  checked?: boolean
}
/** a piece of a reference; `i`: in italics */
export type Seg = { t: string; i?: boolean }

export const BIB_KINDS: { key: BibKind; ar: string }[] = [
  { key: 'book', ar: 'كتاب' },
  { key: 'chapter', ar: 'فصل في كتاب جماعي' },
  { key: 'article', ar: 'مقال' },
  { key: 'thesis', ar: 'أطروحة / رسالة' },
  { key: 'report', ar: 'تقرير' },
  { key: 'legal', ar: 'نص قانوني' },
  { key: 'ruling', ar: 'حكم / قرار قضائي' },
  { key: 'other', ar: 'أخرى' },
]
export const RESEARCH_TYPES = ['book', 'article', 'thesis', 'legal_text', 'report', 'court_ruling']
const FROM_TYPE: Record<string, BibKind> = { book: 'book', article: 'article', thesis: 'thesis', legal_text: 'legal', report: 'report', court_ruling: 'ruling' }
export const kindOfType = (docType: string | null | undefined): BibKind => FROM_TYPE[docType ?? ''] ?? 'other'

const has = (s?: string | null): s is string => !!s && !!s.trim()
const isAr = (b: Bib) => b.lang !== 'latin'
const t = (s: string, i = false): Seg => (i ? { t: s.trim(), i } : { t: s.trim() })
const miss = (b: Bib, what: string): Seg => ({ t: isAr(b) ? `[؟ ${what}]` : `[? ${what}]` })
/** «3» → «المجلد 3»; a value that already says it is kept as written */
const lead = (v: string, word: string) => (/^\d/.test(v.trim()) ? `${word} ${v.trim()}` : v.trim())

function quoted(b: Bib, s: string): Seg {
  return t(isAr(b) ? `«${s.trim()}»` : `"${s.trim()}"`)
}

/** the location in the work: «ص. 12» / «ص. 12-15» / «p. 12» / «pp. 12-15»; anything else as typed (الفصل 27) */
export function loc(b: Pick<Bib, 'lang'>, page?: string | null): string {
  const p = (page ?? '').trim()
  if (!p) return ''
  if (/^\d+$/.test(p)) return b.lang === 'latin' ? `p. ${p}` : `ص. ${p}`
  if (/^\d+\s*[-–]\s*\d+$/.test(p)) return b.lang === 'latin' ? `pp. ${p.replace(/\s*[-–]\s*/, '-')}` : `ص. ${p.replace(/\s*[-–]\s*/, '-')}`
  return p
}

function authors(b: Bib): Seg[] {
  const people = (b.authors ?? []).filter((p) => has(p.last) || has(p.first))
  if (people.length) {
    const sep = isAr(b) ? '، ' : ', '
    const one = (p: Person) => [p.last, p.first].filter(has).map((x) => x.trim()).join(sep)
    if (people.length > 3) return [t(`${one(people[0])}${isAr(b) ? ' وآخرون' : ' et al.'}`)]
    return [t(people.map(one).join(isAr(b) ? ' و' : ' et '))]
  }
  if (has(b.institution)) return [t(b.institution)]
  return [miss(b, isAr(b) ? 'المؤلف' : 'auteur')]
}

/** parts joined by «، » (Latin «, »), ended by a full stop */
function joined(b: Bib, parts: (Seg | Seg[] | null | undefined | false)[], end = true): Seg[] {
  const out: Seg[] = []
  for (const p of parts) {
    if (!p) continue
    const segs = (Array.isArray(p) ? p : [p]).filter((s) => s.t)
    if (!segs.length) continue
    if (out.length) out.push({ t: isAr(b) ? '، ' : ', ' })
    out.push(...segs)
  }
  if (end && out.length) {
    const last = out[out.length - 1]
    if (!/[.!?…]$/.test(last.t)) out.push({ t: '.' })
  }
  return out
}

const opt = (v: string | undefined, word?: string): Seg | null => (has(v) ? t(word ? lead(v, word) : v) : null)
const need = (b: Bib, v: string | undefined, what: string, italic = false): Seg => (has(v) ? t(v, italic) : miss(b, what))

function legal(b: Bib): Seg[] {
  const ar = isAr(b)
  const head = [b.legal_type, has(b.legal_number) ? `${ar ? 'رقم' : 'n°'} ${b.legal_number.trim()}` : null].filter(has).join(' ')
  const date = has(b.issued_hijri) && has(b.issued) ? `${b.issued_hijri.trim()} (${b.issued.trim()})` : (b.issued_hijri ?? b.issued ?? '').trim()
  const first = [has(head) ? head : miss(b, ar ? 'نوع النص ورقمه' : 'texte').t, date ? `${ar ? 'صادر في' : 'du'} ${date}` : miss(b, ar ? 'تاريخ الصدور' : 'date').t, b.purpose?.trim()]
    .filter(has)
    .join(' ')
  const boDate = has(b.bo_hijri) && has(b.bo_date) ? `${b.bo_hijri.trim()} (${b.bo_date.trim()})` : (b.bo_hijri ?? b.bo_date ?? '').trim()
  const bo = has(b.bo_number)
    ? `${ar ? 'الجريدة الرسمية عدد' : 'B.O. n°'} ${b.bo_number.trim()}${boDate ? ` ${ar ? 'بتاريخ' : 'du'} ${boDate}` : ''}`
    : ar
      ? '[؟ الجريدة الرسمية عددها وتاريخها]'
      : '[? B.O.]'
  return joined(b, [t(first), t(bo)])
}

/** the full reference (first citation, bibliography) */
export function fullRef(b: Bib): Seg[] {
  const ar = isAr(b)
  switch (b.kind) {
    case 'legal':
      return legal(b)
    case 'article':
      return joined(b, [
        authors(b),
        has(b.title) ? quoted(b, b.title) : miss(b, ar ? 'عنوان المقال' : 'titre'),
        need(b, b.journal, ar ? 'اسم المجلة' : 'revue', true),
        opt(b.journal_volume, ar ? 'المجلد' : 'vol.'),
        opt(b.issue, ar ? 'العدد' : 'n°'),
        need(b, b.year, ar ? 'السنة' : 'année'),
        has(b.pages) ? t(loc(b, b.pages)) : miss(b, ar ? 'الصفحات' : 'pages'),
      ])
    case 'chapter':
      return joined(b, [
        authors(b),
        has(b.title) ? quoted(b, b.title) : miss(b, ar ? 'عنوان الفصل' : 'titre'),
        [{ t: ar ? 'ضمن ' : 'in ' }, has(b.book_title) ? t(b.book_title, true) : miss(b, ar ? 'عنوان الكتاب' : 'ouvrage')],
        has(b.editors) ? t(`${ar ? 'تحت إشراف' : 'sous la direction de'} ${b.editors.trim()}`) : null,
        opt(b.publisher),
        opt(b.place),
        need(b, b.year, ar ? 'السنة' : 'année'),
        has(b.pages) ? t(loc(b, b.pages)) : null,
      ])
    case 'thesis':
      return joined(b, [
        authors(b),
        need(b, b.title, ar ? 'عنوان الرسالة' : 'titre', true),
        need(b, b.thesis_type, ar ? 'أطروحة دكتوراه أو رسالة ماستر' : 'thèse / mémoire'),
        has(b.specialty) ? t(ar && !/^تخصص/.test(b.specialty.trim()) ? `تخصص ${b.specialty.trim()}` : b.specialty) : null,
        opt(b.faculty),
        need(b, b.university, ar ? 'الجامعة' : 'université'),
        opt(b.country),
        need(b, b.year, ar ? 'سنة المناقشة' : 'année'),
      ])
    case 'ruling':
      return joined(b, [
        need(b, b.court, ar ? 'المحكمة' : 'juridiction'),
        has(b.ruling_number) ? t(`${ar ? 'قرار عدد' : 'arrêt n°'} ${b.ruling_number.trim()}`) : miss(b, ar ? 'عدد القرار' : 'n°'),
        has(b.ruling_date) ? t(`${ar ? 'بتاريخ' : 'du'} ${b.ruling_date.trim()}`) : miss(b, ar ? 'التاريخ' : 'date'),
        has(b.file_number) ? t(`${ar ? 'ملف عدد' : 'dossier n°'} ${b.file_number.trim()}`) : null,
        has(b.journal) ? t(b.journal, true) : null,
        opt(b.journal_volume, ar ? 'المجلد' : 'vol.'),
        opt(b.issue, ar ? 'العدد' : 'n°'),
        has(b.pages) ? t(loc(b, b.pages)) : null,
      ])
    case 'report':
      return joined(b, [authors(b), need(b, b.title, ar ? 'عنوان التقرير' : 'titre', true), opt(b.publisher), opt(b.place), need(b, b.year, ar ? 'السنة' : 'année')])
    case 'book':
      return joined(b, [
        authors(b),
        need(b, b.title, ar ? 'عنوان الكتاب' : 'titre', true),
        opt(b.volume, ar ? 'ج' : 't.'),
        opt(b.edition, ar ? 'ط' : 'éd.'),
        need(b, b.publisher, ar ? 'دار النشر' : 'éditeur'),
        need(b, b.place, ar ? 'بلد النشر' : 'lieu'),
        need(b, b.year, ar ? 'سنة النشر' : 'année'),
      ])
    default:
      return joined(b, [authors(b), need(b, b.title, ar ? 'العنوان' : 'titre', true), opt(b.publisher), opt(b.place), opt(b.year)])
  }
}

/** the first citation of a precise place: the full reference ended by «ص. 45» (an article: that page instead of its range) */
export function firstCite(b: Bib, page?: string | null): Seg[] {
  const where = loc(b, page)
  if (!where) return fullRef(b)
  if (b.kind === 'article' || b.kind === 'chapter') return fullRef({ ...b, pages: (page ?? '').trim() })
  const segs = fullRef(b)
  if (segs.length && segs[segs.length - 1].t === '.') segs.pop()
  return [...segs, { t: `${isAr(b) ? '، ' : ', '}${where}.` }]
}

/** the title cut at its subtitle, at most seven words */
export function shortTitle(title: string): string {
  const main = title.split(/\s*[:：—–]\s*|\.\s/)[0].trim() || title.trim()
  const words = main.split(/\s+/)
  return words.length > 7 ? words.slice(0, 7).join(' ') : main
}

/** «لقب، الاسم، العنوان المختصر، مرجع سابق، ص. X» / «Name, short title, op. cit., p. X» */
export function shortRef(b: Bib, page?: string | null): Seg[] {
  const ar = isAr(b)
  const where = loc(b, page)
  const cited = t(ar ? 'مرجع سابق' : 'op. cit.')
  if (b.kind === 'legal') {
    const head = [b.legal_type, has(b.legal_number) ? `${ar ? 'رقم' : 'n°'} ${b.legal_number.trim()}` : null].filter(has).join(' ')
    return joined(b, [t(head || b.title), cited, where ? t(where) : null])
  }
  if (b.kind === 'ruling') return joined(b, [t(`${b.court ?? ''} ${ar ? 'قرار عدد' : 'n°'} ${b.ruling_number ?? ''}`), cited, where ? t(where) : null])
  const title = shortTitle(b.title || '')
  const tseg = b.kind === 'article' || b.kind === 'chapter' ? quoted(b, title) : t(title, true)
  return joined(b, [authors(b), title ? tseg : null, cited, where ? t(where) : null])
}

/** «المرجع نفسه، ص. X» / «Ibid., p. X» */
export function ibid(b: Pick<Bib, 'lang'>, page?: string | null): Seg[] {
  const where = loc(b, page)
  return b.lang === 'latin' ? [{ t: `Ibid.${where ? `, ${where}` : ''}` }] : [{ t: `المرجع نفسه${where ? `، ${where}` : ''}.` }]
}

/** «نقلاً عن [the carrying source]، ص. X» / «Cité par …, p. X» (the original was not read) */
export function citedBy(b: Bib, page?: string | null): Seg[] {
  const full = fullRef(b)
  if (full.length && full[full.length - 1].t === '.') full.pop()
  const where = loc(b, page)
  const tail = where ? (isAr(b) ? `، ${where}` : `, ${where}`) : ''
  // (a reference already ending with a full stop — «s.d.» — takes no second one)
  const ends = !tail && /[.!?…]$/.test(full[full.length - 1]?.t ?? '')
  return [{ t: isAr(b) ? 'نقلاً عن ' : 'Cité par ' }, ...full, { t: `${tail}${ends ? '' : '.'}` }]
}

export const plain = (segs: Seg[]) => segs.map((s) => s.t).join('')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const html = (segs: Seg[]) => segs.map((s) => (s.i ? `<i>${esc(s.t)}</i>` : esc(s.t))).join('')

/** the parts still to fill (shown to the owner, and as [؟ …] in the reference) */
export function missing(b: Bib): string[] {
  return plain(fullRef(b))
    .match(/\[[؟?] [^\]]+\]/g)
    ?.map((m) => m.slice(3, -1)) ?? []
}

/** rank of a legal text, from the highest norm down (the rules order them so) */
export function legalRank(b: Bib): number {
  // the kind of text decides; what it applies or carries out does not («مرسوم تطبيقاً للقانون التنظيمي» is a
  // decree). Only a promulgating dahir takes the rank of the text it carries out (constitution, organic
  // law, law). Without a kind, the heading is read instead.
  const type = (b.legal_type ?? '').trim()
  const rest = `${b.purpose ?? ''} ${b.title ?? ''}`
  const dahir = /ظهير|dahir/i.test(type)
  const s = type && !dahir ? type : rest
  if (dahir || !type) {
    if (/^\s*(?:بتنفيذ|بإصدار)?\s*(?:نص\s+)?الدستور|constitution/i.test(s)) return 0
    if (/(?:بتنفيذ|بإصدار)\s+القانون\s+التنظيمي|loi organique/i.test(s)) return 1
    if (dahir) return 2
  }
  if (/دستور|constitution/i.test(s)) return 0
  if (/تنظيمي|organique/i.test(s)) return 1
  if (/مرسوم\s+بقانون|décret-loi/i.test(s)) return 3
  if (/مرسوم|décret/i.test(s)) return 4
  if (/قرار|arrêté/i.test(s)) return 5
  if (/دورية|منشور|circulaire/i.test(s)) return 6
  if (/قانون|\bloi\b/i.test(s)) return 2
  return 7
}

const yearOf = (b: Bib) => Number(/\d{4}/.exec(`${b.issued ?? ''} ${b.bo_date ?? ''} ${b.year ?? ''}`)?.[0] ?? 9999)

export const SECTIONS: { kinds: BibKind[]; ar: string; latin: string }[] = [
  { kinds: ['legal'], ar: 'النصوص القانونية', latin: 'Textes juridiques' },
  { kinds: ['book', 'chapter'], ar: 'الكتب', latin: 'Ouvrages' },
  { kinds: ['thesis'], ar: 'الأطروحات والرسائل', latin: 'Thèses et mémoires' },
  { kinds: ['article'], ar: 'المقالات', latin: 'Articles' },
  { kinds: ['report'], ar: 'التقارير', latin: 'Rapports' },
  { kinds: ['ruling'], ar: 'الأحكام والقرارات القضائية', latin: 'Jurisprudence' },
  { kinds: ['other'], ar: 'مراجع أخرى', latin: 'Autres références' },
]

export type BibSection<T> = { title: string; items: T[] }
export type BibPart<T> = { lang: 'ar' | 'latin'; title: string; sections: BibSection<T>[] }

/** the bibliography: Arabic references first, then the others; legal texts from the highest norm down, the rest by author */
export function bibliography<T extends { bib: Bib }>(list: T[]): BibPart<T>[] {
  const key = (b: Bib) => (b.authors?.[0]?.last || b.institution || b.title || '').trim()
  const parts: BibPart<T>[] = []
  for (const lang of ['ar', 'latin'] as const) {
    const mine = list.filter((x) => (x.bib.lang === 'latin' ? 'latin' : 'ar') === lang)
    if (!mine.length) continue
    const sections: BibSection<T>[] = []
    for (const s of SECTIONS) {
      const items = mine.filter((x) => s.kinds.includes(x.bib.kind))
      if (!items.length) continue
      items.sort((a, b) =>
        s.kinds[0] === 'legal'
          ? legalRank(a.bib) - legalRank(b.bib) || yearOf(a.bib) - yearOf(b.bib)
          : key(a.bib).localeCompare(key(b.bib), lang === 'ar' ? 'ar' : 'fr') || (a.bib.year ?? '').localeCompare(b.bib.year ?? ''),
      )
      sections.push({ title: lang === 'ar' ? s.ar : s.latin, items })
    }
    parts.push({ lang, title: lang === 'ar' ? 'المراجع باللغة العربية' : 'Références en langues étrangères', sections })
  }
  return parts
}

/** a record made safe (from Claude or from an old version): known kind and language, trimmed strings */
export function cleanBib(raw: unknown, fallbackKind: BibKind = 'other'): Bib {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, 400) : '')
  const kinds = BIB_KINDS.map((k) => k.key)
  const kind = (kinds.includes(s('kind') as BibKind) ? s('kind') : fallbackKind) as BibKind
  const people = Array.isArray(o.authors) ? o.authors : []
  const out: Bib = {
    kind,
    lang: s('lang') === 'latin' || /^(fr|es|en|latin)$/i.test(s('lang')) ? 'latin' : 'ar',
    authors: people
      .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
      .map((p) => ({ last: String(p.last ?? '').trim().slice(0, 120), first: String(p.first ?? '').trim().slice(0, 120) }))
      .filter((p) => p.last || p.first)
      .slice(0, 12),
    title: s('title'),
  }
  for (const k of [
    'institution', 'edition', 'volume', 'publisher', 'place', 'year', 'journal', 'journal_volume', 'issue', 'pages', 'book_title', 'editors',
    'thesis_type', 'specialty', 'faculty', 'university', 'country', 'legal_type', 'legal_number', 'issued_hijri', 'issued', 'purpose',
    'bo_number', 'bo_hijri', 'bo_date', 'court', 'ruling_number', 'ruling_date', 'file_number', 'url',
  ] as const) {
    const v = s(k)
    if (v) out[k] = v
  }
  if (o.source === 'owner' || o.source === 'claude') out.source = o.source
  if (o.checked === true) out.checked = true
  return out
}
