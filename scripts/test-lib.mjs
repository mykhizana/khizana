// npm run test:lib — the pure parts of the app, run in Node on the TypeScript sources:
// normalisation (identical to the database), fingerprints, paper detection, duplicate decisions,
// the approximate classifier and stack segments.
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'

const SRC = new URL('../src/', import.meta.url)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) {
      let p = spec.slice(2)
      if (!/\.(ts|tsx|js|mjs)$/.test(p)) p += '.ts'
      return next(new URL(p, SRC).href, ctx)
    }
    if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[a-z]+$/i.test(spec) && ctx.parentURL?.includes('/src/')) return next(spec + '.ts', ctx)
    return next(spec, ctx)
  },
})

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
}

const { norm, stem, queryTokens, highlight, personKey, snippetAround } = await import('../src/lib/norm.ts')
const { minhash, minhashSimilarity, lshBands, dhash, hamming } = await import('../src/lib/hash.ts')
const { detectQuad } = await import('../src/scan/geometry.ts')
const { decide } = await import('../src/pipeline/dedup.ts')
const { demoUnderstand } = await import('../src/ai/demo.ts')
const { normaliseSegments } = await import('../src/ai/segments.ts')
const { costOf, estimateCost } = await import('../src/lib/cost.ts')
const { docsAr } = await import('../src/lib/format.ts')

// ------------------------------------------------------------ normalisation = the database's
const db = new PGlite({ extensions: { pg_trgm } })
await db.exec(readFileSync(new URL('../supabase/local-stubs.sql', import.meta.url), 'utf8'))
await db.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
const samples = [
  'الإدارةُ العموميّة', 'مُحَمَّد بنعلي', 'Décentralisation, Año 2018 — ÉTÉ', 'سنة ٢٠١٨/٢٠١٩', 'المسؤولية التقصيرية',
  'إلى الأستاذ الدكتور', 'ـــالجهويةـــ المتقدمة', 'رئيس المصلحة؛ (ختم)', 'Ñandú café', 'فاتورة رقم ۱۲۳', 'كتاب ک ی ئ ؤ',
]
for (const s of samples) {
  const sql = (await db.query('select kh_norm($1) n', [s])).rows[0].n
  ok(`norm parity: ${s}`, sql === norm(s), `sql=${sql} js=${norm(s)}`)
}
for (const w of ['الاداري', 'اداره', 'بالادارات', 'documents', 'المحامين', 'كتابه', 'علي']) {
  const sql = (await db.query('select kh_stem($1) s', [w])).rows[0].s
  ok(`stem parity: ${w}`, sql === stem(w), `sql=${sql} js=${stem(w)}`)
}
for (const n of ['الأستاذ الدكتور محمد بنعلي', 'Pr. M. BENALI', 'د. أمينة العلمي', 'Dr Karim El Amrani']) {
  const sql = (await db.query('select kh_person_key($1) k', [n])).rows[0].k
  ok(`person key parity: ${n}`, sql === personKey(n), `sql=${sql} js=${personKey(n)}`)
}
ok('query tokens drop stop-words and add stems', JSON.stringify(queryTokens('محاضرات في الإدارة')) === JSON.stringify(['محاضرات', 'محاضر', 'الاداره', 'ادار']), JSON.stringify(queryTokens('محاضرات في الإدارة')))
const hl = highlight('مبادئ الإدارةُ العمومية والقانون الإداري', queryTokens('إدارة'))
ok('highlight marks every derived word', hl.filter((s) => s.hit).map((s) => s.text).join('|') === 'الإدارةُ|الإداري', JSON.stringify(hl))
ok('snippet around the first hit', snippetAround('a '.repeat(300) + 'الجهوية المتقدمة ' + 'b '.repeat(300), queryTokens('الجهوية'), 80).includes('الجهوية'))

// ------------------------------------------------------------ fingerprints
const lecture = readFileSync(new URL('../test-fixtures/محاضرات-القانون-الاداري-2018.txt', import.meta.url), 'utf8')
const v2 = readFileSync(new URL('../test-fixtures/محاضرات-القانون-الاداري-النسخة-المحينة.txt', import.meta.url), 'utf8')
const other = readFileSync(new URL('../test-fixtures/ملخص-الجهوية-المتقدمة.txt', import.meta.url), 'utf8') + ' ' + 'نص آخر مختلف تماماً عن المحاضرة '.repeat(10)
const mA = minhash(lecture)
const mB = minhash(v2)
const mC = minhash(other)
ok('minhash: revised version is close', minhashSimilarity(mA, mB) > 0.6, String(minhashSimilarity(mA, mB)))
ok('minhash: different text is far', minhashSimilarity(mA, mC) < 0.2, String(minhashSimilarity(mA, mC)))
ok('minhash: same text = 1', minhashSimilarity(mA, minhash(lecture + '  ')) === 1)
ok('lsh: same signature → same bands', JSON.stringify(lshBands(mA)) === JSON.stringify(lshBands(minhash(lecture))))
ok('lsh: close versions share a band', lshBands(mA).some((b, i) => b === lshBands(mB)[i]))
ok('minhash: too short → null', minhash('كلمتان فقط') === null)
const g1 = Array.from({ length: 72 }, (_, i) => (i * 37) % 255)
const g2 = g1.map((v, i) => (i === 5 ? v + 40 : v))
ok('dhash: tiny change = small distance', hamming(dhash(g1), dhash(g2)) <= 2)
ok('dhash: blank page → null', dhash(new Array(72).fill(250)) === null)

