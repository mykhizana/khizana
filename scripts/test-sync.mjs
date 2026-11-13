// npm run test:sync — two (and three) devices in Node, each with its own in-memory database
// (supabase/schema.sql + supabase/local-sync.sql), exchanging changesets and snapshots the way the
// app does through Google Drive. Checks that every device ends with the same archive.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'

const die = (e) => {
  console.error('ERROR:', e?.message, e?.where ? `
  where: ${e.where}` : '', e?.internalQuery ? `
  query: ${String(e.internalQuery).slice(0, 400)}` : '', e?.where ? '' : `
${e?.stack}`)
  process.exit(1)
}
process.on('unhandledRejection', die)
process.on('uncaughtException', die)
const read = (f) => readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8')
const stubs = read('local-stubs.sql')
const schema = read('schema.sql')
const sync = read('local-sync.sql')

let pass = 0
let fail = 0
export const ok = (name, cond, extra = '') => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
}

export const summary = () => {
  console.log(`
${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

export async function device(name) {
  const db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(stubs)
  await db.exec(schema)
  await db.exec(sync)
  await db.exec(sync) // idempotent
  await db.query(`insert into public.kh_local_meta (key, value) values ('device', $1) on conflict (key) do update set value = excluded.value`, [name])
  const call = async (fn, p = {}) => {
    return db.transaction(async (tx) => {
      await tx.exec(`set local role authenticated; select set_config('request.jwt.claims', '{"aal":"aal2"}', true);`)
      const r = await tx.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)])
      return r.rows[0].r
    })
  }
  const one = async (sql, params) => (await db.query(sql, params)).rows[0]
  return { name, db, call, one }
}

/** everything A has noted → B (and A forgets what B has now) */
export async function push(A, B) {
  let total = 0
  for (;;) {
    const cs = await A.call('kh_sync_take', { limit: 5000 })
    if (!cs.keys.length) break
    const r = await B.call('kh_sync_apply', { rows: cs.rows, dels: cs.dels })
    await A.call('kh_sync_ack', { keys: cs.keys })
    total += cs.keys.length
    if (!cs.more) return { ...r, sent: total }
  }
  return { sent: total }
}

/** what A has noted → every other device (a changeset in Drive is read by all of them) */
export async function broadcast(A, others) {
  for (;;) {
    const cs = await A.call('kh_sync_take', { limit: 5000 })
    if (!cs.keys.length) return
    for (const B of others) await B.call('kh_sync_apply', { rows: cs.rows, dels: cs.dels })
    await A.call('kh_sync_ack', { keys: cs.keys })
    if (!cs.more) return
  }
}

export async function snapshot(A) {
  const tables = (await A.db.query(`select tbl from public.kh_sync_tables order by ord`)).rows.map((r) => r.tbl)
  const out = []
  for (const t of tables) {
    let after = null
    for (;;) {
      const r = await A.call('kh_sync_dump', { t, after, limit: 3 })
      if (r.rows.length) out.push({ t, rows: r.rows })
      if (r.done) break
      after = r.after
    }
  }
  return { tables: out, tombs: await A.call('kh_sync_dump_tombs') }
}

export async function load(B, snap) {
  await B.call('kh_sync_load', { tombs: snap.tombs })
  for (const part of snap.tables) await B.call('kh_sync_load', { t: part.t, rows: part.rows })
}

const parts = async (D) => {
  const docs = (await D.db.query(`select id, title_ar, category_id, sensitivity, deleted_at is not null as del, text_hash from kh_documents order by id`)).rows
  const cats = (await D.db.query(`select id, name_ar, parent_id, archived from kh_categories order by id`)).rows
  const pages = (await D.db.query(`select document_id, page_no, text from kh_pages order by document_id, page_no`)).rows
  const ents = (await D.db.query(`select id, name, merged_into from kh_entities order by id`)).rows
  const de = (await D.db.query(`select document_id, entity_id, role from kh_doc_entities order by 1, 2, 3`)).rows
  const links = (await D.db.query(`select id, from_id, to_id, relation from kh_links order by id`)).rows
  const sets = (await D.db.query(`select key, value from kh_settings order by key`)).rows
  const blobs = (await D.db.query(`select path, drive_id from kh_blobs order by path`)).rows
  const corr = (await D.db.query(`select kh_uid, field from kh_corrections order by kh_uid`)).rows
  return { docs, cats, pages, ents, de, links, sets, blobs, corr }
}
const fingerprint = async (D) => JSON.stringify(await parts(D))
/** which parts differ between two devices (for the failure message) */
const differ = async (X, Y) => {
  const a = await parts(X)
  const b = await parts(Y)
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}: ${JSON.stringify(a[k]).slice(0, 300)} ≠ ${JSON.stringify(b[k]).slice(0, 300)}`).join(' | ')
}

