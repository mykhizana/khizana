// npm run test:drive — the real sync engine (src/drive/engine.ts) and Drive client (src/drive/api.ts)
// against a stand-in for Google Drive (scripts/fake-drive.mjs), with two and three devices in Node.
import { registerHooks } from 'node:module'
import { device, ok, summary } from './test-sync.mjs'
import { startFakeDrive } from './fake-drive.mjs'

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
const die = (e) => {
  console.error('ERROR:', e?.message, e?.where ? `\n  where: ${e.where}` : '', e?.internalQuery ? `\n  query: ${String(e.internalQuery).slice(0, 400)}` : '', e?.where ? '' : `\n${e?.stack}`)
  process.exit(1)
}
process.on('unhandledRejection', die)
process.on('uncaughtException', die)

const { createEngine } = await import('../src/drive/engine.ts')
const { driveClient, DriveError } = await import('../src/drive/api.ts')
const { jpegPdf, jpegInfo } = await import('../src/drive/pdf.ts')

const { drive: fake, server, url } = await startFakeDrive(0)
let token = 'tok'
const client = driveClient(async () => token, url)

const OWNER = '00000000-0000-4000-8000-000000000001'
// a tiny real JPEG (1×1 grey) for page images
const JPEG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'))

async function phone(name) {
  const D = await device(name)
  const store = new Map()
  D.bytes = {
    get: async (p) => store.get(p) ?? null,
    put: async (p, b) => void store.set(p, b),
    del: async (p) => void store.delete(p),
  }
  D.store = store
  D.engine = createEngine({ db: { call: (...a) => D.call(...a) }, drive: client, bytes: D.bytes })
  return D
}

/** a document added on a device: bytes kept on the device, one database call (as the app does) */
async function addDoc(D, { title, text, scan = false }) {
  const id = crypto.randomUUID()
  const files = []
  if (scan) {
    for (const n of [1, 2]) {
      const path = `${OWNER}/${id}/p${n}.jpg`
      D.store.set(path, new Blob([JPEG], { type: 'image/jpeg' }))
      files.push({ role: 'page', page_no: n, path, mime: 'image/jpeg', size: JPEG.length, width: 1, height: 1 })
    }
  } else {
    const path = `${OWNER}/${id}/original.pdf`
    D.store.set(path, new Blob([`%PDF-1.4 ${title}`], { type: 'application/pdf' }))
    files.push({ role: 'original', path, mime: 'application/pdf', size: 20, sha256: 'sha-' + id, name: `${title}.pdf` })
  }
  const thumb = `${OWNER}/${id}/thumb.jpg`
  D.store.set(thumb, new Blob([JPEG], { type: 'image/jpeg' }))
  files.push({ role: 'thumb', path: thumb, mime: 'image/jpeg', size: JPEG.length })
  await D.call('kh_doc_create', {
    id,
    file_name: `${title}.pdf`,
    title,
    source: scan ? 'scan' : 'upload',
    needs_ocr: false,
    page_count: scan ? 2 : 1,
    text_chars: text.length,
    files,
    pages: scan ? [{ page_no: 1, text }, { page_no: 2, text: 'ص2' }] : [{ page_no: 1, text }],
  })
  await D.call('kh_doc_update', { id, fields: { title_ar: title, state: 'ready' }, by_owner: false })
  return id
}
const docsOf = async (D) => (await D.db.query(`select id, title_ar, category_id from kh_documents order by id`)).rows
const visible = () => [...fake.files.values()].filter((f) => !f.meta.parents.includes('appDataFolder'))
const hidden = () => [...fake.files.values()].filter((f) => f.meta.parents.includes('appDataFolder'))

