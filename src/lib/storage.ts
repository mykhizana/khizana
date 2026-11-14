// The archive lives in this browser's storage (IndexedDB). When the disk is nearly full, browsers
// delete the data of sites whose storage is not «persistent» — on 2026-11-14 the owner lost the
// documents, the Claude key and the Drive link on a refresh, with 0.5 GB left on the C: drive.
// So: ask for persistent storage at start, and warn while the storage is at risk.
export type StorageRisk = 'ok' | 'low' | 'critical'
export type StorageHealth = { persisted: boolean | null; used: number; quota: number; risk: StorageRisk }

/**
 * The browser's quota follows the free space of the disk (Chromium caps it by what is left), so a
 * small quota means a nearly full disk. Below 800 MB the next refresh may wipe the archive.
 */
export function storageRisk(quota: number, used: number): StorageRisk {
  if (!quota) return 'ok'
  if (quota < 800e6 || used / quota > 0.9) return 'critical'
  if (quota < 2e9 || used / quota > 0.75) return 'low'
  return 'ok'
}

let asked = false
/** asks once per visit that the browser never deletes this archive by itself; true when it agreed */
export async function ensurePersistence(force = false): Promise<boolean | null> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined
  if (!s?.persisted) return null
  try {
    if (await s.persisted()) return true
    if ((asked && !force) || !s.persist) return false
    asked = true
    return await s.persist()
  } catch {
    return null
  }
}

export async function storageHealth(): Promise<StorageHealth> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined
  let persisted: boolean | null = null
  let used = 0
  let quota = 0
  try {
    persisted = s?.persisted ? await s.persisted() : null
  } catch {
    persisted = null
  }
  try {
    const e = s?.estimate ? await s.estimate() : null
    used = e?.usage ?? 0
    quota = e?.quota ?? 0
  } catch {
    /* unknown */
  }
  return { persisted, used, quota, risk: storageRisk(quota, used) }
}
