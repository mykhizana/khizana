// Files the owner picks in Google Drive, brought into the archive. Google's own window (src/drive/picker.ts)
// shows the whole Drive, but the app reaches only the files picked there (drive.file). Each is fetched as it
// is — Google Docs, Sheets, Slides and Drawings come as PDF, converted by Google — and then goes through the
// same steps as any added file (the duplicate check first). The originals stay in Drive, untouched.
import { DriveError, FOLDER, type Drive, type DriveFile } from './api'

export type Picked = { id: string; name: string; mimeType?: string }
export type Skipped = { id: string; name: string; why: string }

/** at most this many files in one go (Google's window stops there too) */
export const PICK_MAX = 50
/** larger files stay in Drive: the archive is for documents, and the browser holds each file whole */
export const SIZE_MAX = 200 * 1024 * 1024

const GOOGLE = 'application/vnd.google-apps.'
const SHORTCUT = `${GOOGLE}shortcut`
/** the Google files Google itself turns into PDF */
const AS_PDF = new Set([`${GOOGLE}document`, `${GOOGLE}spreadsheet`, `${GOOGLE}presentation`, `${GOOGLE}drawing`])

/** the extensions known for each type (the first is added when the name carries none of them) */
const EXT: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/heic': ['heic', 'heif'],
  'image/heif': ['heif', 'heic'],
  'image/gif': ['gif'],
  'image/bmp': ['bmp'],
  'image/tiff': ['tif', 'tiff'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'text/plain': ['txt', 'text', 'log', 'md', 'csv', 'json', 'xml'],
  'text/csv': ['csv'],
  'text/markdown': ['md', 'markdown'],
  'application/json': ['json'],
  'application/zip': ['zip'],
  'application/x-zip-compressed': ['zip'],
}

const cleanName = (name: string) => name.replace(/[\\/]+/g, '-').trim() || 'وثيقة من Google Drive'
const extOf = (name: string) => (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase()

/** Drive names often carry no extension («صورة الجواز»), and the archive also reads a file by its extension */
export function importName(name: string, mime: string): string {
  const base = cleanName(name)
  const known = EXT[mime.toLowerCase()]
  if (!known) return base
  return known.includes(extOf(base)) ? base : `${base}.${known[0]}`
}

/** a Google file converted to PDF: «رسالة.docx» (a Word file opened in Google Docs) becomes «رسالة.pdf» */
function pdfName(name: string): string {
  return importName(cleanName(name).replace(/\.(docx?|odt|rtf|xlsx?|ods|csv|tsv|pptx?|odp|txt)$/i, ''), 'application/pdf')
}

/** why a file could not be fetched, in words for the owner */
export function importReason(e: unknown): string {
  if (e instanceof DriveError) {
    if (e.auth) return 'انتهت ساعة Google: اضغط «من Google Drive» مرة أخرى'
    if (e.reason === 'exportSizeLimitExceeded') return 'أكبر من أن يحوّله Google إلى PDF: افتحه في Drive ثم «ملف ← تنزيل ← PDF» وأضفه من جهازك'
    if (e.status === 404) return 'لم تعد خزانة تصل إليه: ربما حُذف أو نُقل'
    if (e.status === 403) return 'لا يسمح Google بتنزيله (منعه صاحبه، أو بلغ حدّ التنزيل)'
    if (e.status === 0) return 'انقطع الاتصال بـ Google Drive: أعد المحاولة'
    return e.message
  }
  return (e as Error)?.message || 'تعذّر جلبه من Google Drive'
}

async function fetchOne(drive: Drive, p: Picked, max: number): Promise<File | Skipped> {
  const skip = (why: string): Skipped => ({ id: p.id, name: p.name, why })
  let f: DriveFile | null = await drive.get(p.id, 'shortcutDetails')
  if (!f) return skip('لم تعد خزانة تصل إليه: ربما حُذف أو نُقل')
  if (f.mimeType === SHORTCUT) {
    // (the app may reach the shortcut but not the file it points to: only what was picked is open to it)
    const target = f.shortcutDetails?.targetId
      ? await drive.get(f.shortcutDetails.targetId, 'shortcutDetails').catch((e) => {
          if (e instanceof DriveError && e.auth) throw e
          return null
        })
      : null
    if (!target || target.mimeType === SHORTCUT) return skip('اختصار لملف آخر: اختر الملف من مكانه الأصلي')
    f = target
  }
  const name = f.name || p.name
  if (f.appProperties?.kh) return skip('نسخة صنعتها خزانة نفسها: الوثيقة في أرشيفك أصلاً')
  if (f.mimeType === FOLDER) return skip('مجلد: افتحه في نافذة Google واختر ملفاته')
  const mime = f.mimeType ?? ''
  if (AS_PDF.has(mime)) return new File([await drive.exportAs(f.id, 'application/pdf')], pdfName(name), { type: 'application/pdf' })
  if (mime.startsWith(GOOGLE)) return skip('من أنواع Google التي لا تتحول إلى PDF (نموذج، خريطة، موقع…)')
  if (Number(f.size ?? 0) > max) return skip(`أكبر من ${Math.round(max / 1024 / 1024)} ميغابايت: إن كان وثيقة فعلاً فنزّله وأضفه من جهازك`)
  const blob = await drive.download(f.id)
  const type = mime && mime !== 'application/octet-stream' ? mime : blob.type
  return new File([blob], importName(name, type), { type })
}

export type FetchOptions = {
  /** before each file: how many are done, out of how many, and the one on its way (once more at the end) */
  onStep?: (done: number, total: number, name: string) => void
  /** the size limit (tests) */
  max?: number
}

/** the picked files, fetched one after the other; the ones left behind come with the reason */
export async function fetchPicked(drive: Drive, picked: Picked[], opts: FetchOptions = {}): Promise<{ files: File[]; skipped: Skipped[] }> {
  const files: File[] = []
  const skipped: Skipped[] = picked.slice(PICK_MAX).map((p) => ({ id: p.id, name: p.name, why: `أكثر من ${PICK_MAX} ملفاً في دفعة واحدة: اختره في دفعة أخرى` }))
  const list = picked.slice(0, PICK_MAX)
  for (let i = 0; i < list.length; i++) {
    opts.onStep?.(i, list.length, list[i].name)
    try {
      const got = await fetchOne(drive, list[i], opts.max ?? SIZE_MAX)
      if (got instanceof File) files.push(got)
      else skipped.push(got)
    } catch (e) {
      const why = importReason(e)
      // Google's hour is over: the others would all fail the same way
      const rest = e instanceof DriveError && e.auth ? list.slice(i) : [list[i]]
      skipped.push(...rest.map((p) => ({ id: p.id, name: p.name, why })))
      if (rest.length > 1) break
    }
  }
  opts.onStep?.(list.length, list.length, '')
  return { files, skipped }
}