// ------------------------------------------------------------ the Drive client itself
const ids = await client.generateIds(3, 'appDataFolder')
ok('client: ids reserved', ids.length === 3)
const small = await client.create({ id: ids[0], name: 'x.txt', parents: ['appDataFolder'], appProperties: { kh: 'test' } }, new Blob(['hello'], { type: 'text/plain' }))
ok('client: small upload (multipart)', small.id === ids[0] && (await (await client.download(small.id)).text()) === 'hello')
const bigBytes = new Uint8Array(12 * 1024 * 1024).map((_, i) => i % 251)
const big = await client.create({ name: 'big.bin', parents: ['appDataFolder'] }, new Blob([bigBytes]))
const back = new Uint8Array(await (await client.download(big.id)).arrayBuffer())
ok('client: large upload in parts (resumable)', back.length === bigBytes.length && back[9_999_999] === bigBytes[9_999_999])
await client.remove(big.id)
await client.remove(big.id) // already gone: fine
fake.failNext(2)
ok('client: retries a temporary error', (await client.list(`name = 'x.txt'`, { spaces: 'appDataFolder' })).length === 1)
token = 'expired'
let err = null
try {
  await client.list(`name = 'x.txt'`, { spaces: 'appDataFolder' })
} catch (e) {
  err = e
}
ok('client: an expired sign-in is reported as such', err instanceof DriveError && err.auth)
token = 'tok'
await client.remove(small.id)

// ------------------------------------------------------------ the PDF of a scanned document
const pdf = jpegPdf([JPEG, JPEG], 'وثيقة ممسوحة')
const pdfText = Buffer.from(await pdf.arrayBuffer()).toString('latin1')
ok('pdf: jpeg header read', JSON.stringify(jpegInfo(JPEG)) === JSON.stringify({ height: 1, width: 1, channels: 1 }))
ok('pdf: two pages, real structure', pdfText.startsWith('%PDF-1.4') && /\/Count 2/.test(pdfText) && /startxref\n\d+\n%%EOF/.test(pdfText))
{
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(await pdf.arrayBuffer()) })
  const doc = await task.promise
  ok('pdf: opens in pdf.js with 2 pages', doc.numPages === 2)
  await task.destroy()
}

// ------------------------------------------------------------ the first device makes the archive
const A = await phone('dA')
await A.call('kh_bootstrap')
const a1 = await addDoc(A, { title: 'محاضرات القانون الإداري', text: 'محاضرات في القانون الإداري' })
let insp = await A.engine.inspect()
ok('inspect: no archive yet', insp.archive === null && insp.pristine === false)
const info = await A.engine.create()
ok('create: archive in Drive', !!info.archive && hidden().some((f) => f.meta.name === 'khizana.json') && hidden().some((f) => f.meta.name.startsWith('snap-')))
let up = await A.engine.uploads()
ok('create: the stored files go to the hidden folder', up.done === 2 && hidden().filter((f) => f.meta.appProperties.kh === 'blob').length === 2, JSON.stringify(up))
ok('create: the device knows where they are', (await A.engine.status()).in_drive === 2)
await A.engine.push()

// ------------------------------------------------------------ a second, new device joins
const B = await phone('dB')
await B.call('kh_bootstrap')
insp = await B.engine.inspect()
ok('B: sees the archive, is empty', insp.archive?.archive === info.archive && insp.pristine === true)
await B.engine.join(insp.archive)
ok('B: has A\'s documents', JSON.stringify(await docsOf(B)) === JSON.stringify(await docsOf(A)))
ok('B: 10 shelves (not 20)', Number((await B.one(`select count(*) n from kh_categories`)).n) === 10)
const p1 = `${OWNER}/${a1}/original.pdf`
ok('B: the file is not on B yet', !B.store.has(p1))
const got = await B.engine.fetchBlob(p1)
ok('B: opens it from Drive (and keeps it)', (await got.text()) === '%PDF-1.4 محاضرات القانون الإداري' && B.store.has(p1))

// ------------------------------------------------------------ changes both ways
const a2 = await addDoc(A, { title: 'شهادة الإجازة', text: 'شهادة الإجازة في القانون العام' })
ok('A: sends', (await A.engine.push()) > 0)
ok('B: receives', (await B.engine.pull()) === 1)
ok('B: the new document is searchable', (await B.call('kh_search', { q: 'الإجازة' })).items?.some((x) => x.id === a2))
await B.call('kh_doc_update', { id: a2, fields: { title_ar: 'شهادة الإجازة 2009' } })
await B.engine.push()
await A.engine.pull()
ok('A: gets B\'s edit', (await A.call('kh_doc_get', { id: a2 })).title_ar === 'شهادة الإجازة 2009')
ok('nothing more to exchange', (await A.engine.push()) === 0 && (await B.engine.pull()) === 0)