// ------------------------------------------------------------ paper detection on a synthetic photo
function synth(w, h, angle, cx, cy, hw, hh) {
  const g = new Uint8Array(w * h)
  const cs = Math.cos(angle)
  const sn = Math.sin(angle)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const u = dx * cs + dy * sn
      const v = -dx * sn + dy * cs
      const inside = Math.abs(u) <= hw && Math.abs(v) <= hh
      g[y * w + x] = inside ? 225 + ((x * 7 + y * 3) % 20) : 40 + ((x + y) % 25)
      if (inside && Math.abs(v) < hh * 0.8 && (Math.round(v) % 9 === 0) && Math.abs(u) < hw * 0.8) g[y * w + x] = 30 // lines of «text»
    }
  const exp = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => ({ x: cx + u * cs - v * sn, y: cy + u * sn + v * cs }))
  return { g, exp }
}
for (const [a, label, hw, hh] of [[0, 'straight', 95, 120], [-0.15, 'tilted', 95, 120], [0.3, 'rotated 17°', 80, 100], [-0.45, 'rotated 26°', 70, 90]]) {
  const { g, exp } = synth(360, 270, a, 180, 135, hw, hh)
  const q = detectQuad(g, 360, 270)
  const err = q ? Math.max(...q.map((p, i) => Math.hypot(p.x - exp[i].x, p.y - exp[i].y))) : 99
  ok(`paper detection: ${label}`, err < 3, `max corner error ${err.toFixed(2)} px`)
}
ok('no paper → no quad', detectQuad(new Uint8Array(360 * 270).fill(60), 360, 270) === null)

// ------------------------------------------------------------ duplicate decisions
const me = { id: 'me', created_at: '2026-11-13T10:00:00Z', page_count: 2, text_chars: 900, needs_ocr: false, languages: ['ar'], pixels: 2_000_000, size: 400_000 }
const cand = (o) => ({ id: 'x', title: 't', file_name: null, doc_type: null, languages: ['ar'], page_count: 2, text_chars: 900, deleted: false, created_at: '2026-11-12T10:00:00Z', needs_ocr: false, summary_ar: null, sha256: false, text_equal: false, visual_pages: 0, text_pages: 0, minhash: null, identity: 0, pixels: 1_000_000, size: 200_000, linked: false, ...o })
ok('same bytes, the other came first → this copy steps aside', decide(me, [cand({ sha256: true })], true)[0]?.kind === 'drop')
ok('same bytes, this one came first → it stays (the later copy steps aside)', decide(me, [cand({ sha256: true, created_at: '2026-11-14T10:00:00Z' })], true).length === 0)
ok('same bytes, same instant → decided by id on both sides', decide({ ...me, id: 'b' }, [cand({ sha256: true, id: 'a', created_at: me.created_at })], true)[0]?.kind === 'drop' && decide({ ...me, id: 'a' }, [cand({ sha256: true, id: 'b', created_at: me.created_at })], true).length === 0)
ok('same text → owner decides', decide(me, [cand({ text_equal: true })], true)[0]?.kind === 'ask')
ok('better copy suggested', decide(me, [cand({ text_equal: true, needs_ocr: true, text_chars: 0 })], true)[0]?.suggestion === 'keep_new')
ok('part of a longer document → linked', (() => {
  const a = decide(me, [cand({ page_count: 10, visual_pages: 2 })], true)[0]
  return a?.kind === 'link' && a.relation === 'part' && a.from === 'me'
})())
ok('near text with AI → judged', decide(me, [cand({ minhash: 0.7 })], true)[0]?.kind === 'judge')
ok('near text without AI → version link', decide(me, [cand({ minhash: 0.8 })], false)[0]?.relation === 'version')
ok('same passport no., other language, no AI → translation', decide(me, [cand({ identity: 1, languages: ['es'] })], false)[0]?.relation === 'translation')
ok('already linked → nothing', decide(me, [cand({ text_equal: true, linked: true })], true).length === 0)

