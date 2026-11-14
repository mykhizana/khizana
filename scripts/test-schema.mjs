// npm run test:db — runs supabase/schema.sql (twice: it must be idempotent) in an in-memory Postgres
// (PGlite) with the local stand-ins, then checks the API functions and the security rules.
// Nothing touches a real database.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'

process.on('uncaughtException', (e) => {
  console.error('ERROR:', e.message, e.where ? `\n  where: ${e.where}` : '', e.internalQuery ? `\n  query: ${String(e.internalQuery).slice(0, 300)}` : '')
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('ERROR:', e?.message, e?.where ? `\n  where: ${e.where}` : '', e?.internalQuery ? `\n  query: ${String(e.internalQuery).slice(0, 300)}` : '')
  process.exit(1)
})
const stubs = readFileSync(new URL('../supabase/local-stubs.sql', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
}
const fails = async (name, fn, expect = /./) => {
  try {
    await fn()
    ok(name, false, 'no error')
  } catch (e) {
    ok(name, expect.test(String(e.message)), String(e.message).slice(0, 100))
  }
}

async function fresh() {
  const db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(stubs)
  await db.exec(schema)
  return db
}

const A = '00000000-0000-4000-8000-0000000000aa'
const B = '00000000-0000-4000-8000-0000000000bb'

const db = await fresh()
await db.exec(schema) // second run: idempotent
ok('schema runs twice', true)

let current = A
let claims = ''
async function call(fn, p = {}) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`, [current, claims])
  await db.exec('set role authenticated')
  try {
    const r = await db.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)])
    return r.rows[0].r
  } finally {
    await db.exec('reset role')
  }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0]

// ------------------------------------------------------------ text helpers
ok('norm: hamza + ta marbuta', (await one(`select kh_norm('الإدارة') v`)).v === 'الاداره')
ok('norm: diacritics', (await one(`select kh_norm('مُحَمَّد') v`)).v === 'محمد')
ok('norm: latin accents', (await one(`select kh_norm('Décentralisation, Año') v`)).v === 'decentralisation ano')
ok('norm: eastern digits', (await one(`select kh_norm('سنة ٢٠١٨') v`)).v === 'سنه 2018')
ok('stem: الاداري → ادار', (await one(`select kh_stem('الاداري') v`)).v === 'ادار')
ok('stem: اداره → ادار', (await one(`select kh_stem('اداره') v`)).v === 'ادار')
ok('stem: documents → document', (await one(`select kh_stem('documents') v`)).v === 'document')
ok('person key: titles removed (ar)', (await one(`select kh_person_key('الأستاذ الدكتور محمد بنعلي') v`)).v === 'محمد بنعلي')
ok('person key: titles removed (fr)', (await one(`select kh_person_key('Pr. M. BENALI') v`)).v === 'benali')
ok('tsquery: prefix + stem', String((await one(`select kh_tsquery('الإدارية', 'and')::text v`)).v).includes(':*'))

// ------------------------------------------------------------ bootstrap
const boot = await call('kh_bootstrap')
ok('bootstrap: settings', boot.settings.autonomy === 'ask' && Number(boot.settings.monthly_cap_usd) === 60)
const cats = await call('kh_categories_list')
ok('bootstrap: 10 seed categories', cats.length === 10, String(cats.length))
await call('kh_bootstrap')
ok('bootstrap twice: still 10', (await call('kh_categories_list')).length === 10)
const studies = cats.find((c) => c.name_ar === 'الدراسة والبحث العلمي')
const identity = cats.find((c) => c.name_ar === 'الهوية والحالة المدنية')

// ------------------------------------------------------------ locations + sessions
const box = await call('kh_location_save', { name: 'صندوق 3', place: 'بيت العائلة — تطوان' })
ok('location: code generated', /^[2-9A-HJ-NP-Z]{5}$/.test(box.code), box.code)
ok('location by code', (await call('kh_location_by_code', { code: box.code.toLowerCase() }))?.id === box.id)
const sess = await call('kh_session_start', { kind: 'scan', location_id: box.id })

// ------------------------------------------------------------ documents
const mh = (seed, n = 128) => Array.from({ length: n }, (_, i) => ((i * 2654435761 + seed) | 0))
const lshOf = (m) => Array.from({ length: 32 }, (_, b) => String(m.slice(b * 4, b * 4 + 4).reduce((h, v) => (h * 31 + v) | 0, 7)))
const mA = mh(1)
const d1 = await call('kh_doc_create', {
  file_name: 'cours-droit-admin-2018.pdf', source: 'upload', session_id: sess.id, page_count: 2, text_chars: 900,
  text_hash: 'T1', minhash: mA, lsh: lshOf(mA),
  files: [{ role: 'original', path: `${A}/x/orig.pdf`, mime: 'application/pdf', size: 1000, sha256: 'sha-one' }, { role: 'thumb', path: `${A}/x/thumb.jpg` }],
  pages: [
    { page_no: 1, text: 'محاضرة في القانون الإداري: مبادئ الإدارة العمومية والمرافق العامة', text_source: 'pdf', text_hash: 'P1', phash: '1234567890123' },
    { page_no: 2, text: 'الجهوية المتقدمة واللامركزية الإدارية في المغرب', text_source: 'pdf', text_hash: 'P2', phash: '987654321987' },
  ],
})
ok('doc create', !!d1.id)
const scanOnly = await call('kh_doc_create', { file_name: 'scan.jpg', needs_ocr: true, page_count: 1, minhash: null, lsh: null, text_hash: null, files: [{ role: 'page', page_no: 1, path: `${A}/s/p1.jpg` }], pages: [{ page_no: 1, phash: '42' }] })
ok('doc create without text fingerprints (a fresh scan)', !!scanOnly.id)
await call('kh_doc_purge', { id: scanOnly.id })
let doc1 = await call('kh_doc_get', { id: d1.id })
ok('doc inherits the session box', doc1.original_location_id === box.id)
ok('doc has 2 pages + 2 files', doc1.pages.length === 2 && doc1.files.length === 2)

let s = await call('kh_search', { q: 'إدارة' })
ok('search: إدارة finds الإدارة/الإداري (stem)', s.total === 1 && s.items[0].id === d1.id, `total=${s.total} mode=${s.mode}`)
ok('search: best page + snippet', s.items[0].best_page >= 1 && typeof s.items[0].snippet === 'string' && s.items[0].snippet.length > 10)
s = await call('kh_search', { q: 'الجهوية' })
ok('search: page 2 word', s.total === 1 && s.items[0].best_page === 2, `best=${s.items[0]?.best_page}`)
s = await call('kh_search', { q: 'محاضرة القانون' })
ok('search: two words (all)', s.mode === 'all' && s.total === 1)
s = await call('kh_search', { q: 'محاضرة زرافة' })
ok('search: falls back to any word', s.mode === 'any' && s.total === 1, s.mode)

// ------------------------------------------------------------ the AI card
const card = (over = {}) => ({
  doc_type: 'lecture', title: 'Cours de droit administratif', title_ar: 'محاضرات في القانون الإداري', summary_ar: 'محاضرات حول مبادئ القانون الإداري.',
  languages: ['ar'], category: { existing_id: studies.id, proposal: { parent_id: studies.id, name_ar: 'القانون الإداري', name_fr: 'Droit administratif', name_es: 'Derecho administrativo', name_en: 'Administrative law', reason_ar: 'لا توجد فئة للقانون الإداري' }, confidence: 0.9 },
  people: [{ name_ar: 'محمد بنعلي', name_latin: 'Mohamed Benali', honorific: 'د.', role: 'professor', as_written: 'د. محمد بنعلي' }],
  organizations: [{ name: 'كلية العلوم القانونية بتطوان', name_latin: 'FSJES Tétouan', kind: 'faculty', city: 'تطوان' }],
  places: [{ name_ar: 'تطوان', name_latin: 'Tetouan', country: 'MA', role: 'issue_place' }],
  dates: { document_date: '2018-11-05', precision: 'day', academic_year: '2018/2019', period_start: null, period_end: null, expiry_date: null },
  identifiers: [], status: { is_copy: false, certified_copy: false, apostille: false, sworn_translation: false, translated_from: null },
  sensitivity: 'normal', keywords: { ar: ['القانون الإداري'], fr: ['droit administratif'], es: ['derecho administrativo'], en: ['administrative law'] },
  visual_features: 'شعار الكلية أعلى الصفحة', deadlines: [], reason_ar: 'محاضرة جامعية', confidence: 0.92, ...over,
})
let ap = await call('kh_doc_apply_ai', { id: d1.id, card: card(), mode: 'claude', model: 'claude-opus-5-5' })
ok('apply: a new category is proposed (owner decides)', ap.proposal_new === true && !!ap.proposal_id)
doc1 = await call('kh_doc_get', { id: d1.id })
ok('apply: doc waits in the parent category', doc1.category_id === studies.id && doc1.proposal_id === ap.proposal_id)
ok('apply: people + org + place linked', doc1.entities.length === 3, String(doc1.entities.length))
s = await call('kh_search', { q: 'administratif' })
ok('search: french keyword from the AI', s.total === 1)
s = await call('kh_search', { q: 'بنعلي' })
ok('search: professor name', s.total === 1)
s = await call('kh_search', { q: 'بنعلى' })
ok('search: typo ى/ي normalised', s.total === 1, s.mode)
s = await call('kh_search', { q: 'Benali' })
ok('search: latin spelling of the name', s.total === 1)
s = await call('kh_search', { q: 'محاضره', filters: { year_from: 2018, year_to: 2018 } })
ok('search: year filter', s.total === 1)
s = await call('kh_search', { q: 'محاضره', filters: { year_from: 2019 } })
ok('search: year filter excludes', s.total === 0)
ok('search: facets', s.facets && Array.isArray(s.facets.doc_type))

// a second document with nearly the same proposal joins the same question
const d2 = await call('kh_doc_create', { file_name: 'td-admin.pdf', page_count: 1, pages: [{ page_no: 1, text: 'أعمال موجهة في القانون الاداري والقرارات الإدارية' }] })
ap = await call('kh_doc_apply_ai', { id: d2.id, card: card({ title_ar: 'أعمال موجهة في القانون الإداري', category: { existing_id: studies.id, proposal: { parent_id: studies.id, name_ar: 'القانون الاداري', name_fr: 'Droit administratif', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.8 }, people: [{ name_ar: 'محمد بنعلي', name_latin: 'M. Benali', honorific: 'د.', role: 'professor', as_written: 'ذ. بنعلي' }] }), mode: 'claude' })
ok('apply: similar proposal grouped', ap.proposal_new === false)
let rv = await call('kh_reviews_list')
ok('reviews: one proposal with 2 documents', rv.proposals.length === 1 && rv.proposals[0].docs.length === 2, String(rv.proposals.length))
const people = await call('kh_entities_list', { kind: 'person' })
ok('people: same professor matched (not duplicated)', people.length === 1 && people[0].doc_count === 2, JSON.stringify(people.map((p) => p.name)))
ok('people: a «new person» question exists', rv.items.some((i) => i.kind === 'person_new'))

// a third doc about the topic BEFORE the category exists (for backfill)
const d3 = await call('kh_doc_create', { file_name: 'notes.txt', page_count: 1, pages: [{ page_no: 1, text: 'ملخص القانون الإداري: العقود الإدارية' }] })
await call('kh_doc_update', { id: d3.id, fields: { category_id: studies.id, title_ar: 'ملخص القانون الإداري' } })

let res = await call('kh_proposal_resolve', { id: rv.proposals[0].id, action: 'accept', edits: { name_ar: 'القانون الإداري' } })
ok('accept: category created + 2 docs moved', !!res.category_id && res.moved === 2)
ok('accept: older matching doc suggested (backfill)', res.backfill.some((b) => b.id === d3.id), JSON.stringify(res.backfill))
const adminCat = res.category_id
doc1 = await call('kh_doc_get', { id: d1.id })
ok('accept: doc in the new category', doc1.category_id === adminCat && doc1.proposal_id === null)
ok('category path root → leaf', doc1.category_path.length === 2 && doc1.category_path[1].name === 'القانون الإداري')
rv = await call('kh_reviews_list')
const back = rv.items.find((i) => i.kind === 'backfill')
ok('backfill question created', !!back)
await call('kh_review_resolve', { id: back.id, decision: { ids: [d3.id] } })
ok('backfill applied', (await call('kh_doc_get', { id: d3.id })).category_id === adminCat)

// the same proposal again → existing category used (no duplicate category)
const d4 = await call('kh_doc_create', { file_name: 'admin2.pdf', page_count: 1, pages: [{ page_no: 1, text: 'القضاء الإداري' }] })
ap = await call('kh_doc_apply_ai', { id: d4.id, card: card({ category: { existing_id: studies.id, proposal: { parent_id: studies.id, name_ar: 'القانون الإداري', name_fr: '', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.8 } }), mode: 'claude' })
ok('no duplicate category: existing one reused', !ap.proposal_id && ap.category_id === adminCat)

// reject → never proposed again; remap → learned mapping
const d5 = await call('kh_doc_create', { file_name: 'x.pdf', page_count: 1, pages: [{ page_no: 1, text: 'نص' }] })
ap = await call('kh_doc_apply_ai', { id: d5.id, card: card({ category: { existing_id: null, proposal: { parent_id: studies.id, name_ar: 'مواد متفرقة', name_fr: '', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.7 } }), mode: 'claude' })
await call('kh_proposal_resolve', { id: ap.proposal_id, action: 'reject' })
const d6 = await call('kh_doc_create', { file_name: 'y.pdf', page_count: 1, pages: [{ page_no: 1, text: 'نص' }] })
ap = await call('kh_doc_apply_ai', { id: d6.id, card: card({ category: { existing_id: null, proposal: { parent_id: studies.id, name_ar: 'مواد متفرقة', name_fr: '', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.7 } }), mode: 'claude' })
ok('rejected proposal is not asked again', !ap.proposal_id && ap.category_id === studies.id)
const d7 = await call('kh_doc_create', { file_name: 'z.pdf', page_count: 1, pages: [{ page_no: 1, text: 'نص' }] })
ap = await call('kh_doc_apply_ai', { id: d7.id, card: card({ category: { existing_id: null, proposal: { parent_id: null, name_ar: 'بطائق التعريف', name_fr: '', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.7 } }), mode: 'claude' })
await call('kh_proposal_resolve', { id: ap.proposal_id, action: 'remap', category_id: identity.id })
const d8 = await call('kh_doc_create', { file_name: 'w.pdf', page_count: 1, pages: [{ page_no: 1, text: 'نص' }] })
ap = await call('kh_doc_apply_ai', { id: d8.id, card: card({ category: { existing_id: null, proposal: { parent_id: null, name_ar: 'بطائق التعريف', name_fr: '', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.7 } }), mode: 'claude' })
ok('remap is learned', !ap.proposal_id && ap.category_id === identity.id)

// autonomy auto → created without asking
await call('kh_setting_set', { key: 'autonomy', value: 'auto' })
const d9 = await call('kh_doc_create', { file_name: 'med.pdf', page_count: 1, pages: [{ page_no: 1, text: 'تحاليل' }] })
ap = await call('kh_doc_apply_ai', { id: d9.id, card: card({ category: { existing_id: null, proposal: { parent_id: null, name_ar: 'التحاليل الطبية', name_fr: 'Analyses', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.8 } }), mode: 'claude' })
ok('autonomy auto: category created directly', !ap.proposal_id && !!ap.category_id && ap.category_id !== studies.id)
await call('kh_setting_set', { key: 'autonomy', value: 'ask' })

// person: a close but uncertain name → a question; answer «same» → merged
const d10 = await call('kh_doc_create', { file_name: 'p.pdf', page_count: 1, pages: [{ page_no: 1, text: 'نص' }] })
await call('kh_doc_apply_ai', { id: d10.id, card: card({ people: [{ name_ar: 'محمد بن علي', name_latin: 'Mohammed Ben Ali', honorific: null, role: 'author', as_written: 'محمد بن علي' }] }), mode: 'claude' })
rv = await call('kh_reviews_list')
const pm = rv.items.find((i) => i.kind === 'person_match')
ok('uncertain person → question', !!pm, JSON.stringify(rv.items.map((i) => i.kind)))
if (pm) {
  await call('kh_review_resolve', { id: pm.id, decision: { same: true } })
  const list = await call('kh_entities_list', { kind: 'person' })
  ok('answer «same» merges the two', list.length === 1 && list[0].doc_count >= 3, JSON.stringify(list.map((p) => [p.name, p.doc_count])))
}

// owner corrections are never overwritten by the AI
await call('kh_doc_update', { id: d1.id, fields: { title_ar: 'عنوان صححته بنفسي' } })
await call('kh_doc_apply_ai', { id: d1.id, card: card(), mode: 'claude' })
ok('owner correction kept', (await call('kh_doc_get', { id: d1.id })).title_ar === 'عنوان صححته بنفسي')

// ------------------------------------------------------------ duplicates
ok('sha lookup before upload', (await call('kh_sha_lookup', { sha256s: ['sha-one', 'nope'] })).length === 1)
const mB = mA.map((v, i) => (i % 10 === 0 ? v + 1 : v)) // ~90 % the same
const dup = await call('kh_doc_create', {
  file_name: 'scan-du-cours.jpg', page_count: 1, text_chars: 880, text_hash: 'T1x', minhash: mB, lsh: lshOf(mB),
  files: [{ role: 'original', path: `${A}/y/o.jpg`, sha256: 'sha-two' }],
  pages: [{ page_no: 1, text: 'محاضرة في القانون الإداري: مبادئ الإدارة العمومية والمرافق العامة', phash: String(1234567890123n ^ 0b101n), text_hash: 'P1' }],
})
let cand = await call('kh_dup_candidates', { id: dup.id })
const c1 = cand.find((c) => c.id === d1.id)
ok('dup: visual page twin (layer 3)', c1?.visual_pages === 1, JSON.stringify(c1))
ok('dup: same page text (layer 5)', c1?.text_pages === 1)
ok('dup: near-same text (layer 4 minhash)', c1?.minhash >= 0.85, String(c1?.minhash))
const exact = await call('kh_doc_create', { file_name: 'copy.pdf', page_count: 1, text_chars: 900, text_hash: 'T1', files: [{ role: 'original', path: `${A}/z/o.pdf`, sha256: 'sha-one' }], pages: [{ page_no: 1, text: 'x' }] })
cand = await call('kh_dup_candidates', { id: exact.id })
ok('dup: exact file (layer 1) + same text (layer 2)', cand.some((c) => c.id === d1.id && c.sha256 && c.text_equal))
const pass1 = await call('kh_doc_create', { file_name: 'passport.jpg', page_count: 1, pages: [{ page_no: 1, text: 'passport' }] })
await call('kh_doc_apply_ai', { id: pass1.id, card: card({ doc_type: 'id_document', languages: ['fr'], identifiers: [{ kind: 'passport_no', value: 'AB 123456' }], category: { existing_id: identity.id, proposal: null, confidence: 0.9 } }), mode: 'claude' })
const pass2 = await call('kh_doc_create', { file_name: 'pasaporte-traduccion.pdf', page_count: 1, pages: [{ page_no: 1, text: 'pasaporte' }] })
await call('kh_doc_apply_ai', { id: pass2.id, card: card({ doc_type: 'id_document', languages: ['es'], identifiers: [{ kind: 'passport_no', value: 'ab123456' }], category: { existing_id: identity.id, proposal: null, confidence: 0.9 } }), mode: 'claude' })
cand = await call('kh_dup_candidates', { id: pass2.id })
ok('dup: same passport number across languages (layer 6)', cand.some((c) => c.id === pass1.id && c.identity === 1))
await call('kh_link_set', { from_id: pass2.id, to_id: pass1.id, relation: 'translation', method: 'ai', confidence: 0.95, reason: 'ترجمة' })
const g = await call('kh_doc_get', { id: pass1.id })
ok('link visible from the original', g.links.some((l) => l.relation === 'translation' && l.direction === 'in'))

// ------------------------------------------------------------ «صوّر لتتحقق»: a photo of a page finds the archived page
const look = await call('kh_phash_lookup', { phash: String(1234567890123n ^ 0b11n), max: 10 })
ok('photo check finds the archived page', look.some((m) => m.document_id === d1.id && m.page_no === 1 && m.distance === 2), JSON.stringify(look.map((m) => [m.title, m.distance])))
ok('photo check: nothing similar → empty', (await call('kh_phash_lookup', { phash: '-6000000000000000000' })).length === 0)
ok('photo check: junk input → empty, no error', (await call('kh_phash_lookup', { phash: 'x; drop table' })).length === 0)

// ------------------------------------------------------------ a scanned stack split into documents
const stack = await call('kh_doc_create', {
  file_name: 'رزمة', source: 'stack', needs_ocr: false, page_count: 3, session_id: sess.id,
  files: [1, 2, 3].map((n) => ({ role: 'page', page_no: n, path: `${A}/st/p${n}.jpg`, mime: 'image/jpeg' })),
  pages: [1, 2, 3].map((n) => ({ page_no: n, text: `صفحة ${n}` })),
})
const sp = await call('kh_doc_split', { id: stack.id, segments: [{ first_page: 1, last_page: 2, title_ar: 'رسالة من الإدارة' }, { first_page: 3, last_page: 3, title_ar: 'وصل' }] })
ok('split: two documents', sp.ids.length === 2)
const part1 = await call('kh_doc_get', { id: sp.ids[0] })
const part2 = await call('kh_doc_get', { id: sp.ids[1] })
ok('split: pages and files moved and renumbered', part1.pages.length === 2 && part2.pages.length === 1 && part2.pages[0].page_no === 1 && part2.files.some((f) => f.role === 'page' && f.page_no === 1 && f.path.endsWith('p3.jpg')))
ok('split: thumbnail = first page, source scan, box kept', part2.files.some((f) => f.role === 'thumb') && part1.source === 'scan' && part1.original_location_id === box.id)
ok('split: the empty stack is gone', (await call('kh_doc_get', { id: stack.id })) === null)
await call('kh_doc_purge', { ids: sp.ids })

// ------------------------------------------------------------ deadlines, overview, usage
await call('kh_doc_update', { id: pass1.id, fields: { expiry_date: new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10) } })
const ov = await call('kh_overview')
ok('overview: expiring passport on the radar', ov.deadlines.some((x) => x.document_id === pass1.id))
ok('overview: counts', ov.documents >= 10 && ov.people >= 1)
// usage rows are written by the device itself (database owner) or by the AI function, never by a signed-in user
await fails('a signed-in user cannot write usage rows', () => call('kh_usage_add', { op: 'x', model: 'm', cost_usd: -100 }), /permission denied/)
await db.query('select public.kh_usage_add($1::jsonb)', [JSON.stringify({ op: 'understand', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cost_usd: 0.014 })])
await fails('usage cannot be negative', () => db.query('select public.kh_usage_add($1::jsonb)', [JSON.stringify({ op: 'x', model: 'm', cost_usd: -5 })]), /check constraint/)
const us = await call('kh_usage_summary')
ok('usage summary', Math.abs(Number(us.month_cost) - 0.014) < 1e-9 && us.by_op.understand > 0)
ok('locations list counts docs', (await call('kh_locations_list'))[0].doc_count >= 1)

// ------------------------------------------------------------ delete / restore / purge
await call('kh_doc_delete', { id: d10.id })
ok('deleted doc leaves the search', (await call('kh_search', { filters: { ids: [d10.id] } })).total === 0)
ok('… and is in the trash', (await call('kh_search', { filters: { deleted: true } })).total === 1)
await call('kh_doc_restore', { id: d10.id })
ok('restore', (await call('kh_search', { filters: { ids: [d10.id] } })).total === 1)
const pg = await call('kh_doc_purge', { id: exact.id })
ok('purge returns file paths', pg.paths.length === 1)

// ------------------------------------------------------------ category merge / delete
const extra = await call('kh_category_save', { name_ar: 'مراجع', parent_id: studies.id })
await call('kh_move_docs', { ids: [d6.id], category_id: extra.id })
await call('kh_category_merge', { from_id: extra.id, into_id: adminCat })
ok('merge moves the documents', (await call('kh_doc_get', { id: d6.id })).category_id === adminCat)
await fails('a category cannot move inside itself', () => call('kh_category_save', { id: studies.id, name_ar: studies.name_ar, parent_id: adminCat }))

// ------------------------------------------------------------ security
current = B
ok('other account sees nothing', (await call('kh_search', {})).total === 0)
ok('other account cannot read a document', (await call('kh_doc_get', { id: d1.id })) === null)
await call('kh_bootstrap')
ok('other account has its own categories', (await call('kh_categories_list')).every((c) => !cats.some((x) => x.id === c.id)))
current = A
await call('kh_doc_update', { id: pass1.id, fields: { sensitivity: 'vault' } })
claims = '{"aal":"aal1"}'
ok('vault hidden without the second factor', (await call('kh_doc_get', { id: pass1.id })) === null)
ok('… but counted', (await call('kh_vault_count')).count === 1)
claims = '{"aal":"aal2"}'
ok('vault visible with the second factor', (await call('kh_doc_get', { id: pass1.id }))?.id === pass1.id)
claims = ''
await db.exec(`select set_config('request.jwt.claim.sub', '', false); set role anon;`)
await fails('visitors cannot call the API', () => db.query(`select public.kh_search('{}'::jsonb)`), /permission denied/)
await db.exec('reset role')

// ------------------------------------------------------------ the review's attack paths, closed
current = A
claims = '{"aal":"aal1"}'
const vaultPage = `${A}/vaultdoc/p1.jpg`
await db.query(`insert into public.kh_files (owner_id, document_id, role, page_no, path) values ($1, $2, 'page', 1, $3)`, [A, pass1.id, vaultPage]) // the vault document's page (written as owner)
await db.query(`insert into storage.objects (bucket_id, name, owner) values ('kh-files', $1, $2), ('kh-files', $3, $2)`, [vaultPage, A, `${A}/x/orig.pdf`])
async function asUser(sql, params) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`, [current, claims])
  await db.exec('set role authenticated')
  try {
    return (await db.query(sql, params)).rows
  } finally {
    await db.exec('reset role')
  }
}
await fails('a forged file row cannot borrow a vault file', () =>
  asUser(`insert into public.kh_files (document_id, role, path) values ($1, 'page', $2)`, [d1.id, vaultPage]), /another document/)
