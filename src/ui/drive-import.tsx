// «من Google Drive» on the add page: Google's sign-in when needed, then Google's own window to choose files
// (src/drive/picker.ts). With the local stand-in for Drive (VITE_DRIVE_FAKE) a small window of this app
// lists the stand-in's files instead, so the whole way can be tried without a Google account.
import { CloudDownload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { FOLDER, type DriveFile } from '@/drive/api'
import { auth } from '@/drive/auth'
import type { Picked } from '@/drive/import'
import { PICK_MAX } from '@/drive/import'
import { drivePicker } from '@/drive/picker'
import { drive } from '@/drive/sync'
import { fmtSize } from '@/lib/format'
import { Button, Dialog, Spinner } from './kit'

/** a Google client id is known on this device (built in, or pasted in the settings) */
export function useCanDrive(): boolean {
  const [ok, setOk] = useState(auth.builtIn || auth.fake)
  useEffect(() => {
    let live = true
    const check = () => void auth.clientId().then((id) => live && setOk(!!id))
    check()
    const off = auth.subscribe(check)
    return () => {
      live = false
      off()
    }
  }, [])
  return ok
}

/** Google's scripts fetched ahead, when the owner reaches for the button (its click must open Google's window at once) */
export function prepareDrive() {
  auth.prepare()
  if (!auth.fake) drivePicker.prepare()
}

/**
 * From a click: Google's sign-in first when there is no token or less than a quarter of an hour left (the
 * fetching must not run out of time), then the window to choose files. [] when the owner closes it.
 */
export async function pickFromDrive(fakeWindow: () => Promise<Picked[]>): Promise<Picked[]> {
  const left = ((await auth.expiresAt()) ?? 0) - Date.now()
  if (!(await auth.token()) || left < 15 * 60_000) await auth.connect()
  const token = await auth.token()
  if (!token) throw new Error('لم يكتمل الدخول إلى Google')
  if (auth.fake) return fakeWindow()
  return drivePicker.pick(token, await auth.clientId())
}

/** the stand-in's files, as Google's window would show them (the whole Drive, folders aside) */
export function FakeDrivePicker({ onDone }: { onDone: (picked: Picked[]) => void }) {
  const [list, setList] = useState<DriveFile[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  useEffect(() => {
    drive.list('trashed = false').then(
      (all) => setList(all.filter((f) => f.mimeType !== FOLDER)),
      () => setList([]),
    )
  }, [])
  const toggle = (id: string) =>
    setChosen((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else if (n.size < PICK_MAX) n.add(id)
      return n
    })
  const close = () => onDone([])
  return (
    <Dialog
      open
      onClose={close}
      title={
        <span className="inline-flex items-center gap-2">
          <CloudDownload className="size-5 text-brand-600" /> Google Drive (نسخة تجريبية)
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            إلغاء
          </Button>
          <Button disabled={!chosen.size} onClick={() => onDone((list ?? []).filter((f) => chosen.has(f.id)).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })))}>
            اختر {chosen.size || ''}
          </Button>
        </>
      }
    >
      {list === null ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : !list.length ? (
        <p className="py-6 text-center text-sm text-muted">لا ملفات في Drive التجريبي.</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((f) => (
            <li key={f.id}>
              <label className="flex cursor-pointer items-center gap-3 py-2.5 text-sm">
                <input type="checkbox" className="size-4 accent-brand-600" checked={chosen.has(f.id)} onChange={() => toggle(f.id)} />
                <span dir="auto" className="min-w-0 flex-1 truncate text-ink">
                  {f.name}
                </span>
                <span className="shrink-0 text-xs text-muted" dir="ltr">
                  {f.size ? fmtSize(Number(f.size)) : (f.mimeType ?? '').replace('application/vnd.google-apps.', 'Google ')}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
