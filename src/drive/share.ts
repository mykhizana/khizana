// Share links of ready dossiers and of single documents. The PDF goes into the owner's Google Drive,
// in a folder of its own («خزانة — ملفات مشتركة»), with an «anyone with the link can view» permission
// (drive.file allows it on the files the app made). Taking the link back deletes that copy: the link
// stops working at once. Drive cannot end such a link by itself, so every copy carries its end date,
// its link id, the device that made it and the archive; whichever device of the owner runs next
// deletes the copies whose link has ended.
// No imports from the app here (the tests run it against a stand-in Drive): the database comes in `db`.
import { FOLDER, type Drive } from './api'

export const SHARE_FOLDER = 'خزانة — ملفات مشتركة'
export const SHARE_DAYS = [1, 7, 30, 90] as const
type Db = { call: <T = unknown>(fn: string, p?: unknown) => Promise<T> }
export type Published = { id: string; url: string; expires_at: string; file: string }
/**
 * Who tidies: this device and its archive (copies of another archive are never touched). `linked`: a
 * device outside the archive knows only its own links, so it judges only its own copies by their state;
 * any copy past its own end date goes, whoever made it.
 */
export type SweepContext = { device: string; archive: string | null; linked?: boolean; now?: number }
type LinkState = 'live' | 'expired' | 'revoked' | 'deleted' | 'unknown' | 'gone'

const DAY = 864e5
const fileName = (s: string) => (s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'khizana') + '.pdf'

/** the app's folder of shared copies (made once, found again by its mark) */
export async function shareFolder(drive: Drive): Promise<string> {
  const have = await drive.list(`appProperties has { key='kh' and value='shares' } and trashed = false`)
  if (have[0]) return have[0].id
  return (await drive.create({ name: SHARE_FOLDER, mimeType: FOLDER, appProperties: { kh: 'shares' } })).id
}

/** the PDF into Drive, a link anyone can open (but nobody can find), and the link noted in the archive */
export async function publishShare(
  drive: Drive,
  db: Db,
  o: {
    pdf: Blob
    name: string
    days: number
    collection_id?: string | null
    document_id?: string | null
    /** the documents put in the PDF (a vault one hides the link while the vault is closed) */
    documents?: string[]
    label?: string | null
    watermark?: string | null
    device?: string | null
    archive?: string | null
    now?: number
  },
): Promise<Published> {
  const id = crypto.randomUUID()
  const days = Math.min(Math.max(Math.round(o.days) || 30, 1), 365)
  const expires = new Date((o.now ?? Date.now()) + days * DAY).toISOString()
  const folder = await shareFolder(drive)
  const props: Record<string, string> = { kh: 'share', sid: id, exp: expires }
  if (o.device) props.dev = o.device
  if (o.archive) props.arc = o.archive
  const file = await drive.create({ name: fileName(o.name), parents: [folder], mimeType: 'application/pdf', appProperties: props }, o.pdf)
  try {
    const { permissionId, link } = await drive.share(file.id)
    const r = await db.call<{ id: string; expires_at: string }>('kh_share_add', {
      id,
      collection_id: o.collection_id ?? null,
      document_id: o.document_id ?? null,
      documents: o.documents ?? [],
      label: o.label ?? null,
      watermark: o.watermark ?? null,
      expires_at: expires,
      drive_file: file.id,
      permission_id: permissionId,
      url: link,
    })
    return { id: r.id, url: link, expires_at: r.expires_at, file: file.id }
  } catch (e) {
    // no stray shared copy when the link could not be made or noted
    await drive.remove(file.id).catch(() => undefined)
    throw e
  }
}

/** the link stops working: its copy is deleted from Drive, then it is marked as taken back */
export async function revokeShare(drive: Drive, db: Db, s: { id: string; drive_file: string | null }): Promise<void> {
  if (s.drive_file) await drive.remove(s.drive_file)
  await db.call('kh_share_revoke', { id: s.id })
}

/**
 * Tidies the shared copies. A copy is deleted when its link has ended: its end date passed, it was
 * taken back (on a device that could not reach Drive), or its dossier / document was deleted. A copy
 * whose link this device does not know is kept — another device may have made it — unless this
 * device made it more than a day ago (its link was never noted: a failed publish). Links whose copy was
 * deleted by hand in Drive are marked as taken back, once Drive confirms the copy is gone.
 */
export async function sweepShares(drive: Drive, db: Db, ctx: SweepContext): Promise<{ removed: number; closed: number }> {
  const now = ctx.now ?? Date.now()
  const copies = (await drive.list(`appProperties has { key='kh' and value='share' } and trashed = false`)).filter(
    (f) => !f.appProperties?.arc || !ctx.archive || f.appProperties.arc === ctx.archive,
  )
  const sids = copies.map((f) => f.appProperties?.sid).filter((x): x is string => !!x)
  const state = sids.length ? await db.call<Record<string, LinkState>>('kh_shares_state', { ids: sids }) : {}
  let removed = 0
  let closed = 0
  const kept = new Set<string>()
  for (const f of copies) {
    const sid = f.appProperties?.sid ?? ''
    const st: LinkState = (sid && state[sid]) || 'unknown'
    const exp = Date.parse(f.appProperties?.exp ?? '')
    const age = now - (Date.parse(f.createdTime ?? '') || now)
    const mine = !!f.appProperties?.dev && f.appProperties.dev === ctx.device
    const knows = ctx.linked !== false || mine
    const ended =
      (Number.isFinite(exp) && exp <= now) ||
      (knows && (st === 'expired' || st === 'revoked' || st === 'deleted')) ||
      ((st === 'unknown' || st === 'gone') && mine && age > DAY)
    if (!ended) {
      kept.add(sid)
      continue
    }
    await drive.remove(f.id)
    removed++
    if (st === 'live' || st === 'expired') {
      await db.call('kh_share_revoke', { id: sid })
      closed++
    }
  }
  // a copy missing from the listing: asked again (Drive's search can lag) before the link is closed
  for (const s of await db.call<{ id: string; created_at: string; drive_file: string | null }[]>('kh_shares_list', { open: true })) {
    if (kept.has(s.id) || now - Date.parse(s.created_at) < 3600_000) continue
    const f = s.drive_file ? await drive.get(s.drive_file) : null
    if (f && !f.trashed) continue
    await db.call('kh_share_revoke', { id: s.id })
    closed++
  }
  return { removed, closed }
}

/** the soonest end date among open links (to tidy right then while the app is open) */
export function nextEnd(links: { expires_at: string; revoked: boolean }[], now = Date.now()): number | null {
  const ends = links.filter((l) => !l.revoked).map((l) => Date.parse(l.expires_at)).filter((t) => Number.isFinite(t) && t > now)
  return ends.length ? Math.min(...ends) : null
}