await fails('a file row cannot point outside its owner folder', () =>
  asUser(`insert into public.kh_files (document_id, role, path) values ($1, 'page', $2)`, [d1.id, `${B}/x/p.jpg`]), /owner folder/)
await fails('a stored file path cannot change', () => asUser(`update public.kh_files set path = path || '.x' where document_id = $1`, [d1.id]), /cannot change/)
ok('storage: a vault file is out of reach without the second factor', (await asUser(`select name from storage.objects where name = $1`, [vaultPage])).length === 0)
ok('storage: an ordinary file is readable', (await asUser(`select name from storage.objects where name = $1`, [`${A}/x/orig.pdf`])).length === 1)
ok('storage: a vault file cannot be deleted without the second factor', (await asUser(`delete from storage.objects where name = $1 returning name`, [vaultPage])).length === 0)
ok('vault metadata hidden: deadlines', !(await call('kh_overview')).deadlines.some((x) => x.document_id === pass1.id))
// the deadline radar and the phone reminders
ok('radar list: a closed vault hides its deadlines', !(await call('kh_deadlines_list')).some((x) => x.document_id === pass1.id))
{
  const src = (await call('kh_reminders_source')).find((x) => x.document_id === pass1.id)
  ok('reminders: the vault deadlines stay (a closed vault must not delete their reminders), without any title', !!src && src.vault === true && src.title === null && src.doc_title === null)
}
{
  const due = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)
  const r1 = await call('kh_deadline_add', { title: 'تجديد بطاقة الإقامة (TIE)', due_date: due })
  const r2 = await call('kh_deadline_add', { title: 'تجديد بطاقة الإقامة (TIE)', due_date: due })
  const mine = (await call('kh_deadlines_list')).filter((x) => x.id === r1.id)
  ok('radar: a deadline added by the owner (no document) shows once, even added twice', r1.id === r2.id && mine.length === 1 && mine[0].document_id === null && mine[0].kind === 'reminder')
  ok('reminders: it is in the reminders too, with its title', (await call('kh_reminders_source')).some((x) => x.id === r1.id && x.title === 'تجديد بطاقة الإقامة (TIE)'))
  await call('kh_deadline_done', { id: r1.id })
  ok('radar: done → out of the list and of the reminders (in the list with with_done)', !(await call('kh_deadlines_list')).some((x) => x.id === r1.id) && !(await call('kh_reminders_source')).some((x) => x.id === r1.id) && (await call('kh_deadlines_list', { with_done: true })).some((x) => x.id === r1.id && x.done))
  await call('kh_deadline_delete', { id: r1.id })
  ok('radar: deleted', !(await call('kh_deadlines_list', { with_done: true })).some((x) => x.id === r1.id))
  await fails('radar: a deadline needs a title and a date', () => call('kh_deadline_add', { title: ' ', due_date: due }), /title and a date/)
}
// ready dossiers («الملفات الجاهزة») and their links
{
  claims = '{"aal":"aal2"}'
  const dz = await call('kh_dossier_save', { name: 'تجديد بطاقة الإقامة' })
  ok('dossier: created', !!dz.id && (await call('kh_dossiers_list')).some((x) => x.id === dz.id && x.documents === 0))
  await fails('dossier: needs a name', () => call('kh_dossier_save', { name: '  ' }), /needs a name/)
  const set = await call('kh_dossier_set_items', {
    id: dz.id,
    items: [{ document_id: pass1.id, requirement: 'جواز السفر' }, { document_id: d1.id, requirement: 'شهادة' }, { document_id: '00000000-0000-4000-8000-00000000dead' }],
  })
  ok('dossier: documents in order, unknown ones skipped', set.items === 2)
  const g = await call('kh_dossier_get', { id: dz.id })
  ok('dossier: read back in order with their requirements', g.items.length === 2 && g.items[0].document_id === pass1.id && g.items[0].requirement === 'جواز السفر' && g.items[1].document_id === d1.id && g.hidden === 0)
  await call('kh_dossier_save', {
    id: dz.id,
    plan: { procedure: 'تجديد بطاقة الإقامة', requirements: [{ label: 'جواز السفر', status: 'found', document_id: pass1.id, note: 'صالح حتى 2030' }, { label: 'شهادة السكنى', status: 'missing', document_id: null, note: 'empadronamiento' }] },
  })
  const g2 = await call('kh_dossier_get', { id: dz.id })
  ok('dossier: the checklist is kept, with the title of each found paper', g2.plan.procedure === 'تجديد بطاقة الإقامة' && g2.plan.requirements.length === 2 && !!g2.plan.requirements[0].title && g2.plan.requirements[1].status === 'missing')
  ok('dossier list: counts its papers and what is missing', (await call('kh_dossiers_list')).find((x) => x.id === dz.id)?.missing === 1)
  await call('kh_dossier_add', { id: dz.id, document_id: d3.id, requirement: 'إضافة' })
  ok('dossier: one more document goes at the end', (await call('kh_dossier_get', { id: dz.id })).items.at(-1)?.document_id === d3.id)
  await call('kh_dossier_add', { id: dz.id, document_id: d3.id, remove: true })
  ok('dossier: … and out again', !(await call('kh_dossier_get', { id: dz.id })).items.some((x) => x.document_id === d3.id))
  // the vault closes
  claims = '{"aal":"aal1"}'
  const g3 = await call('kh_dossier_get', { id: dz.id })
  ok('dossier: a closed vault hides its document but counts it', g3.items.length === 1 && g3.items[0].document_id === d1.id && g3.hidden === 1)
  const r0 = g3.plan.requirements[0]
  ok('dossier: … and its line of the checklist shows only the label', r0.hidden === true && r0.label === 'جواز السفر' && !r0.note && !r0.title && !r0.document_id)
  ok('dossier list: the vault document is still counted', (await call('kh_dossiers_list')).find((x) => x.id === dz.id)?.documents === 2)
  await call('kh_dossier_set_items', { id: dz.id, items: [{ document_id: d1.id, requirement: 'شهادة' }] })
  await fails('dossier: the checklist cannot be replaced while the vault hides part of it', () => call('kh_dossier_save', { id: dz.id, plan: { requirements: [] } }), /vault is closed/)
  claims = '{"aal":"aal2"}'
  ok('dossier: reordering with the vault closed kept the vault document', (await call('kh_dossier_get', { id: dz.id })).items.some((x) => x.document_id === pass1.id))
  ok('dossier: membership shown for a document', (await call('kh_dossiers_list', { document_id: d1.id })).find((x) => x.id === dz.id)?.has === true)
  // links
  const week = new Date(Date.now() + 7 * 864e5).toISOString()
  const sh = await call('kh_share_add', { collection_id: dz.id, drive_file: 'f1', permission_id: 'p1', url: 'https://drive.google.com/file/d/f1/view', label: 'للمحامي', expires_at: week })
  ok('share: recorded with its link', (await call('kh_shares_list', { open: true })).some((x) => x.id === sh.id && x.url.includes('f1') && x.name === 'تجديد بطاقة الإقامة' && !x.expired))
  const far = await call('kh_share_add', { collection_id: dz.id, drive_file: 'f2', url: 'u2', expires_at: '2099-01-01T00:00:00Z' })
  ok('share: never longer than a year', new Date(far.expires_at).getTime() < Date.now() + 367 * 864e5)
  await fails('share: needs the Drive file and the link', () => call('kh_share_add', { collection_id: dz.id, drive_file: '', url: '' }), /file and its link/)
  await fails('dossier: not deleted while a link is live', () => call('kh_dossier_delete', { id: dz.id }), /live link/)
  await call('kh_share_revoke', { id: sh.id })
  await call('kh_share_revoke', { id: far.id })
  ok('share: taken back', !(await call('kh_shares_list', { open: true })).some((x) => x.id === sh.id) && (await call('kh_dossier_get', { id: dz.id })).shares.find((x) => x.id === sh.id)?.revoked === true)
  const one = await call('kh_share_add', { document_id: d1.id, drive_file: 'f3', url: 'u3' })
  ok('share: one document alone too (30 days by default)', (await call('kh_shares_list', { document_id: d1.id })).some((x) => x.id === one.id && Math.abs(new Date(x.expires_at) - Date.now() - 30 * 864e5) < 864e5))
  ok('share: written in the activity log', (await asUser(`select count(*)::int as n from public.kh_audit where action in ('share', 'unshare')`))[0].n >= 4)
  current = B
  ok('other account sees no dossier nor link', (await call('kh_dossiers_list')).length === 0 && (await call('kh_shares_list')).length === 0 && (await call('kh_dossier_get', { id: dz.id })) === null)
  await fails('other account cannot fill a dossier of another', () => call('kh_dossier_set_items', { id: dz.id, items: [] }), /not found/)
  await fails('other account cannot share a dossier of another', () => call('kh_share_add', { collection_id: dz.id, drive_file: 'x', url: 'y' }), /not found/)
  current = A
  await call('kh_share_revoke', { id: one.id })
  await call('kh_dossier_delete', { id: dz.id })
  ok('dossier: deleted, with its links', !(await call('kh_dossiers_list')).some((x) => x.id === dz.id) && !(await call('kh_shares_list')).some((x) => x.collection_id === dz.id))
  claims = '{"aal":"aal1"}'
}
// the independent review's findings: links to vault pages, order with the vault closed, the trash
{
  claims = '{"aal":"aal2"}'
  const vdoc = await call('kh_doc_create', { file_name: 'tie.jpg', page_count: 1, pages: [{ page_no: 1, text: 'tarjeta de identidad de extranjero' }] })
  await call('kh_doc_update', { id: vdoc.id, fields: { sensitivity: 'vault' } })
  const dv = await call('kh_dossier_save', { name: 'ملف ببطاقة الإقامة' })
  await call('kh_dossier_set_items', { id: dv.id, items: [{ document_id: vdoc.id, requirement: 'بطاقة الإقامة' }, { document_id: d1.id }, { document_id: d2.id }] })
  const link = await call('kh_share_add', { collection_id: dv.id, documents: [vdoc.id, d1.id, d2.id], drive_file: 'fv', url: 'uv' })
  ok('vault link: with the vault open the link shows, marked as holding vault pages', (await call('kh_dossier_get', { id: dv.id })).shares.some((x) => x.id === link.id && x.vault === true))
  await call('kh_dossier_save', { id: dv.id, plan: { procedure: 'TIE', requirements: [{ label: 'بطاقة الإقامة', status: 'found', document_id: vdoc.id, note: 'رقم Y1234567 صالحة حتى 2030' }] } })
  claims = '{"aal":"aal1"}'
  const closed = await call('kh_dossier_get', { id: dv.id })
  ok('vault link: closed vault → a link whose PDF holds vault pages is hidden everywhere', !closed.shares.length && !(await call('kh_shares_list')).some((x) => x.id === link.id))
  ok('vault link: … the tidying still knows it', (await call('kh_shares_state', { ids: [link.id] }))[link.id] === 'live')
  await fails('vault link: the dossier is not deleted under a link the closed vault hides', () => call('kh_dossier_delete', { id: dv.id }), /open the vault first/)
  await call('kh_dossier_set_items', { id: dv.id, items: [{ document_id: d2.id }, { document_id: d1.id }] })
  claims = '{"aal":"aal2"}'
  ok('order: reordering with the vault closed keeps the vault paper in its place', (await call('kh_dossier_get', { id: dv.id })).items.map((x) => x.document_id).join() === [vdoc.id, d2.id, d1.id].join())
  await call('kh_dossier_add', { id: dv.id, document_id: d3.id })
  ok('order: a paper added goes after all, the vault ones included', (await call('kh_dossier_get', { id: dv.id })).items.at(-1)?.document_id === d3.id)
  const trashed = await call('kh_doc_delete', { ids: [vdoc.id], revoke_links: true })
  ok('trash: a paper thrown away takes back the links whose PDF holds it', trashed.links === 1 && (await call('kh_shares_state', { ids: [link.id] }))[link.id] === 'revoked')
  claims = '{"aal":"aal1"}'
  const r0 = (await call('kh_dossier_get', { id: dv.id })).plan.requirements[0]
  ok('trash: its checklist line stays hidden while the vault is closed (no note, no id)', r0.hidden === true && !r0.note && !r0.document_id && r0.label === 'بطاقة الإقامة')
  await fails('trash: … and the checklist still cannot be replaced with the vault closed', () => call('kh_dossier_save', { id: dv.id, plan: { requirements: [] } }), /vault is closed/)
  ok('links: a link this database does not have was deleted (one database for every device in the cloud)', (await call('kh_shares_state', { ids: ['00000000-0000-4000-8000-00000000beef'] }))['00000000-0000-4000-8000-00000000beef'] === 'deleted')
  claims = '{"aal":"aal2"}'
  await call('kh_doc_restore', { id: vdoc.id })
  await call('kh_dossier_delete', { id: dv.id, force: true })
  claims = '{"aal":"aal1"}'
}
// the second review pass: a paper sealed after its link, links noted before their documents, the trash
{
  claims = '{"aal":"aal2"}'
  const late = await call('kh_doc_create', { file_name: 'passport-late.jpg', page_count: 1, pages: [{ page_no: 1, text: 'pasaporte' }] })
  const dl = await call('kh_dossier_save', { name: 'ملف ختم لاحقاً' })
  await call('kh_dossier_set_items', { id: dl.id, items: [{ document_id: d1.id }, { document_id: late.id }] })
  const l1 = await call('kh_share_add', { collection_id: dl.id, documents: [d1.id, late.id], drive_file: 'fl', url: 'ul' })
  const legacy = await call('kh_share_add', { collection_id: dl.id, drive_file: 'fo', url: 'uo' }) // as noted before the documents were
  await asUser(`update public.kh_share_links set documents = null where id = $1`, [legacy.id])
  claims = '{"aal":"aal1"}'
  ok('vault link: a link of ordinary papers shows with the vault closed', (await call('kh_shares_list')).some((x) => x.id === l1.id))
  await call('kh_doc_update', { id: late.id, fields: { sensitivity: 'vault' } }) // sealed after the link was made
  const seen = await call('kh_shares_list')
  ok('vault link: a paper sealed after the link was made hides the link while the vault is closed', !seen.some((x) => x.id === l1.id))
  ok('vault link: … a link noted before its documents too (judged by its dossier)', !seen.some((x) => x.id === legacy.id))
  claims = '{"aal":"aal2"}'
  ok('vault link: with the vault open both show, marked as holding vault papers', (await call('kh_shares_list')).filter((x) => [l1.id, legacy.id].includes(x.id) && x.vault).length === 2)
  // the trash asks: nothing is taken back unless the owner says so
  ok('trash: the app can ask how many open links hold a paper', (await call('kh_doc_links', { ids: [d1.id] })).count >= 2)
  const keep = await call('kh_doc_delete', { ids: [d1.id] })
  ok('trash: without the owner saying so, the links stay open', keep.links === 0 && (await call('kh_shares_state', { ids: [l1.id] }))[l1.id] === 'live')
  await call('kh_doc_restore', { id: d1.id })
  claims = '{"aal":"aal1"}'
  const gone = await call('kh_doc_delete', { ids: [d1.id], revoke_links: true })
  const st = await call('kh_shares_state', { ids: [l1.id, legacy.id] })
  ok('trash: taken back when the owner says so — the closed vault’s links too', gone.links === 2 && st[l1.id] === 'revoked' && st[legacy.id] === 'revoked', JSON.stringify({ links: gone.links, st }))
  claims = '{"aal":"aal2"}'
  await call('kh_doc_restore', { id: d1.id })
  await call('kh_dossier_delete', { id: dl.id, force: true })
  claims = '{"aal":"aal1"}'
}
// «مراجعي»: the bibliographic record of a research document
{
  const lec = await call('kh_doc_create', { file_name: 'droit-admin.pdf', page_count: 1, pages: [{ page_no: 1, text: 'القانون الإداري المغربي' }] })
  await call('kh_doc_update', { id: lec.id, fields: { doc_type: 'book', title_ar: 'القانون الإداري المغربي' } })
  ok('references: a book is listed even before its record is made', (await call('kh_references')).some((x) => x.id === lec.id && x.bib === null && x.doc_type === 'book'))
  const bib = { kind: 'book', lang: 'ar', authors: [{ last: 'بلعيدي', first: 'محمد' }], title: 'القانون الإداري المغربي', year: '2020', source: 'owner', checked: true }
  await call('kh_doc_update', { id: lec.id, fields: { bib }, by_owner: false })
  const got = (await call('kh_references')).find((x) => x.id === lec.id)
  ok('references: the record is kept as given', got?.bib?.authors?.[0]?.last === 'بلعيدي' && got.bib.checked === true && (await call('kh_doc_get', { id: lec.id })).bib.title === 'القانون الإداري المغربي')
  await call('kh_doc_update', { id: lec.id, fields: { bib: 'not an object' }, by_owner: false })
  ok('references: a record that is not an object is not stored', (await call('kh_doc_get', { id: lec.id })).bib === null)
  await call('kh_doc_update', { id: lec.id, fields: { bib }, by_owner: false })
  await call('kh_doc_update', { id: lec.id, fields: { title_ar: 'عنوان آخر' } })
  ok('references: other changes leave the record alone', (await call('kh_doc_get', { id: lec.id })).bib?.authors?.[0]?.first === 'محمد')
  await call('kh_doc_update', { id: d3.id, fields: { bib: { kind: 'other', lang: 'ar', authors: [], title: 'ملخص' } }, by_owner: false })
  ok('references: any document given a record is listed (notes, lectures…)', (await call('kh_references')).some((x) => x.id === d3.id))
  await call('kh_doc_delete', { id: lec.id })
  ok('references: a document in the trash is not', !(await call('kh_references')).some((x) => x.id === lec.id))
  current = B
  ok('references: another account sees none of them', (await call('kh_references')).length === 0)
  current = A
}
// the map of relations (people, bodies, places)
{
  const g = await call('kh_entity_graph')
  const prof = g.nodes.find((n) => n.name === 'محمد بنعلي')
  const fac = g.nodes.find((n) => n.kind === 'org' && n.name.includes('كلية العلوم القانونية'))
  const city = g.nodes.find((n) => n.kind === 'place' && n.name === 'تطوان')
  ok('graph: people, bodies and places are points, sized by their documents', !!prof && !!fac && !!city && prof.count >= 2)
  const line = g.edges.find((e) => [e.s, e.t].includes(prof.id) && [e.s, e.t].includes(fac.id))
  ok('graph: a line between two that share documents, weighted by how many', !!line && line.w >= 2 && g.edges.every((e) => e.s < e.t))
  const shared = await call('kh_entity_pair', { a: prof.id, b: fac.id })
  ok('graph: the documents a line stands for', shared.length === line.w && shared.some((d) => d.id === d1.id))
  const people = await call('kh_entity_graph', { kinds: 'person' })
  ok('graph: only the kinds asked for', people.nodes.length > 0 && people.nodes.every((n) => n.kind === 'person'))
  const around = await call('kh_entity_graph', { center: city.id })
  ok('graph: around one of them (it and those it shares documents with)', around.nodes.some((n) => n.id === city.id) && around.nodes.some((n) => n.id === prof.id) && around.nodes.every((n) => n.id === city.id || around.edges.some((e) => [e.s, e.t].includes(n.id))))
  ok('graph: the lightest lines can be left out', (await call('kh_entity_graph', { min: 99 })).edges.length === 0)
  // the closed vault: its documents link nobody
  const sec = await call('kh_doc_create', { file_name: 'secret.pdf', page_count: 1, pages: [{ page_no: 1, text: 'سري' }] })
  await call('kh_doc_apply_ai', { id: sec.id, card: card({ people: [{ name_ar: 'شخص من الخزنة', name_latin: 'Vault Person', honorific: null, role: 'mentioned', as_written: 'شخص من الخزنة' }] }), mode: 'claude' })
  await call('kh_doc_update', { id: sec.id, fields: { sensitivity: 'vault' } })
  claims = '{"aal":"aal1"}'
  ok('graph: a closed vault hides who appears only in its documents', !(await call('kh_entity_graph')).nodes.some((n) => n.name === 'شخص من الخزنة'))
  claims = '{"aal":"aal2"}'
  ok('graph: … shown again once it is open', (await call('kh_entity_graph')).nodes.some((n) => n.name === 'شخص من الخزنة'))
  claims = '{"aal":"aal1"}'
  current = B
  ok('graph: another account sees an empty map', (await call('kh_entity_graph')).nodes.length === 0 && (await call('kh_entity_pair', { a: prof.id, b: fac.id })).length === 0)
  current = A
}
ok('vault metadata hidden: corrections / links', (await asUser(`select 1 from public.kh_corrections where document_id = $1 union all select 1 from public.kh_links where from_id = $1 or to_id = $1`, [pass1.id])).length === 0)
ok('vault metadata hidden: its pages and fingerprints', (await asUser(`select 1 from public.kh_pages where document_id = $1 union all select 1 from public.kh_lsh where document_id = $1`, [pass1.id])).length === 0)