// ------------------------------------------------------------ approximate classifier
const cats = ['الدراسة والبحث العلمي', 'الهوية والحالة المدنية', 'الصحة', 'المال والبنوك والضرائب'].map((n, i) => ({ id: `c${i}`, parent_id: null, name_ar: n, name_fr: null, name_es: null, name_en: null, description: null, aliases: [norm(n)], icon: null, sort: i, origin: 'seed', archived: false, doc_count: 0 }))
const c1 = demoUnderstand({ fileName: 'x.txt', hint: '', pageTexts: [lecture], categories: cats })
ok('demo: lecture type', c1.doc_type === 'lecture')
ok('demo: title is the lecture line', c1.title === 'محاضرات في القانون الإداري', c1.title)
ok('demo: proposes «القانون الإداري» under studies', c1.category.proposal?.name_ar === 'القانون الإداري' && c1.category.proposal?.parent_id === 'c0')
ok('demo: professor found', c1.people.some((p) => personKey(p.name_ar) === 'محمد بنعلي'))
ok('demo: academic year', c1.dates.academic_year === '2018/2019')
const sanitas = 'SANITAS SEGUROS\nCertificado de afiliación al seguro de salud\nNIE: X1234567Z\nVálido hasta: 31/12/2026'
const c2 = demoUnderstand({ fileName: 'certificado.pdf', hint: '', pageTexts: [sanitas], categories: cats })
ok('demo: insurance certificate', c2.doc_type === 'certificate')
ok('demo: expiry date', c2.dates.expiry_date === '2026-12-31', String(c2.dates.expiry_date))
ok('demo: NIE kept as identifier', c2.identifiers.some((x) => x.value === 'X1234567Z'))
ok('demo: health insurance proposed under health', c2.category.proposal?.name_ar === 'التأمين الصحي' && c2.category.proposal?.parent_id === 'c2')
const withShelf = [...cats, { ...cats[0], id: 'c9', parent_id: 'c0', name_ar: 'القانون الإداري', aliases: [norm('القانون الإداري')] }]
ok('demo: existing shelf reused (no proposal)', (() => {
  const c = demoUnderstand({ fileName: 'x.txt', hint: '', pageTexts: [lecture], categories: withShelf })
  return c.category.existing_id === 'c9' && c.category.proposal === null
})())

// ------------------------------------------------------------ segments, costs, words
ok('segments: gaps filled, overlaps cut', JSON.stringify(normaliseSegments([{ first_page: 1, last_page: 2, title_ar: 'أ' }, { first_page: 2, last_page: 3, title_ar: 'ب' }, { first_page: 6, last_page: 9, title_ar: 'ج' }], 7).map((s) => [s.first_page, s.last_page])) === '[[1,2],[3,3],[4,5],[6,7]]')
ok('segments: nothing usable → one document', JSON.stringify(normaliseSegments([], 4)) === JSON.stringify([{ first_page: 1, last_page: 4, title_ar: '' }]))
ok('cost: Opus 5.5 1M in + 1M out = 24$', Math.abs(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) - 24) < 1e-9)
ok('cost: batch is half price', Math.abs(costOf('claude-opus-5-5', { input_tokens: 1e6 }, true) - 2) < 1e-9)
ok('estimate: a 4-page scan costs a few cents', estimateCost({ images: 4, outTokens: 7200 }) < 0.2)
ok('arabic counting', [1, 2, 5, 12].map(docsAr).join('|') === 'وثيقة واحدة|وثيقتان|5 وثائق|12 وثيقة')

// ------------------------------------------------------------ who reads a document (Opus / Sonnet)
{
  const { OPUS, SONNET, ECONOMY_FROM, economyWave, pickModel, readingMode, modelName, isSonnet, sonnetFallback } = await import('../src/ai/models.ts')
  ok('models: readable names', modelName('claude-opus-5-5') === 'Claude Opus 5.5' && modelName('claude-sonnet-5-5') === 'Claude Sonnet 5.5' && modelName('claude-opus-4-8') === 'Claude Opus 4.8' && modelName(null) === 'Claude')
  ok('models: unknown or missing setting is «auto»', readingMode(undefined) === 'auto' && readingMode('fast') === 'auto' && readingMode('sonnet') === 'sonnet' && readingMode('opus') === 'opus')
  // «auto»: one document → Opus
  let w = economyWave({ mode: 'auto', wave: false, busy: 1 })
  ok('auto: a single document is read by Opus', !w && pickModel({ mode: 'auto', wave: w }) === OPUS)
  ok('auto: four documents are still read by Opus', !economyWave({ mode: 'auto', wave: false, busy: ECONOMY_FROM - 1 }))
  // a big import → Sonnet until the line is empty
  w = economyWave({ mode: 'auto', wave: false, busy: ECONOMY_FROM })
  ok(`auto: ${ECONOMY_FROM} in line start an economy wave read by Sonnet`, w && pickModel({ mode: 'auto', wave: w }) === SONNET)
  w = economyWave({ mode: 'auto', wave: w, busy: 2 })
  ok('auto: the wave lasts while documents remain (the end of the import stays with Sonnet)', w && pickModel({ mode: 'auto', wave: w }) === SONNET)
  w = economyWave({ mode: 'auto', wave: w, busy: 0 })
  ok('auto: the wave ends when the line is empty; the next single document → Opus', !w && pickModel({ mode: 'auto', wave: economyWave({ mode: 'auto', wave: w, busy: 1 }) }) === OPUS)
  ok('«read again» is always Opus, even in a wave or with «Sonnet always»', pickModel({ mode: 'auto', wave: true, opus: true }) === OPUS && pickModel({ mode: 'sonnet', wave: false, opus: true }) === OPUS)
  ok('«Opus always» / «Sonnet always»', pickModel({ mode: 'opus', wave: true }) === OPUS && pickModel({ mode: 'sonnet', wave: false }) === SONNET && !economyWave({ mode: 'sonnet', wave: false, busy: 50 }))
  ok('isSonnet', isSonnet(SONNET) && isSonnet('claude-sonnet-5-5-20261001') && !isSonnet(OPUS) && !isSonnet(null))
  ok('cost: Sonnet 5.5 is exactly half of Opus 5.5', Math.abs(costOf(SONNET, { input_tokens: 1e6, output_tokens: 1e6 }) * 2 - costOf(OPUS, { input_tokens: 1e6, output_tokens: 1e6 })) < 1e-9)
  ok('estimate follows the model', Math.abs(estimateCost({ images: 4, outTokens: 7200, model: SONNET }) * 2 - estimateCost({ images: 4, outTokens: 7200, model: OPUS })) < 1e-9)
  ok('Sonnet declined → Opus reads it', sonnetFallback({ kind: 'refusal' }) === 'opus')
  ok('Sonnet refused / unknown / not allowed (400/404/403) → Opus, and no more Sonnet this session', [400, 404, 403].every((st) => sonnetFallback({ kind: st === 403 ? 'auth' : 'other', status: st }) === 'opus_off'))
  ok('no credit, no internet, rate limit, server error, bad key → the usual handling (no switch)', [{ kind: 'credit', status: 400 }, { kind: 'network' }, { kind: 'rate', status: 429 }, { kind: 'server', status: 500 }, { kind: 'auth', status: 401 }].every((e) => sonnetFallback(e) === null))
}

