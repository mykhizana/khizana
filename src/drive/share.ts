// Share links of ready dossiers and of single documents. The PDF goes into the owner's Google Drive,
// in a folder of its own («خزانة — ملفات مشتركة»), with an «anyone with the link can view» permission
// (drive.file allows it on the files the app made). Taking the link back deletes that copy: the link
// stops working at once. Every copy carries its end date in Drive, so an expired link is removed by
// whichever device of the owner tidies Drive first, even one that never saw the link being made.
// No imports from the app here (the tests run it against a stand-in Drive): the database comes in `db`.
import { FOLDER, type Drive } from './api'

export const SHARE_FOLDER = 'خزانة — ملفات مشتركة'
export const SHARE_DAYS = [1, 7, 30, 90] as const
type Db = { call: <T = unknown>(fn: string, p?: unknown) => Promise<T> }
export type Published = { id: string; url: string; expires_at: string; file: string }

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
  o: { pdf: Blob; name: string; days: number; collection_id?: string | null; document_id?: string | null; label?: string | null; watermark?: string | null; now?: number },
): Promise<Published> {
  const id = crypto.randomUUID()
  const days = Math.min(Math.max(Math.round(o.days) || 30, 1), 365)
  const expires = new Date((o.now ?? Date.now()) + days * DAY).toISOString()
  const folder = await shareFolder(drive)
  const file = await drive.create({ name: fileName(o.name), parents: [folder], mimeType: 'application/pdf', appProperties: { kh: 'share', sid: id, exp: expires } }, o.pdf)
  try {
    const { permissionId, link } = await drive.share(file.id)
    const r = await db.call<{ id: string; expires_at: string }>('kh_share_add', {
      id,
      collection_id: o.collection_id ?? null,
      document_id: o.document_id ?? null,
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
 * Tidies the shared copies: deletes those whose link ended (its date passed, it was taken back on a
 * device that could not reach Drive, or its dossier / document was deleted), and marks as taken back
 * the links whose copy was deleted by hand in Drive.
 */
export async function sweepShares(drive: Drive, db: Db, now = Date.now()): Promise<{ removed: number; closed: number }> {
  const copies = await drive.list(`appProperties has { key='kh' and value='share' } and trashed = false`)
  const sids = copies.map((f) => f.appProperties?.sid).filter((x): x is string => !!x)
  const state = sids.length ? await db.call<Record<string, 'live' | 'expired' | 'revoked' | 'gone'>>('kh_shares_state', { ids: sids }) : {}
  let removed = 0
  let closed = 0
  const kept = new Set<string>()
  for (const f of copies) {
    const sid = f.appProperties?.sid ?? ''
    const st = (sid && state[sid]) || 'gone'
    const exp = Date.parse(f.appProperties?.exp ?? '')
    const age = now - (Date.parse(f.createdTime ?? '') || now)
    // a link made a moment ago on another device may not have reached this one yet: a day's grace
    const ended = st === 'expired' || st === 'revoked' || (Number.isFinite(exp) && exp <= now) || (st === 'gone' && age > DAY)
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
  for (const s of await db.call<{ id: string; created_at: string }[]>('kh_shares_list', { open: true })) {
    if (kept.has(s.id) || now - Date.parse(s.created_at) < 3600_000) continue
    await db.call('kh_share_revoke', { id: s.id })
    closed++
  }
  return { removed, closed }
}