// the AI marks a document 'vault' in a session without the second factor: no error, sealed at the end
const idCard = await call('kh_doc_create', { file_name: 'cin.jpg', page_count: 1, pages: [{ page_no: 1, text: 'بطاقة التعريف الوطنية' }] })
const sealedAi = await call('kh_doc_apply_ai', { id: idCard.id, card: card({ doc_type: 'id_document', sensitivity: 'vault', category: { existing_id: identity.id, proposal: null, confidence: 0.9 } }), mode: 'claude' })
ok('aal1: the AI card applies to an ID without error and asks to seal it', sealedAi.seal === true && (await call('kh_doc_get', { id: idCard.id }))?.sensitivity === 'private')
await call('kh_doc_state', { id: idCard.id, state: 'ready' })
await call('kh_vault_seal', idCard.id).catch(async () => asUser(`select public.kh_vault_seal($1)`, [idCard.id]))
ok('aal1: once sealed, it is hidden', (await call('kh_doc_get', { id: idCard.id })) === null)
const memo = await call('kh_doc_create', { file_name: 'medical.pdf', page_count: 1, pages: [{ page_no: 1, text: 'تقرير طبي' }] })
const upd = await call('kh_doc_update', { id: memo.id, fields: { sensitivity: 'vault' } })
ok('aal1: the owner can put a document in the vault', upd.sealed === true && (await call('kh_doc_get', { id: memo.id })) === null)
claims = '{"aal":"aal2"}'
ok('aal2: sealed documents visible again', (await call('kh_doc_get', { id: memo.id }))?.sensitivity === 'vault')
claims = ''