// ------------------------------------------------------------ structured-output schemas stay small (Anthropic refuses big grammars)
{
  const S = await import('../src/ai/schemas.ts')
  const { UNDERSTAND_SYSTEM } = await import('../src/ai/prompts.ts')
  const { normalizeCard, normalizeQuery } = await import('../src/ai/normalize.ts')
  const { DOC_TYPE_KEYS, PERSON_ROLES, ORG_KINDS, ID_KINDS } = await import('../src/lib/labels.ts')
  const measure = (schema) => {
    const m = { unions: 0, optional: 0, enums: 0, biggestEnum: 0, objectsOk: true }
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.anyOf || Array.isArray(n.type)) m.unions++
      if (n.enum) { m.enums++; m.biggestEnum = Math.max(m.biggestEnum, n.enum.length) }
      if (n.type === 'object') {
        const keys = Object.keys(n.properties ?? {})
        m.optional += keys.filter((k) => !(n.required ?? []).includes(k)).length
        if (n.additionalProperties !== false) m.objectsOk = false
      }
      Object.values(n).forEach(walk)
    }
    walk(schema)
    return m
  }
  const all = ['UNDERSTAND_SCHEMA', 'TRANSCRIBE_SCHEMA', 'SPLIT_SCHEMA', 'JUDGE_SCHEMA', 'QUERY_SCHEMA'].map((k) => [k, measure(S[k])])
  ok('schemas: no union type anywhere (they make the grammar explode)', all.every(([, m]) => m.unions === 0), JSON.stringify(all.map(([k, m]) => [k, m.unions])))
  ok('schemas: every property required, every object closed', all.every(([, m]) => m.optional === 0 && m.objectsOk))
  ok('schemas: understand and query carry no enum at all', measure(S.UNDERSTAND_SCHEMA).enums === 0 && measure(S.QUERY_SCHEMA).enums === 0)
  ok('schemas: the small ones keep only short enums (≤ 8 values)', all.every(([, m]) => m.biggestEnum <= 8))
  ok('prompt: the allowed values moved into the instructions', [...DOC_TYPE_KEYS, ...PERSON_ROLES, ...ORG_KINDS, ...ID_KINDS].every((v) => UNDERSTAND_SYSTEM.includes(v)) && UNDERSTAND_SYSTEM.includes('never null'))

  const card = normalizeCard({
    doc_type: 'ID_Document', title: ' Pasaporte ', title_ar: 'جواز السفر', summary_ar: 'ملخص', languages: ['ES', 'ar', 'de', 'ar'],
    category: { existing_id: '', proposal: { parent_id: '', name_ar: 'وثائق السفر', name_fr: 'Voyage', name_es: 'Viaje', name_en: 'Travel', reason_ar: 'سبب' }, confidence: 1.7 },
    people: [{ name_ar: 'ياسر', name_latin: 'Yassir', honorific: '', role: 'Holder', as_written: 'YASSIR' }, { name_ar: '', name_latin: '', honorific: '', role: 'author', as_written: '' }, { name_ar: 'سلمى', name_latin: 'Salma', honorific: 'null', role: 'doctor', as_written: '' }],
    organizations: [{ name: 'Consulado', name_latin: 'Consulado General', kind: 'Consulate', city: '' }],
    places: [{ name_ar: 'تطوان', name_latin: 'Tetuán', country: 'MA', role: 'issue place' }],
    dates: { document_date: '2025-07-29', precision: 'Day', academic_year: '', period_start: '', period_end: 'none', expiry_date: '2030-01-01' },
    identifiers: [{ kind: 'Passport No', value: 'X1' }, { kind: 'id_no', value: '' }, { kind: 'weird', value: 'R-9' }],
    status: { is_copy: true, certified_copy: false, apostille: 'yes', sworn_translation: false, translated_from: '' },
    sensitivity: 'VAULT', keywords: { ar: [' جواز ', 'جواز', ''], fr: ['passeport'], es: [], en: ['passport'] }, visual_features: 'ختم أزرق',
    deadlines: [{ date: '2030-01-01', title_ar: 'تجديد الجواز' }, { date: '', title_ar: 'بلا تاريخ' }], reason_ar: 'لأنه جواز', confidence: 'x',
  })
  ok('normalize: case-insensitive values (ID_Document, Holder, Consulate, issue place, Passport No, Day, VAULT)', card.doc_type === 'id_document' && card.people[0].role === 'holder' && card.organizations[0].kind === 'consulate' && card.places[0].role === 'issue_place' && card.identifiers[0].kind === 'passport_no' && card.dates.precision === 'day' && card.sensitivity === 'vault')
  ok('normalize: "" (and "null", "none") become null', card.category.existing_id === null && card.people[0].honorific === null && card.people[1].honorific === null && card.organizations[0].city === null && card.dates.academic_year === null && card.dates.period_end === null && card.status.translated_from === null && card.category.proposal.parent_id === null)
  ok('normalize: unknown values fall back safely', card.people[1].role === 'mentioned' && card.identifiers[1].kind === 'other' && card.languages.join() === 'es,ar,other')
  ok('normalize: empty people, identifiers and deadlines are dropped', card.people.length === 2 && card.identifiers.length === 2 && card.deadlines.length === 1)
  ok('normalize: trimmed, de-duplicated keywords; clamped confidences; booleans only when true', card.title === 'Pasaporte' && card.keywords.ar.join() === 'جواز' && card.category.confidence === 1 && card.confidence === 0.5 && card.status.is_copy === true && card.status.apostille === false)
  const none = normalizeCard({ doc_type: 'contract', category: { existing_id: 'abc', proposal: { parent_id: '', name_ar: '', name_fr: '', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.8 } })
  ok('normalize: a proposal with no name is no proposal; the chosen shelf is kept', none.category.proposal === null && none.category.existing_id === 'abc' && none.doc_type === 'contract')
  const junk = normalizeCard(null)
  ok('normalize: a missing answer still gives a complete card', junk.doc_type === 'other' && Array.isArray(junk.people) && junk.dates.document_date === null && junk.sensitivity === 'normal' && Array.isArray(junk.keywords.fr))
  const q = normalizeQuery({ text: 'محاضرات', doc_types: ['Lecture', 'spaceship'], category_ids: ['c1', ''], person_names: ['بنعلي'], year_from: 2018, year_to: 0, languages: ['FR', 'de'], sensitivity: '' })
  ok('normalize query: 0 → no year, "" → no sensitivity, unknown types and languages dropped', q.year_from === 2018 && q.year_to === null && q.sensitivity === null && q.doc_types.join() === 'lecture' && q.languages.join() === 'fr' && q.category_ids.join() === 'c1')
}

