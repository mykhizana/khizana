// The app's side of share links (src/drive/share.ts does the Drive work): publish, take back, and the
// tidying of expired copies — at start and every six hours, one tab at a time, only with a valid
// Google token (it never opens a Google window by itself).
import { api } from '@/db/api'
import { auth } from '@/drive/auth'
import { publishShare, revokeShare, sweepShares, type Published } from '@/drive/share'
import { drive } from '@/drive/sync'
import { MODE } from './config'

const db = { call: api.call }
const EVERY = 6 * 3600_000
let started = false

export const shares = {
  /** a Google token is there (otherwise the owner must connect Google: one click) */
  ready: async () => !!(await auth.token()),

  publish: (o: Parameters<typeof publishShare>[2]): Promise<Published> => publishShare(drive, db, o),

  revoke: (s: { id: string; drive_file: string | null }) => revokeShare(drive, db, s),

  async sweep(): Promise<void> {
    if (!(await auth.token())) return
    const run = () => sweepShares(drive, db).catch(() => undefined)
    if (typeof navigator !== 'undefined' && 'locks' in navigator)
      await navigator.locks.request('khizana-shares', { ifAvailable: true }, async (lock) => {
        if (lock) await run()
      })
    else await run()
  },

  start() {
    if (started || MODE !== 'local') return
    started = true
    setTimeout(() => void shares.sweep(), 30_000)
    setInterval(() => void shares.sweep(), EVERY)
  },
}