// an Arabic-only shelf must not swallow proposals whose French name is empty
await call('kh_category_save', { name_ar: 'أوراق خاصة' })
const sea = await call('kh_doc_create', { file_name: 'maritime.pdf', page_count: 1, pages: [{ page_no: 1, text: 'القانون البحري' }] })
const seaAi = await call('kh_doc_apply_ai', { id: sea.id, card: card({ category: { existing_id: studies.id, proposal: { parent_id: studies.id, name_ar: 'القانون البحري', name_fr: '', name_es: '', name_en: '', reason_ar: '' }, confidence: 0.8 } }), mode: 'claude' })
ok('empty French name matches no shelf (a proposal is made)', !!seaAi.proposal_id, JSON.stringify(seaAi))

// two look-alikes asking about each other = one question; nothing is thrown away twice
const twinA = await call('kh_doc_create', { file_name: 'twinA.pdf', page_count: 1, pages: [{ page_no: 1, text: 'x' }] })
const twinB = await call('kh_doc_create', { file_name: 'twinB.pdf', page_count: 1, pages: [{ page_no: 1, text: 'x' }] })
const q1 = await call('kh_review_add', { kind: 'duplicate', document_id: twinA.id, payload: { other_id: twinB.id, other_title: 'B' } })
const q2 = await call('kh_review_add', { kind: 'duplicate', document_id: twinB.id, payload: { other_id: twinA.id, other_title: 'A' } })
ok('one question per pair of look-alikes', q1.id === q2.id)
await call('kh_doc_delete', { id: twinB.id })
await fails('the kept copy is gone → refuse to discard the other', () => call('kh_review_resolve', { id: q1.id, decision: { relation: 'same', discard: 'new' } }), /لم تعد موجودة/)