// a changeset that got into Drive but whose answer was lost: kept, not doubled
const csCount = () => hidden().filter((f) => f.meta.name.startsWith('cs-dA-')).length
await A.call('kh_doc_update', { id: a2, fields: { favorite: true } })
const realCreate = client.create
let calls = 0
client.create = async (...args) => {
  const r = await realCreate(...args)
  if (++calls === 1) throw new Error('connection lost after the upload')
  return r
}
let c0 = csCount()
await A.engine.push()
client.create = realCreate
ok('an answer lost after the upload: the file in Drive is kept, not sent twice', csCount() === c0 + 1, `${c0} → ${csCount()}`)
// the tab closes between the upload and the outbox note: next time the same changeset, same id
await A.call('kh_doc_update', { id: a2, fields: { favorite: false } })
await A.call('kh_doc_update', { id: a2, fields: { favorite: true } })
const realCall = A.call
A.call = async (fn, p) => {
  if (fn === 'kh_sync_ack') {
    A.call = realCall
    throw new Error('tab closed')
  }
  return realCall(fn, p)
}
c0 = csCount()
let lost = null
try {
  await A.engine.push()
} catch (e) {
  lost = e
}
await A.engine.push()
ok('a crash after the upload: sent again with the same id, not doubled', !!lost && csCount() === c0 + 1, `${c0} → ${csCount()}`)
await B.engine.pull()
ok('…and still arrives', (await B.one(`select favorite from kh_documents where id = $1`, [a2])).favorite === true)

// ------------------------------------------------------------ files: uploaded once, removed with their document
const b1 = await addDoc(B, { title: 'وصفة طبية', text: 'وصفة الطبيب', scan: true })
up = await B.engine.uploads()
ok('B: uploads its own files only', up.done === 3, JSON.stringify(up))
await B.engine.push()
await A.engine.pull()
ok("A: never uploads B's files", !(await A.db.query(`select path from kh_blob_queue`)).rows.some((r) => r.path.includes(b1)))
await A.engine.uploads()
await A.engine.push()
const scanPage = `${OWNER}/${b1}/p1.jpg`
ok('A: fetches B\'s page from Drive', (await A.engine.fetchBlob(scanPage))?.size === JPEG.length)
await A.call('kh_doc_delete', { ids: [a1] })
const purged = await A.call('kh_doc_purge', { ids: [a1] })
const forgot = await A.call('kh_blob_forget', { paths: purged.paths })
for (const p of forgot.paths) A.store.delete(p)
await A.engine.uploads()
ok('purge: its files leave Drive', !hidden().some((f) => f.meta.appProperties.p === p1))
await A.engine.push()
await B.engine.pull()
ok('purge: B drops its own copy of the bytes', !B.store.has(p1))