// ------------------------------------------------------------ safety net: a refused schema → plain JSON
{
  const { GRAMMAR_REFUSED, looseParams, parseLooseJson } = await import('../src/ai/loose.ts')
  const S = await import('../src/ai/schemas.ts')
  const seen = '400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues. Simplify your to'
  ok('loose: recognises the refusal the owner saw, and the documented one', GRAMMAR_REFUSED.test(seen) && GRAMMAR_REFUSED.test('Schema is too complex for compilation.') && !GRAMMAR_REFUSED.test('credit balance is too low'))
  const base = { system: [{ type: 'text', text: 'You are the archivist.' }, { type: 'text', text: 'shelves…', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'x' }], max_tokens: 16000, output_config: { effort: 'medium', format: { type: 'json_schema', schema: S.UNDERSTAND_SCHEMA } } }
  const loose = looseParams(base)
  ok('loose: no format any more, effort kept, the schema written into the instructions', !loose.output_config.format && loose.output_config.effort === 'medium' && loose.system.length === 3 && loose.system[2].text.includes('"doc_type"') && loose.system[1].cache_control?.type === 'ephemeral')
  const looseStr = looseParams({ ...base, system: 'Transcribe.', output_config: { effort: 'low', format: { type: 'json_schema', schema: S.TRANSCRIBE_SCHEMA } } })
  ok('loose: a plain-text system prompt gets the rule appended', typeof looseStr.system === 'string' && looseStr.system.startsWith('Transcribe.') && looseStr.system.includes('"legibility"'))
  ok('loose: a request without a schema is unchanged', looseParams({ ...base, output_config: { effort: 'low' } }).system === base.system)
  ok('parse: plain JSON', parseLooseJson('{"a":1}').a === 1)
  ok('parse: inside code fences', parseLooseJson('```json\n{"a":2}\n```').a === 2)
  ok('parse: a sentence around the object', parseLooseJson('Here it is: {"a":{"b":3}} — done').a.b === 3)
  let threw = false
  try {
    parseLooseJson('no json here')
  } catch {
    threw = true
  }
  ok('parse: no object → an error (the document is retried later)', threw)
}