// claims: one worker at a time on a document
const job = await call('kh_doc_create', { file_name: 'job.pdf', page_count: 1, pages: [{ page_no: 1, text: 'x' }] })
ok('claim: first worker gets it', (await call('kh_claim', { id: job.id, worker: 'tab-1' })).ok === true)
ok('claim: a second worker does not', (await call('kh_claim', { id: job.id, worker: 'tab-2' })).ok === false)
ok('claim: a claimed document leaves the waiting list', !(await call('kh_pending')).some((x) => x.id === job.id))
await call('kh_doc_state', { id: job.id, state: 'new' })
ok('claim: released by a state change', (await call('kh_claim', { id: job.id, worker: 'tab-2' })).ok === true)

// ------------------------------------------------------------ backup → restore in an empty database
const exp = await call('kh_export')
ok('export has documents', exp.tables.kh_documents.length >= 10)
const db2 = await fresh()
await db2.query(`select set_config('request.jwt.claim.sub', $1, false)`, [A])
const imp = (await db2.query(`select public.kh_import($1::jsonb) as r`, [JSON.stringify(exp)])).rows[0].r
ok('import restores rows', imp.rows > 50, String(imp.rows))
const s2 = (await db2.query(`select public.kh_search('{"q":"بنعلي"}'::jsonb) as r`)).rows[0].r
ok('restored archive is searchable', s2.total >= 1, String(s2.total))
const imp2 = (await db2.query(`select public.kh_import($1::jsonb) as r`, [JSON.stringify(exp)])).rows[0].r
ok('import twice adds nothing', imp2.rows === 0, String(imp2.rows))