// ------------------------------------------------------------ the visible folder «خزانة»
let mr = await A.engine.mirror()
ok('mirror: B\'s scan waits until its pages are in Drive… or copies it now', mr.done >= 2, JSON.stringify(mr))
const root = visible().find((f) => f.meta.appProperties.kh === 'root')
ok('mirror: a root folder «خزانة» in My Drive', root?.meta.name === 'خزانة' && root.meta.parents[0] === 'root')
const copies = visible().filter((f) => f.meta.appProperties.kh === 'doc')
ok('mirror: one readable copy per ready document', copies.length === 2, copies.map((c) => c.meta.name).join(' | '))
const scanCopy = copies.find((c) => c.meta.appProperties.doc === b1)
ok('mirror: the scan became one PDF', scanCopy?.meta.mimeType === 'application/pdf' && scanCopy.meta.name === 'وصفة طبية.pdf' && Buffer.from(scanCopy.bytes).toString('latin1').startsWith('%PDF'))
const none = visible().find((f) => f.meta.appProperties.key === 'none')
ok('mirror: unclassified ones sit in «غير مصنفة»', none?.meta.name === 'غير مصنفة' && scanCopy.meta.parents.includes(none.meta.id))
// classified → moved into its shelf folder; renamed → renamed
const health = (await A.call('kh_categories_list')).find((c) => c.name_ar === 'الصحة')
await A.call('kh_doc_update', { id: b1, fields: { category_id: health.id, title_ar: 'وصفة الدكتور' } })
await A.engine.mirror()
const moved = fake.files.get(scanCopy.meta.id)
const healthFolder = visible().find((f) => f.meta.appProperties.key === health.id)
ok('mirror: moved to its shelf and renamed', healthFolder?.meta.name === 'الصحة' && moved.meta.parents.includes(healthFolder.meta.id) && moved.meta.name === 'وصفة الدكتور.pdf')
ok('mirror: the shelf folder sits in «خزانة»', healthFolder.meta.parents.includes(root.meta.id))
// another device does not make copies a second time
await A.engine.push()
await B.engine.pull()
mr = await B.engine.mirror()
ok('mirror: B finds nothing left to do', mr.done === 0 && visible().filter((f) => f.meta.appProperties.kh === 'doc').length === 2)
// into the vault → the visible copy goes; to the trash → trash folder
await A.call('kh_doc_update', { id: b1, fields: { sensitivity: 'vault' } })
await A.engine.mirror()
ok('mirror: a vault document leaves the visible folder for good (not even in the Drive bin)', !fake.files.has(scanCopy.meta.id))
await A.call('kh_doc_delete', { ids: [a2] })
await A.engine.mirror()
const trash = visible().find((f) => f.meta.appProperties.key === 'trash')
const a2copy = visible().find((f) => f.meta.appProperties.doc === a2)
ok('mirror: a deleted document goes to «سلة المحذوفات»', trash?.meta.name === 'سلة المحذوفات' && a2copy.meta.parents.includes(trash.meta.id))
// the owner removed a copy in Drive by hand → made again
await A.call('kh_doc_restore', { id: a2 })
fake.files.delete(a2copy.meta.id)
await A.engine.mirror()
ok('mirror: a copy removed by hand in Drive comes back', visible().some((f) => f.meta.appProperties.doc === a2 && !f.meta.trashed))
// only one device at a time keeps the folder in order
await B.call('kh_doc_update', { id: a2, fields: { title_ar: 'من الهاتف' } })
mr = await B.engine.mirror()
ok('mirror: B waits while A holds the lease', mr.done === 0)

// ------------------------------------------------------------ a third device with its own documents
const C = await phone('dC')
await C.call('kh_bootstrap')
const c1 = await addDoc(C, { title: 'عقد الكراء', text: 'عقد كراء شقة' })
insp = await C.engine.inspect()
ok('C: not empty → merge', insp.pristine === false && insp.archive?.archive === info.archive)
await C.engine.join(insp.archive)
await A.engine.push()
await B.engine.push()
await C.engine.uploads()
await C.engine.push()
for (const D of [A, B, C]) await D.engine.pull()
const same = JSON.stringify(await docsOf(A))
ok('merge: A, B and C have the same documents', same === JSON.stringify(await docsOf(B)) && same === JSON.stringify(await docsOf(C)) && same.includes(c1))
ok('merge: 10 shelves on every device', Number((await A.one(`select count(*) n from kh_categories`)).n) === 10 && Number((await C.one(`select count(*) n from kh_categories`)).n) === 10)
ok('merge: A opens C\'s file', (await (await A.engine.fetchBlob(`${OWNER}/${c1}/original.pdf`))?.text()) === '%PDF-1.4 عقد الكراء')