// ------------------------------------------------------------ storage at risk (a nearly full disk)
{
  const { storageRisk } = await import('../src/lib/storage.ts')
  ok('storage: the owner\'s case (552 MB quota, 0.5 GB left on C:) is critical', storageRisk(552e6, 10e6) === 'critical')
  ok('storage: under 2 GB left is low, plenty is ok', storageRisk(1.5e9, 50e6) === 'low' && storageRisk(9e9, 50e6) === 'ok')
  ok('storage: a nearly full quota is at risk too', storageRisk(9e9, 8.5e9) === 'critical' && storageRisk(9e9, 7e9) === 'low')
  ok('storage: an unknown quota raises no alarm', storageRisk(0, 0) === 'ok')
}

// ------------------------------------------------------------ «اسأل خزانتك»: tools' output and citations
{
  const { parsePages, hitsBrief, docBrief, splitCitations, citedIds, UUID } = await import('../src/ai/ask-format.ts')
  ok('ask: page ranges', JSON.stringify(parsePages('1-3,7', 10)) === '[1,2,3,7]' && JSON.stringify(parsePages('9-12', 10)) === '[9,10]' && JSON.stringify(parsePages('5-2', 9)) === '[2,3,4,5]' && parsePages('', 5) === null && parsePages('abc', 5) === null && parsePages(undefined, 5) === null)
  const id1 = '11111111-2222-4333-8444-555555555555'
  const hit = { id: id1, title: 'Contrato de alquiler', title_ar: 'عقد إيجار سكن مفروش', file_name: 'c.pdf', summary_ar: 'عقد إيجار', doc_type: 'contract', doc_date: '2025-10-13', date_precision: 'day', academic_year: null, expiry_date: '2026-10-12', languages: ['es'], state: 'ready', state_detail: null, page_count: 8, sensitivity: 'private', favorite: false, pinned_offline: false, created_at: '', deleted_at: null, category_id: 'c', category_path: [{ id: 'a', name: 'السكن والعقار' }], proposal_id: null, proposal_name: null, location: 'صندوق 3', thumb: null, people: [], rank: 1, best_page: 2, snippet: 'La duración del contrato es de doce meses' }
  const brief = hitsBrief([hit], 3)
  ok('ask: search hits carry id, title, dates, shelf, original and the best passage', brief.includes(id1) && brief.includes('عقد إيجار سكن مفروش') && brief.includes('valid until: 2026-10-12') && brief.includes('السكن والعقار') && brief.includes('صندوق 3') && brief.includes('(page 2)') && brief.startsWith('3 document(s)'))
  ok('ask: no hit → advice to search again differently', hitsBrief([], 0).includes('Try other words'))
  const doc = {
    ...hit, source: 'upload', category_id: 'c', proposal_id: null, category_confidence: 0.9, period_start: '2025-10-13', period_end: '2026-10-12',
    identifiers: [{ kind: 'reference', value: 'R-77' }], status: { is_copy: true, apostille: false }, keywords: [], visual_features: null, ai_reason: null, ai_confidence: null, ai_model: 'claude-sonnet-5-5', ai_mode: 'claude',
    needs_ocr: false, text_chars: 0, text_hash: null, original_location_id: null, original_note: 'الدرج الأعلى', tags: [], updated_at: '', processed_at: null, session_id: null,
    proposal: null, location: { id: 'l', code: 'B3', name: 'صندوق 3', kind: 'box', place: 'بيت العائلة', notes: null, parent_id: null, created_at: '' }, files: [],
    entities: [{ id: 'e', kind: 'person', name: 'ياسر', name_latin: 'Yassir', honorific: null, role: 'signatory', as_written: null, confirmed: true }],
    links: [], deadlines: [{ id: 'd', document_id: id1, kind: 'expiry', due_date: '2026-10-12', title: 'نهاية العقد', done: false }], reviews: [], corrected: [],
    pages: Array.from({ length: 8 }, (_, i) => ({ page_no: i + 1, text: `نص الصفحة ${i + 1} `.repeat(400), blank: false, legibility: 'good', text_source: 'ocr', width: null, height: null })),
  }
  const full = docBrief(doc, null, 9000)
  ok('ask: the card comes first (dates, identifiers, people, status, original, deadlines)', full.includes('period: 2025-10-13 → 2026-10-12') && full.includes('reference: R-77') && full.includes('ياسر / Yassir (person, signatory)') && full.includes('Status: a copy') && full.includes('صندوق 3 — بيت العائلة — الدرج الأعلى') && full.includes('2026-10-12 — نهاية العقد'))
  ok('ask: a long document is cut, saying which pages to ask for', full.length < 9600 && /Pages not shown: [\d, ]+\. Ask for them with pages/.test(full))
  const two = docBrief(doc, parsePages('7-8', 8))
  ok('ask: asked pages only', two.includes('--- page 7 ---') && two.includes('--- page 8 ---') && !two.includes('--- page 1 ---'))
  const answer = `ينتهي العقد يوم 12 أكتوبر 2026 [[doc:${id1}|p:2]]، ومدته سنة [[doc:${id1}]].\nانظر [[doc:${id1.toUpperCase()}|page 3]] و[[doc:99999999-2222-4333-8444-555555555555|p:1]] [[doc:${id1}|p:`
  const parts = splitCitations(answer)
  const cites = parts.filter((p) => p.kind === 'cite')
  ok('ask: citations parsed (page or not, any case); a half-written one at the end is dropped', cites.length === 4 && cites[0].page === 2 && cites[1].page === null && cites[2].page === 3 && cites[2].id === id1 && !parts.some((p) => p.kind === 'text' && p.text.includes('[[')))
  ok('ask: cited documents once each, in order', JSON.stringify(citedIds(answer)) === JSON.stringify([id1, '99999999-2222-4333-8444-555555555555']))
  ok('ask: ids are checked before reading', UUID.test(id1) && !UUID.test('1; drop table'))
}