// a restore made WITHOUT the second factor (signed-in user, aal1): the vault comes back and stays searchable,
// and editing works afterwards (identity sequence intact)
claims = '{"aal":"aal2"}'
const full = await call('kh_export')
claims = ''
const db3 = await fresh()
await db3.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', '{"aal":"aal1"}', false)`, [A])
await db3.exec('set role authenticated')
const imp3 = (await db3.query(`select public.kh_import($1::jsonb) as r`, [JSON.stringify(full)])).rows[0].r
const vaultBack = (await db3.query(`select public.kh_vault_count('{}'::jsonb) as r`)).rows[0].r
ok('aal1 restore brings back the vault documents', imp3.ok && vaultBack.count >= 2, JSON.stringify(vaultBack))
const edit = (await db3.query(`select public.kh_doc_update($1::jsonb) as r`, [JSON.stringify({ id: d1.id, fields: { title_ar: 'بعد الاسترجاع' } })])).rows[0].r
ok('editing after a restore works (no duplicate correction ids)', edit.ok === true)
await db3.query(`select set_config('request.jwt.claims', '{"aal":"aal2"}', false)`)
const found = (await db3.query(`select public.kh_search('{"q":"passport"}'::jsonb) as r`)).rows[0].r
ok('restored vault document is searchable with the second factor', found.items.some((x) => x.id === pass1.id), String(found.total))
await db3.exec('reset role')
const orphan = { format: 'khizana-backup', tables: { kh_corrections: [{ id: 999, document_id: '00000000-0000-4000-8000-00000000dead', field: 'title', created_at: new Date().toISOString() }], kh_lsh: [{ document_id: '00000000-0000-4000-8000-00000000dead', band: 0, hash: '1' }] } }
await db3.query(`select set_config('request.jwt.claim.sub', $1, false)`, [A])
const impOrphan = (await db3.query(`select public.kh_import($1::jsonb) as r`, [JSON.stringify(orphan)])).rows[0].r
ok('rows of an unknown document are skipped, not fatal', impOrphan.ok && impOrphan.rows === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