// ------------------------------------------------------------ tidying: a new snapshot, then a fourth device starts from it
for (let i = 0; i < 4; i++) {
  await A.call('kh_doc_update', { id: c1, fields: { tags: [`t${i}`] } })
  await A.engine.push()
}
ok('compact: forced snapshot', await A.engine.compact(true))
const D4 = await phone('dD')
await D4.call('kh_bootstrap')
await D4.engine.join((await D4.engine.inspect()).archive)
ok('D: up to date from the newest snapshot + changesets', JSON.stringify(await docsOf(D4)) === same && JSON.stringify((await D4.call('kh_doc_get', { id: c1 })).tags) === '["t3"]')

// ------------------------------------------------------------ a changeset not sent before the device unlinks
await D4.call('kh_doc_update', { id: c1, fields: { tags: ['from-D'] } })
const createOnline = client.create
client.create = async () => {
  throw new Error('offline')
}
try {
  await D4.engine.push()
} catch {
  /* offline */
}
client.create = createOnline
ok('offline: the changeset waits on the device', !!(await D4.engine.meta()).pending_cs)
await D4.engine.unlink()
ok('unlinking keeps it', !!(await D4.engine.meta()).pending_cs)
await D4.engine.join((await D4.engine.inspect()).archive)
await A.engine.pull()
ok('joining again sends it first: the others get it, and nothing waits', JSON.stringify((await A.call('kh_doc_get', { id: c1 })).tags) === '["from-D"]' && !(await A.engine.meta()).held)

// ------------------------------------------------------------ a device away while old changesets are tidied away
const E = await phone('dF')
await E.call('kh_bootstrap')
await E.engine.join((await E.engine.inspect()).archive)
for (let i = 0; i < 3; i++) {
  await A.call('kh_doc_update', { id: c1, fields: { tags: [`away${i}`] } })
  await A.engine.push()
}
for (const f of fake.files.values()) if (f.meta.appProperties?.kh === 'cs') f.meta.createdTime = '2020-01-01T00:00:00.000Z'
ok('compact: the old changesets go', (await A.engine.compact(true)) && ![...fake.files.values()].some((f) => f.meta.appProperties?.kh === 'cs' && f.meta.appProperties.dev === 'dA'))
await E.engine.pull()
ok('the device that was away catches up from the snapshot', JSON.stringify((await E.call('kh_doc_get', { id: c1 })).tags) === '["away2"]', JSON.stringify((await E.call('kh_doc_get', { id: c1 })).tags))
await A.call('kh_doc_update', { id: c1, fields: { tags: ['after'] } })
await A.engine.push()
await E.engine.pull()
ok('…and carries on with the next changesets', JSON.stringify((await E.call('kh_doc_get', { id: c1 })).tags) === '["after"]' && !(await E.engine.meta()).held)
// a gap no snapshot covers (a lost changeset) is stepped over after a while, never waited on for ever
const lostSeq = Number((await B.engine.meta()).seq || 0) + 1
await B.engine.setMeta({ seq: String(lostSeq) }) // as if changeset n was lost
await B.call('kh_doc_update', { id: c1, fields: { favorite: true, tags: ['after-gap'] } })
await B.engine.push()
await A.engine.pull()
ok('a changeset after a lost one waits', !!(await A.engine.meta()).held)
await A.engine.setMeta({ held_since: String(Date.now() - 11 * 60_000) })
await A.engine.pull()
ok('…then the gap is stepped over and it goes in', !(await A.engine.meta()).held && (await A.one(`select favorite from kh_documents where id = $1`, [c1])).favorite === true)