// ------------------------------------------------------------ phone reminders through Google Calendar (a fake calendar)
{
  const { planReminders, syncReminders, eventId, addDays, CalendarError, CAL_NAME } = await import('../src/drive/calendar.ts')
  const today = '2026-11-14'
  const app = 'https://mykhizana.github.io/khizana/'
  const rows = [
    { id: 'a1', due_date: addDays(today, 90), kind: 'expiry', title: 'انتهاء صلاحية بطاقة الإقامة', document_id: 'd1', doc_title: 'بطاقة الإقامة TIE', vault: false },
    { id: 'a2', due_date: addDays(today, 20), kind: 'action', title: 'الرد على رسالة الضرائب', document_id: 'd2', doc_title: 'رسالة الضرائب', vault: false },
    { id: 'a3', due_date: addDays(today, 200), kind: 'expiry', title: null, document_id: 'd3', doc_title: null, vault: true },
    { id: 'a4', due_date: addDays(today, -3), kind: 'expiry', title: 'فات', document_id: null, doc_title: null, vault: false },
  ]
  const plan = planReminders(rows, today, app)
  ok('reminders: 2 months, 1 month, 1 week and the day — only those still ahead', plan.filter((e) => e.key === 'a1').length === 4 && plan.filter((e) => e.key === 'a2').length === 2 && plan.filter((e) => e.key === 'a3').length === 4 && !plan.some((e) => e.key === 'a4'))
  const a1 = plan.filter((e) => e.key === 'a1').map((e) => e.summary)
  ok('reminders: readable titles', a1[0] === 'بعد شهرين: انتهاء صلاحية بطاقة الإقامة' && a1[3] === 'اليوم: انتهاء صلاحية بطاقة الإقامة')
  const vault = plan.filter((e) => e.key === 'a3')
  ok('reminders: a vault document shows nothing of itself (neutral title, no name)', vault.every((e) => e.summary.endsWith('تنتهي صلاحية وثيقة من خزنتك') && !e.description.includes('null') && e.description.includes('خزنتك')))
  ok('reminders: each one links to its document in the app', plan.find((e) => e.key === 'a1').description.includes(`${app}doc/d1`))
  ok('reminders: event ids are stable and valid for Google (base32hex)', plan.every((e) => /^[a-v0-9]{5,1024}$/.test(e.id)) && eventId('a1|60') === eventId('a1|60') && eventId('a1|60') !== eventId('a1|30'))

  // a small Google Calendar in memory
  const cals = new Map()
  let made = 0
  const calls = []
  let failNext = 0
  const fake = async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    calls.push(`${method} ${u.pathname}`)
    const res = (o, status = 200) => new Response(status === 204 ? null : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
    if (failNext) {
      failNext--
      return res({ error: 'expired' }, 401)
    }
    const m = u.pathname.match(/^\/calendar\/v3\/calendars(?:\/([^/]+))?(?:\/events(?:\/([^/]+))?)?$/)
    if (!m) return res({}, 404)
    const [, calId, evId] = m
    if (!calId) {
      const id = `cal${++made}@group.calendar.google.com`
      cals.set(id, { summary: body.summary, events: new Map() })
      return res({ id, summary: body.summary })
    }
    const cal = cals.get(decodeURIComponent(calId))
    if (!cal) return res({ error: 'notFound' }, 404)
    if (!u.pathname.includes('/events')) return res({ id: decodeURIComponent(calId) })
    if (!evId && method === 'GET') return res({ items: [...cal.events.values()].filter((e) => e.status !== 'cancelled') })
    if (!evId && method === 'POST') {
      if (cal.events.has(body.id)) return res({ error: 'duplicate' }, 409)
      cal.events.set(body.id, { ...body, start: { dateTime: `${body.start.dateTime}+01:00` } })
      return res(body)
    }
    if (method === 'PUT') {
      cal.events.set(evId, { ...body, start: { dateTime: `${body.start.dateTime}+01:00` } })
      return res(body)
    }
    if (method === 'DELETE') {
      const e = cal.events.get(evId)
      if (!e || e.status === 'cancelled') return res({}, 410)
      e.status = 'cancelled'
      return res(null, 204)
    }
    return res({}, 400)
  }
  const deps = { fetch: fake, token: async () => 'tok', base: 'https://fake.test/calendar/v3' }
  const sync = (r, calendarId, day = today) => syncReminders(deps, { calendarId, rows: r, today: day, tz: 'Africa/Casablanca', appUrl: app })
  const live = (id) => [...cals.get(id).events.values()].filter((e) => e.status !== 'cancelled')

  const s1 = await sync(rows, null)
  ok('sync: creates the app calendar and writes every reminder', cals.get(s1.calendarId)?.summary === CAL_NAME && s1.created === plan.length && live(s1.calendarId).length === plan.length)
  const ev = live(s1.calendarId)[0]
  ok('sync: at 9:00 in the owner time zone, a phone notification at that time, not busy', ev.start.dateTime.includes('T09:00:00') && ev.reminders.overrides[0].method === 'popup' && ev.reminders.overrides[0].minutes === 0 && ev.transparency === 'transparent' && ev.extendedProperties.private.kh === '1')
  const s2 = await sync(rows, s1.calendarId)
  ok('sync: nothing changed → nothing written', s2.created === 0 && s2.updated === 0 && s2.deleted === 0 && s2.calendarId === s1.calendarId)
  const moved = rows.map((r) => (r.id === 'a1' ? { ...r, due_date: addDays(today, 100) } : r))
  const s3 = await sync(moved, s1.calendarId)
  ok('sync: a deadline that moved moves its reminders (same events, updated)', s3.updated === 4 && s3.created === 0 && s3.deleted === 0)
  const s4 = await sync(moved.filter((r) => r.id !== 'a2'), s1.calendarId)
  ok('sync: a deadline done or deleted takes its reminders away', s4.deleted === 2 && live(s1.calendarId).length === plan.length - 2)
  const s5 = await sync(moved, s1.calendarId)
  ok('sync: it comes back → its reminders come back (the cancelled events revived)', s5.created === 2 && live(s1.calendarId).length === plan.length)
  const s6 = await sync(moved, s1.calendarId, addDays(today, 35))
  ok('sync: days pass → the reminders already past are removed, none rewritten', s6.created === 0 && s6.deleted > 0 && live(s1.calendarId).every((e) => e.start.dateTime.slice(0, 10) >= addDays(today, 35)))
  cals.delete(s1.calendarId)
  const s7 = await sync(rows, s1.calendarId)
  ok('sync: the calendar was deleted by hand → a new one is made', s7.calendarId !== s1.calendarId && s7.created === plan.length)
  failNext = 1
  let err = null
  try {
    await sync(rows, s7.calendarId)
  } catch (e) {
    err = e
  }
  ok('sync: an expired permission is reported as such (no half-written state claimed)', err instanceof CalendarError && err.auth)
}