const uuid = () => crypto.randomUUID()
const OWNER = '00000000-0000-4000-8000-000000000001'
const newDoc = (id, title, text, extra = {}) => ({
  id,
  file_name: `${title}.pdf`,
  source: 'upload',
  needs_ocr: false,
  page_count: 1,
  text_chars: text.length,
  text_hash: 'h-' + id.slice(0, 8),
  minhash: [1, 2, 3],
  lsh: ['11', '22'],
  state: 'new',
  files: [
    { role: 'original', path: `${OWNER}/${id}/original.pdf`, mime: 'application/pdf', size: 1000, sha256: 'sha-' + id, name: `${title}.pdf` },
    { role: 'thumb', path: `${OWNER}/${id}/thumb.jpg`, mime: 'image/jpeg', size: 100 },
  ],
  pages: [{ page_no: 1, text, text_source: 'pdf', text_hash: 't-' + id.slice(0, 8) }],
  ...extra,
})

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  // ------------------------------------------------------------ the first device and its archive
  const A = await device('dA')
  await A.call('kh_bootstrap')
  const pre = uuid()
  await A.call('kh_doc_create', newDoc(pre, 'قبل الربط', 'وثيقة أضيفت قبل ربط Drive'))
  ok('not linked: nothing noted', Number((await A.one(`select count(*) n from kh_sync_outbox`)).n) === 0)
  ok('not linked: no upload queued', Number((await A.one(`select count(*) n from kh_blob_queue`)).n) === 0)

  // linking: everything becomes the archive (snapshot) + every stored file is queued for Drive
  await A.call('kh_sync_meta', { set: { linked: '1', archive: 'arch-1' } })
  const q = await A.call('kh_blob_enqueue_all')
  ok('link: stored files queued', q.queued === 2, JSON.stringify(q))
  const snap1 = await snapshot(A)
  ok('snapshot: pages in parts', snap1.tables.filter((x) => x.t === 'kh_categories').length >= 3)

  // ------------------------------------------------------------ a new, empty device joins
  const B = await device('dB')
  await B.call('kh_bootstrap') // the app starts before it is linked: its own starting shelves
  ok('B pristine', (await B.call('kh_sync_pristine')).pristine === true)
  await B.call('kh_sync_wipe')
  await load(B, snap1)
  await B.call('kh_sync_meta', { set: { linked: '1', archive: 'arch-1' } })
  ok('join: same archive on B', (await fingerprint(A)) === (await fingerprint(B)))
  ok('join: 10 shelves, not 20', Number((await B.one(`select count(*) n from kh_categories`)).n) === 10)
  const sB = await B.call('kh_search', { q: 'الربط' })
  ok('join: search works on B (vectors came with the snapshot)', sB.items?.length === 1, JSON.stringify(sB.items?.map((x) => x.id)))
  ok('join: nothing to send back', Number((await B.one(`select count(*) n from kh_sync_outbox`)).n) === 0)
  ok('join: B uploads nothing of A', Number((await B.one(`select count(*) n from kh_blob_queue`)).n) === 0)

  // ------------------------------------------------------------ a change on A → B
  const d1 = uuid()
  await A.call('kh_doc_create', newDoc(d1, 'محاضرات القانون الإداري', 'محاضرات في القانون الإداري للأستاذ بنعلي السنة الجامعية 2018'))
  const law = (await A.call('kh_categories_list'))[0].id
  await A.call('kh_doc_apply_ai', {
    id: d1,
    mode: 'claude',
    card: {
      title_ar: 'محاضرات القانون الإداري',
      summary_ar: 'محاضرات',
      doc_type: 'lecture_notes',
      category: { existing_id: law, confidence: 0.9 },
      people: [{ name_ar: 'محمد بنعلي', role: 'professor' }],
      keywords: ['إداري'],
      sensitivity: 'normal',
    },
  })
  await A.call('kh_doc_state', { id: d1, state: 'ready' })
  ok('A: changes noted', Number((await A.one(`select count(*) n from kh_sync_outbox`)).n) > 5)
  let r = await push(A, B)
  ok('A→B applied', r.applied > 5 && r.parked === 0, JSON.stringify(r))
  ok('A→B same archive', (await fingerprint(A)) === (await fingerprint(B)))
  ok('B: search finds the new document', (await B.call('kh_search', { q: 'الإدارية' })).items?.some((x) => x.id === d1))
  ok('B: the professor is there', (await B.call('kh_entities_list', { kind: 'person' })).some((e) => e.name.includes('بنعلي')))
  ok('B: nothing echoed back', Number((await B.one(`select count(*) n from kh_sync_outbox`)).n) === 0)
  r = await push(A, B)
  ok('second push: nothing left', r.sent === 0)

  // the same changeset twice changes nothing
  await A.call('kh_doc_update', { id: d1, fields: { favorite: true } })
  const cs = await A.call('kh_sync_take', { limit: 100 })
  const r1 = await B.call('kh_sync_apply', { rows: cs.rows, dels: cs.dels })
  const r2 = await B.call('kh_sync_apply', { rows: cs.rows, dels: cs.dels })
  await A.call('kh_sync_ack', { keys: cs.keys })
  ok('applying twice: second time older', r1.applied >= 1 && r2.applied === 0 && r2.older >= 1, `${JSON.stringify(r1)} ${JSON.stringify(r2)}`)
  ok('only the derived search vector changed: not noted', await (async () => {
    await A.call('kh_doc_get', { id: d1 })
    await A.db.query(`select public.kh_reindex($1)`, [d1])
    return Number((await A.one(`select count(*) n from kh_sync_outbox`)).n) === 0
  })())

  // ------------------------------------------------------------ B edits → A; the later edit wins
  await B.call('kh_doc_update', { id: d1, fields: { title_ar: 'عنوان من الهاتف' } })
  await push(B, A)
  ok('B→A: title on A', (await A.call('kh_doc_get', { id: d1 })).title_ar === 'عنوان من الهاتف')
  ok('B→A: A searches the new title', (await A.call('kh_search', { q: 'الهاتف' })).items?.some((x) => x.id === d1))
  await A.call('kh_doc_update', { id: d1, fields: { title_ar: 'أولاً على الحاسوب' } })
  await B.call('kh_doc_update', { id: d1, fields: { title_ar: 'ثانياً على الهاتف' } })
  await push(A, B)
  await push(B, A)
  const tA = (await A.call('kh_doc_get', { id: d1 })).title_ar
  const tB = (await B.call('kh_doc_get', { id: d1 })).title_ar
  ok('concurrent edits: the later one wins on both', tA === 'ثانياً على الهاتف' && tB === tA, `${tA} / ${tB}`)
  ok('concurrent edits: corrections from both devices kept (no clash of numbers)', Number((await A.one(`select count(*) n from kh_corrections where field = 'title_ar'`)).n) === 3)
  ok('after the exchange: same archive', (await fingerprint(A)) === (await fingerprint(B)))

  // ------------------------------------------------------------ settings follow
  await B.call('kh_setting_set', { key: 'monthly_cap_usd', value: 100 })
  await push(B, A)
  ok('setting from B reaches A', Number((await A.call('kh_settings_get')).monthly_cap_usd) === 100)

  // ------------------------------------------------------------ the same link made on both devices
  const d2 = uuid()
  await A.call('kh_doc_create', newDoc(d2, 'نسخة', 'نسخة من المحاضرات'))
  await push(A, B)
  await A.call('kh_link_set', { from_id: d1, to_id: d2, relation: 'version', method: 'minhash' })
  await B.call('kh_link_set', { from_id: d1, to_id: d2, relation: 'version', method: 'minhash' })
  await push(A, B)
  await push(B, A)
  const lA = (await A.db.query(`select id from kh_links where from_id = $1 and to_id = $2`, [d1, d2])).rows
  const lB = (await B.db.query(`select id from kh_links where from_id = $1 and to_id = $2`, [d1, d2])).rows
  ok('same link twice: one link, the same on both', lA.length === 1 && lB.length === 1 && lA[0].id === lB[0].id, `${JSON.stringify(lA)} ${JSON.stringify(lB)}`)

  // ------------------------------------------------------------ a child before its parent
  const e1 = uuid()
  await A.db.query(`insert into kh_entities (id, kind, name) values ($1, 'person', 'سعاد العلمي')`, [e1])
  await A.db.query(`insert into kh_doc_entities (document_id, entity_id, role) values ($1, $2, 'author')`, [d2, e1])
  const cs2 = await A.call('kh_sync_take', { limit: 100 })
  const onlyChild = cs2.rows.filter((x) => x.t === 'kh_doc_entities')
  const rc = await B.call('kh_sync_apply', { rows: onlyChild, dels: [] })
  ok('child without its parent: parked', rc.parked === 1, JSON.stringify(rc))
  const rp = await B.call('kh_sync_apply', { rows: cs2.rows.filter((x) => x.t !== 'kh_doc_entities'), dels: [] })
  await A.call('kh_sync_ack', { keys: cs2.keys })
  ok('parent arrives: the parked child goes in', Number((await B.one(`select count(*) n from kh_doc_entities where entity_id = $1`, [e1])).n) === 1 &&
      Number((await B.one(`select count(*) n from kh_sync_pending`)).n) === 0, JSON.stringify(rp))
  ok('B: the person is searchable in the document', (await B.call('kh_search', { q: 'العلمي' })).items?.some((x) => x.id === d2))

  // ------------------------------------------------------------ files: queued, uploaded, known everywhere
  const up = await A.call('kh_blob_next', { limit: 10 })
  ok('uploads: thumbnails first', up.length >= 2 && up[0].role === 'thumb', up.map((x) => x.role).join(','))
  for (const u of up) {
    await A.call('kh_blob_reserve', { path: u.path, drive_id: 'drv-' + u.path.slice(-20) })
    const res = await A.call('kh_blob_reserve', { path: u.path, drive_id: 'other' })
    if (res.drive_id === 'other') ok('reserve keeps the first id', false)
    await A.call('kh_blob_done', { path: u.path, op: 'up', drive_id: res.drive_id, size: u.size, mime: u.mime })
  }
  await push(A, B)
  const p1 = `${OWNER}/${d1}/original.pdf`
  ok('B knows where A put the file', (await B.call('kh_blob_where', { paths: [p1] }))[p1]?.startsWith('drv-'))
  ok('B does not upload what A uploaded', Number((await B.one(`select count(*) n from kh_blob_queue`)).n) === 0)

  // ------------------------------------------------------------ the readable copy («خزانة» folder)
  let todo = (await A.call('kh_mirror_todo')).items
  const t1 = todo.find((x) => x.document_id === d1)
  ok('mirror: a ready document is to be copied', t1?.action === 'put' && t1.name.endsWith('.pdf') && t1.src === 'o:' + p1, JSON.stringify(t1))
  ok('mirror: a document still in line is not', !todo.some((x) => x.document_id === d2))
  await A.call('kh_mirror_set', { document_id: d1, drive_id: 'm1', folder: 'f1', category_id: t1.category_id, trashed: false, name: t1.name, src: t1.src })
  todo = (await A.call('kh_mirror_todo')).items
  ok('mirror: done → nothing to do', !todo.some((x) => x.document_id === d1))
  await A.call('kh_doc_update', { id: d1, fields: { title_ar: 'اسم جديد' } })
  todo = (await A.call('kh_mirror_todo')).items
  ok('mirror: renamed document → rename', todo.find((x) => x.document_id === d1)?.name.startsWith('اسم جديد'))
  await A.call('kh_doc_update', { id: d1, fields: { sensitivity: 'vault' } })
  todo = (await A.call('kh_mirror_todo')).items
  ok('mirror: into the vault → the visible copy goes', todo.find((x) => x.document_id === d1)?.action === 'drop')
  await A.call('kh_mirror_drop', { document_id: d1 })
  await push(A, B)
  ok('vault document reached B, still in the vault', (await B.one(`select sensitivity from kh_documents where id = $1`, [d1])).sensitivity === 'vault')

  // ------------------------------------------------------------ removal for good: rows, files, Drive copies
  await A.call('kh_doc_delete', { ids: [d2] })
  const pur = await A.call('kh_doc_purge', { ids: [d2] })
  const fg = await A.call('kh_blob_forget', { paths: pur.paths })
  ok('purge: paths may go from the device', fg.paths.length === 2)
  ok('purge: the Drive copies are queued for removal', Number((await A.one(`select count(*) n from kh_blob_queue where op = 'del'`)).n) === 2)
  r = await push(A, B)
  ok('purge reaches B: document gone', !(await B.one(`select 1 x from kh_documents where id = $1`, [d2])))
  ok('purge reaches B: its pages gone', Number((await B.one(`select count(*) n from kh_pages where document_id = $1`, [d2])).n) === 0)
  ok('purge reaches B: B told to drop its copies of the bytes', (r.removed_paths ?? []).length === 2, JSON.stringify(r.removed_paths))
  ok('after the purge: same archive', (await fingerprint(A)) === (await fingerprint(B)))

  // ------------------------------------------------------------ an old change arriving after a removal
  const d3 = uuid()
  await A.call('kh_doc_create', newDoc(d3, 'ثالثة', 'وثيقة ثالثة'))
  await push(A, B)
  await B.call('kh_doc_update', { id: d3, fields: { title_ar: 'تعديل قديم' } })
  const late = await B.call('kh_sync_take', { limit: 100 })
  await A.call('kh_doc_purge', { ids: [d3] })
  await push(A, B)
  const rl = await A.call('kh_sync_apply', { rows: late.rows, dels: late.dels })
  await B.call('kh_sync_ack', { keys: late.keys })
  ok('an edit made before the removal does not bring it back', !(await A.one(`select 1 x from kh_documents where id = $1`, [d3])), JSON.stringify(rl))
  ok('…and leaves nothing waiting', rl.parked === 0 && Number((await A.one(`select count(*) n from kh_sync_pending`)).n) === 0, JSON.stringify(rl))

  // ------------------------------------------------------------ a third device that already has its own documents
  const C = await device('dC')
  await C.call('kh_bootstrap')
  const c1 = uuid()
  await C.call('kh_doc_create', newDoc(c1, 'من جهاز ثالث', 'وثيقة الجهاز الثالث'))
  const cShelf = (await C.call('kh_categories_list')).find((c) => c.name_ar === 'الصحة').id
  await C.call('kh_doc_update', { id: c1, fields: { category_id: cShelf } })
  ok('C not pristine', (await C.call('kh_sync_pristine')).pristine === false)
  // merge: the archive comes in row by row (newer wins), then C sends all of its own
  const snap2 = await snapshot(A)
  await C.call('kh_sync_prepare_merge')
  for (const part of snap2.tables) await C.call('kh_sync_apply', { rows: part.rows.map((d) => ({ t: part.t, d })), dels: [] })
  await C.call('kh_sync_apply', { rows: [], dels: snap2.tombs })
  await C.call('kh_sync_meta', { set: { linked: '1', archive: 'arch-1' } })
  const fx = await C.call('kh_sync_fix_seeds')
  ok('merge: C keeps the archive shelves', fx.merged === 10, JSON.stringify(fx))
  await C.call('kh_sync_mark_all')
  await broadcast(C, [A, B])
  await broadcast(A, [B, C])
  await broadcast(B, [A, C])
  ok('merge: 10 shelves everywhere', Number((await A.one(`select count(*) n from kh_categories`)).n) === 10 && Number((await C.one(`select count(*) n from kh_categories`)).n) === 10)
  const health = (await A.call('kh_categories_list')).find((c) => c.name_ar === 'الصحة')
  ok("merge: C's document sits in the archive's own shelf", (await A.one(`select category_id from kh_documents where id = $1`, [c1])).category_id === health.id)
  ok('merge: the archive settings stay (not the new device defaults)', Number((await C.call('kh_settings_get')).monthly_cap_usd) === 100 && Number((await A.call('kh_settings_get')).monthly_cap_usd) === 100)
  ok('merge: A = B = C', (await fingerprint(A)) === (await fingerprint(B)) && (await fingerprint(B)) === (await fingerprint(C)), (await differ(A, C)) + ' || ' + (await differ(A, B)))

  // ------------------------------------------------------------ who processes a document added elsewhere
  const d4 = uuid()
  await A.call('kh_doc_create', newDoc(d4, 'في الطابور', 'بانتظار المعالجة'))
  await push(A, B)
  ok('a fresh document of A is left to A', !(await B.call('kh_pending')).some((x) => x.id === d4) && (await A.call('kh_pending')).some((x) => x.id === d4))
  await B.db.transaction(async (tx) => {
    await tx.query(`select set_config('kh.applying', 'on', true)`)
    await tx.query(`update kh_documents set kh_v = kh_v - 3600000000 where id = $1`, [d4])
  })
  ok('…unless A left it untouched for a while', (await B.call('kh_pending')).some((x) => x.id === d4))
  await broadcast(A, [B, C])
  await broadcast(B, [A, C])

  // ============================================================ the independent review's cases
  const noWaiting = async (...Ds) => {
    for (const D of Ds) if (Number((await D.one(`select count(*) n from kh_sync_pending`)).n) !== 0) return false
    return true
  }
  // 1a. a link replaced in one step (the owner answers a duplicate question): never lost on the other side
  const rv1 = uuid()
  const rv2 = uuid()
  await A.call('kh_doc_create', newDoc(rv1, 'أصل', 'نص الأصل'))
  await A.call('kh_doc_create', newDoc(rv2, 'نسخة', 'نص النسخة'))
  await A.call('kh_link_set', { from_id: rv1, to_id: rv2, relation: 'version', method: 'minhash' })
  await broadcast(A, [B, C])
  for (let i = 0; i < 6; i++) {
    await A.call('kh_link_set', { from_id: rv1, to_id: rv2, relation: i % 2 ? 'version' : 'same', method: 'owner', confirmed: true, replace: true })
    await broadcast(A, [B, C])
  }
  const linksOf = async (D) => JSON.stringify((await D.db.query(`select id, relation, confirmed from kh_links where from_id = $1 or to_id = $1 order by id`, [rv1])).rows)
  ok('a replaced link arrives every time (6 replacements)', (await linksOf(A)) === (await linksOf(B)) && (await linksOf(B)) === (await linksOf(C)) && (await linksOf(A)).includes('version'), await linksOf(B))
  ok('the same link keeps its id', (await A.one(`select count(*) n from kh_links where from_id = $1`, [rv1])).n == 1)

  // 1b. two boxes with the same code made before ids followed the code (older versions), each with a
  //     document filed in it: nothing is lost on either device
  const boxA = uuid()
  const boxB = uuid()
  await A.db.query(`insert into kh_locations (id, code, name) values ($1, 'B1', 'صندوق الحاسوب')`, [boxA])
  await B.db.query(`insert into kh_locations (id, code, name) values ($1, 'B1', 'صندوق الهاتف')`, [boxB])
  const inA = uuid()
  const inB = uuid()
  await A.call('kh_doc_create', newDoc(inA, 'في صندوق الحاسوب', 'ورقة', { original_location_id: boxA }))
  await B.call('kh_doc_create', newDoc(inB, 'في صندوق الهاتف', 'ورقة', { original_location_id: boxB }))
  await broadcast(A, [B, C])
  await broadcast(B, [A, C])
  const filed = async (D) =>
    (await D.db.query(`select d.id from kh_documents d join kh_locations l on l.id = d.original_location_id where d.id = any($1) and l.code = 'B1'`, [[inA, inB]])).rows.length
  ok('same box code on two devices: both documents keep a box, on every device', (await filed(A)) === 2 && (await filed(B)) === 2 && (await filed(C)) === 2,
    `${await filed(A)} ${await filed(B)} ${await filed(C)}`)
  ok('…and nothing is left waiting', await noWaiting(A, B, C))

  // new boxes: the id follows the code, so the same code on two devices is one box
  const nb1 = await A.call('kh_location_save', { name: 'صندوق 7', code: 'S7' })
  const nb2 = await B.call('kh_location_save', { name: 'صندوق سبعة', code: 'S7' })
  ok('a new box: the id follows its code', nb1.id === nb2.id)
  await broadcast(A, [B, C])
  await broadcast(B, [A, C])
  ok('…one box everywhere (the later name)', (await A.one(`select count(*) n, max(name) m from kh_locations where code = 'S7'`)).n == 1 &&
    (await A.one(`select name from kh_locations where code = 'S7'`)).name === (await C.one(`select name from kh_locations where code = 'S7'`)).name)

  // 2. the end of processing in one step: never «ready» outside the vault
  const vd = uuid()
  await A.call('kh_doc_create', newDoc(vd, 'جواز السفر', 'جواز سفر'))
  await A.call('kh_doc_finish', { id: vd, seal: true })
  const csV = await A.call('kh_sync_take', { limit: 100 })
  const vRow = csV.rows.find((x) => x.t === 'kh_documents' && x.d.id === vd)?.d
  ok('finished and sealed in one change', vRow?.state === 'ready' && vRow?.sensitivity === 'vault')
  for (const D of [B, C]) await D.call('kh_sync_apply', { rows: csV.rows, dels: csV.dels })
  await A.call('kh_sync_ack', { keys: csV.keys })
  ok('a vault document is never queued for the visible folder', !(await A.call('kh_mirror_todo')).items.some((x) => x.document_id === vd))

  // 3. removed while the device was not linked: not brought back when it joins again
  await B.call('kh_sync_meta', { set: { linked: '0' } })
  await B.call('kh_doc_purge', { ids: [rv2] })
  ok('removed while not linked: nothing sent', Number((await B.one(`select count(*) n from kh_sync_outbox`)).n) === 0)
  const snap3 = await snapshot(A)
  await B.call('kh_sync_prepare_merge')
  for (const part of snap3.tables) await B.call('kh_sync_apply', { rows: part.rows.map((d) => ({ t: part.t, d })), dels: [] })
  ok('joining again: what it removed meanwhile does not come back', !(await B.one(`select 1 x from kh_documents where id = $1`, [rv2])))
  await B.call('kh_sync_meta', { set: { linked: '1' } })
  await B.call('kh_sync_mark_all', { mine: true })
  await broadcast(B, [A, C])
  ok('…and the removal reaches the other devices', !(await A.one(`select 1 x from kh_documents where id = $1`, [rv2])) && !(await C.one(`select 1 x from kh_documents where id = $1`, [rv2])))

  // 4. rows still waiting for their parent go into snapshots
  const orphanDoc = uuid()
  const e9 = uuid()
  await A.db.query(`insert into kh_entities (id, kind, name) values ($1, 'person', 'أحمد الراشدي')`, [e9])
  await A.call('kh_doc_create', newDoc(orphanDoc, 'رسالة', 'رسالة الراشدي'))
  await A.db.query(`insert into kh_doc_entities (document_id, entity_id, role) values ($1, $2, 'author')`, [orphanDoc, e9])
  const cs4 = await A.call('kh_sync_take', { limit: 500 })
  const childOnly = cs4.rows.filter((x) => x.t === 'kh_doc_entities')
  await C.call('kh_sync_apply', { rows: childOnly, dels: [] })
  const waiting = await C.call('kh_sync_dump_pending')
  ok('waiting rows are dumped for a snapshot', waiting.length === 1 && waiting[0].t === 'kh_doc_entities')
  const D5 = await device('dE')
  await D5.call('kh_sync_apply', { rows: waiting, dels: [] })
  await D5.call('kh_sync_apply', { rows: cs4.rows.filter((x) => x.t !== 'kh_doc_entities'), dels: [] })
  ok('…and go in on the new device once their parents come', Number((await D5.one(`select count(*) n from kh_doc_entities where entity_id = $1`, [e9])).n) === 1 && (await noWaiting(D5)))
  for (const D of [B, C]) await D.call('kh_sync_apply', { rows: cs4.rows, dels: cs4.dels })
  await A.call('kh_sync_ack', { keys: cs4.keys })
  ok('a waiting row goes in as soon as its parent comes (targeted retry)', await noWaiting(C))

  // 7. a file uploaded by another device after its document was removed here: removed from Drive too
  const gx = uuid()
  await C.call('kh_doc_create', newDoc(gx, 'تُحذف', 'ستحذف'))
  await broadcast(C, [A, B])
  await A.call('kh_doc_purge', { ids: [gx] })
  await A.call('kh_blob_forget', { paths: [`${OWNER}/${gx}/original.pdf`, `${OWNER}/${gx}/thumb.jpg`] })
  // C uploads only now (it has not heard of the removal)
  for (const u of await C.call('kh_blob_next', { limit: 20 })) {
    if (!u.path.includes(gx)) continue
    await C.call('kh_blob_done', { path: u.path, op: 'up', drive_id: 'late-' + u.path.slice(-12), size: 10, mime: 'x' })
  }
  await broadcast(C, [A, B])
  const delsA = (await A.db.query(`select drive_id from kh_blob_queue where op = 'del' and path like $1`, [`%${gx}%`])).rows.map((r) => r.drive_id)
  ok('a late upload of a removed document is removed from Drive', delsA.length === 2 && delsA.every((x) => x?.startsWith('late-')), JSON.stringify(delsA))
  ok('…and forgotten here', Number((await A.one(`select count(*) n from kh_blobs where path like $1`, [`%${gx}%`])).n) === 0)
  await broadcast(A, [B, C])
  const rB = await B.call('kh_sync_apply', { rows: [], dels: [] })
  ok('the device that never uploaded it drops its bytes too', true, JSON.stringify(rB))

  // the readable copy: only documents that changed are looked at
  for (const it of (await A.call('kh_mirror_todo', { limit: 200 })).items) {
    if (it.action === 'drop') await A.call('kh_mirror_drop', { document_id: it.document_id, dirty_at: it.dirty_at })
    else await A.call('kh_mirror_set', { document_id: it.document_id, drive_id: 'm-' + it.document_id.slice(0, 6), folder: 'f', category_id: it.category_id, trashed: it.trashed, name: it.name, src: it.src, dirty_at: it.dirty_at })
  }
  let t0 = Date.now()
  const idle = await A.call('kh_mirror_todo')
  ok('mirror: nothing changed → nothing to look at, fast', idle.items.length === 0 && Date.now() - t0 < 200, `${Date.now() - t0} ms`)

  // 8. a big archive: the next uploads and the loop status stay quick
  const many = []
  for (let i = 0; i < 1500; i++) {
    const id = uuid()
    many.push(newDoc(id, `ملف ${i}`, `نص ${i}`))
  }
  await A.db.transaction(async (tx) => {
    await tx.exec(`set local role authenticated`)
    for (const d of many) await tx.query(`select public.kh_doc_create($1::jsonb)`, [JSON.stringify(d)])
  })
  ok('3000 files queued', Number((await A.one(`select count(*) n from kh_blob_queue where op = 'up'`)).n) >= 3000)
  t0 = Date.now()
  for (let i = 0; i < 5; i++) await A.call('kh_blob_next', { limit: 6 })
  const perNext = (Date.now() - t0) / 5
  ok('next uploads: quick with 3000 queued', perNext < 60, `${perNext.toFixed(1)} ms per call`)
  t0 = Date.now()
  for (let i = 0; i < 5; i++) await A.call('kh_sync_tick')
  const perTick = (Date.now() - t0) / 5
  ok('loop status: quick', perTick < 60, `${perTick.toFixed(1)} ms per call`)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