// ------------------------------------------------------------ ready dossiers: one PDF, a share link, taken back, tidied
{
  const { publishShare, revokeShare, sweepShares, SHARE_FOLDER } = await import('../src/drive/share.ts')
  const S = await phone('dS')
  await S.call('kh_bootstrap')
  const docId = await addDoc(S, { title: 'جواز السفر', text: 'passport' })
  const dz = await S.call('kh_dossier_save', { name: 'ملف التجديد' })
  await S.call('kh_dossier_set_items', { id: dz.id, items: [{ document_id: docId, requirement: 'جواز السفر' }] })
  const db = { call: S.call }
  const pdfA4 = jpegPdf([JPEG, JPEG], 'ملف التجديد', { a4: true, numbers: true })
  {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: new Uint8Array(await pdfA4.arrayBuffer()) })
    const doc = await task.promise
    const page = await doc.getPage(2)
    const [, , w, h] = page.view
    const text = (await page.getTextContent()).items.map((x) => x.str).join('')
    ok('dossier pdf: A4 pages, numbered «2 / 2», opens in pdf.js', doc.numPages === 2 && Math.round(w) === 595 && Math.round(h) === 842 && text.includes('2 / 2'), `${w}x${h} «${text}»`)
    await task.destroy()
  }

  const p1 = await publishShare(client, db, { pdf: pdfA4, name: 'ملف التجديد', days: 7, collection_id: dz.id, label: 'للقنصلية' })
  const copy = fake.files.get(p1.file)
  const folder = copy && fake.files.get(copy.meta.parents[0])
  ok('share: the PDF goes into the app folder of shared copies', folder?.meta.name === SHARE_FOLDER && copy.meta.name === 'ملف التجديد.pdf' && copy.meta.mimeType === 'application/pdf')
  ok('share: anyone with the link can read it, nobody can find it', copy.perms?.length === 1 && copy.perms[0].type === 'anyone' && copy.perms[0].role === 'reader' && copy.perms[0].allowFileDiscovery === false)
  ok('share: the copy carries its link and its end date', copy.meta.appProperties.kh === 'share' && copy.meta.appProperties.sid === p1.id && Math.abs(Date.parse(copy.meta.appProperties.exp) - Date.now() - 7 * 864e5) < 60_000)
  ok('share: the link is noted in the archive', (await S.call('kh_shares_list', { open: true })).some((x) => x.id === p1.id && x.url === p1.url && x.label === 'للقنصلية' && x.collection_id === dz.id))
  const p2 = await publishShare(client, db, { pdf: pdfA4, name: 'نسخة ثانية', days: 30, document_id: docId })
  ok('share: one folder for every shared copy', [...fake.files.values()].filter((f) => f.meta.appProperties?.kh === 'shares' && !f.meta.trashed).length === 1 && fake.files.get(p2.file).meta.parents[0] === copy.meta.parents[0])

  // the link could not be made: no stray shared copy is left behind
  const before = [...fake.files.values()].filter((f) => f.meta.appProperties?.kh === 'share').length
  const realShare = client.share
  client.share = async () => {
    throw new Error('permission refused')
  }
  let failed = null
  try {
    await publishShare(client, db, { pdf: pdfA4, name: 'x', days: 7, collection_id: dz.id })
  } catch (e) {
    failed = e
  }
  client.share = realShare
  ok('share: a link that could not be made leaves no copy in Drive', !!failed && [...fake.files.values()].filter((f) => f.meta.appProperties?.kh === 'share').length === before)

  // taken back from the app: the copy is deleted, the link no longer opens
  await revokeShare(client, db, { id: p1.id, drive_file: p1.file })
  ok('share: taken back → its copy is deleted from Drive and the link is marked', !fake.files.has(p1.file) && (await S.call('kh_shares_list', {})).find((x) => x.id === p1.id)?.revoked === true)

  // the tidying, on any device of the archive
  const here = { device: 'dS', archive: 'arc-1' }
  const at = (ms) => ({ ...here, now: Date.now() + ms })
  const p3 = await publishShare(client, db, { pdf: pdfA4, name: 'ثالث', days: 7, collection_id: dz.id, device: 'dS', archive: 'arc-1' })
  ok('share: the copy knows its device and its archive', fake.files.get(p3.file).meta.appProperties.dev === 'dS' && fake.files.get(p3.file).meta.appProperties.arc === 'arc-1')
  await S.call('kh_share_revoke', { id: p3.id }) // taken back on a device that could not reach Drive
  const sw1 = await sweepShares(client, db, here)
  ok('sweep: a link taken back elsewhere loses its copy', !fake.files.has(p3.file) && sw1.removed === 1 && fake.files.has(p2.file))
  const p4 = await publishShare(client, db, { pdf: pdfA4, name: 'رابع', days: 7, collection_id: dz.id })
  const sw2 = await sweepShares(client, db, at(8 * 864e5))
  ok('sweep: a link past its date loses its copy and is closed (the 30-day one stays)', !fake.files.has(p4.file) && fake.files.has(p2.file) && sw2.closed >= 1 && (await S.call('kh_shares_list', {})).find((x) => x.id === p4.id)?.revoked === true)
  const p5 = await publishShare(client, db, { pdf: pdfA4, name: 'خامس', days: 30, collection_id: dz.id })
  fake.files.delete(p5.file) // deleted by hand in Drive
  await sweepShares(client, db, at(2 * 3600_000))
  ok('sweep: a copy deleted by hand in Drive (Drive confirms it is gone) → its link is marked as taken back', (await S.call('kh_shares_list', {})).find((x) => x.id === p5.id)?.revoked === true)
  // the dossier is deleted: its link's tombstone says so, the copy goes at once
  const dz2 = await S.call('kh_dossier_save', { name: 'ملف سيُحذف' })
  const p6 = await publishShare(client, db, { pdf: pdfA4, name: 'سادس', days: 30, collection_id: dz2.id })
  await S.call('kh_dossier_delete', { id: dz2.id, force: true })
  await sweepShares(client, db, here)
  ok('sweep: a link whose dossier was deleted loses its copy', !fake.files.has(p6.file) && fake.files.has(p2.file))
  const st = await S.call('kh_shares_state', { ids: [p2.id, p1.id, p6.id, '00000000-0000-4000-8000-00000000f00d'] })
  ok('sweep: the state of links: live, revoked, deleted (tombstone), unknown (never seen here)', st[p2.id] === 'live' && st[p1.id] === 'revoked' && st[p6.id] === 'deleted' && st['00000000-0000-4000-8000-00000000f00d'] === 'unknown', JSON.stringify(st))
  // copies this device knows nothing about: another device's are kept until their end date
  const sharesFolder = (await client.list(`appProperties has { key='kh' and value='shares' } and trashed = false`))[0].id
  const stray = async (props) => (await client.create({ name: 'x.pdf', parents: [sharesFolder], mimeType: 'application/pdf', appProperties: { kh: 'share', sid: crypto.randomUUID(), exp: new Date(Date.now() + 30 * 864e5).toISOString(), ...props } }, pdfA4)).id
  const theirs = await stray({ dev: 'dPhone', arc: 'arc-1' })
  const mineLost = await stray({ dev: 'dS', arc: 'arc-1' })
  const otherArchive = await stray({ dev: 'dX', arc: 'arc-2', exp: new Date(Date.now() - 864e5).toISOString() })
  await sweepShares(client, db, at(2 * 864e5))
  ok('sweep: a link made on another device and not arrived yet is never cut', fake.files.has(theirs))
  ok('sweep: a copy this device made but never noted (a failed publish) goes after a day', !fake.files.has(mineLost))
  ok('sweep: the copies of another archive are not touched', fake.files.has(otherArchive))
  await sweepShares(client, db, at(31 * 864e5))
  ok('sweep: … the other device’s copy goes at its own end date', !fake.files.has(theirs))
}

// ------------------------------------------------------------ two devices creating an archive at the same moment
const fake2 = await startFakeDrive(0)
const client2 = driveClient(async () => 'tok', fake2.url)
const X = await device('dX')
const Y = await device('dY')
for (const D of [X, Y]) {
  await D.call('kh_bootstrap')
  D.engine = createEngine({ db: { call: D.call }, drive: client2, bytes: { get: async () => null, put: async () => {}, del: async () => {} } })
}
const [ix, iy] = await Promise.all([X.engine.create(), Y.engine.create()])
ok('race: both end in one archive', ix.archive === iy.archive, `${ix.archive} / ${iy.archive}`)
ok('race: one archive file left in Drive', [...fake2.drive.files.values()].filter((f) => f.meta.name === 'khizana.json').length === 1)
fake2.server.close()

server.close()
summary()
