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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