// ------------------------------------------------------------ the checklist of a procedure (ready dossiers)
{
  const { cleanChecklist } = await import('../src/ai/checklist.ts')
  const known = { 'doc-1': 'جواز السفر', 'doc-2': 'شهادة السكنى' }
  const c = cleanChecklist(
    {
      procedure: ' تجديد بطاقة الإقامة ',
      summary: 'تُقدَّم في مكتب الأجانب.',
      requirements: [
        { label: 'جواز السفر', status: 'Found', document_id: 'doc-1', note: 'صالح' },
        { label: 'شهادة السكنى', status: 'expired', document_id: 'doc-2', note: '' },
        { label: 'صورتان', status: 'missing', document_id: '', note: 'غير موجودة' },
        { label: 'عقد العمل', status: 'found', document_id: 'invented-id', note: '' },
        { label: '  ', status: 'found', document_id: 'doc-1' },
        { label: 'التأمين الصحي', status: 'maybe', document_id: 'doc-1', note: 'x'.repeat(400) },
        'garbage',
      ],
    },
    known,
  )
  ok('checklist: statuses kept and read case-insensitively', c.requirements[0].status === 'found' && c.requirements[1].status === 'expired' && c.requirements[2].status === 'missing')
  ok('checklist: a document id the tools never gave is dropped (the paper counts as missing)', c.requirements[3].document_id === null && c.requirements[3].status === 'missing')
  ok('checklist: empty lines and junk are skipped, unknown statuses become «unsure», long notes are cut', c.requirements.length === 5 && c.requirements[4].status === 'unsure' && c.requirements[4].note.length === 300)
  ok('checklist: procedure and summary trimmed; an empty note is null', c.procedure === 'تجديد بطاقة الإقامة' && c.summary === 'تُقدَّم في مكتب الأجانب.' && c.requirements[1].note === null)
  ok('checklist: nothing usable → an empty list, no error', cleanChecklist(null, known).requirements.length === 0 && cleanChecklist({ requirements: 'x' }, known).requirements.length === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
