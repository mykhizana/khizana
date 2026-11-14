// Dates and sizes for an Arabic interface, with Latin digits (as on Moroccan documents)
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'ماي', 'يونيو', 'يوليوز', 'غشت', 'شتنبر', 'أكتوبر', 'نونبر', 'دجنبر']

export function fmtDate(iso: string | null | undefined, precision?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso)
  if (Number.isNaN(d.getTime())) return ''
  if (precision === 'year') return String(d.getFullYear())
  if (precision === 'month') return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'الآن'
  if (s < 3600) return `قبل ${Math.round(s / 60)} د`
  if (s < 86400) return `قبل ${Math.round(s / 3600)} س`
  if (s < 86400 * 30) return `قبل ${Math.round(s / 86400)} يوم`
  return fmtShortDate(iso)
}

export function daysUntil(iso: string): number {
  const d = new Date(iso + 'T00:00:00')
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - t.getTime()) / 864e5)
}

export function fmtSize(bytes: number | null | undefined): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`
}

export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US')

/** Arabic counting: وثيقة واحدة · وثيقتان · 3 وثائق · 11 وثيقة */
export const docsAr = (n: number) => (n === 1 ? 'وثيقة واحدة' : n === 2 ? 'وثيقتان' : n >= 3 && n <= 10 ? `${n} وثائق` : `${n} وثيقة`)
export const daysAr = (n: number) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n >= 3 && n <= 10 ? `${n} أيام` : `${n} يوماً`)
export const pagesAr = (n: number) => (n === 1 ? 'صفحة واحدة' : n === 2 ? 'صفحتان' : n >= 3 && n <= 10 ? `${n} صفحات` : `${n} صفحة`)

export function docTitle(d: { title_ar?: string | null; title?: string | null; file_name?: string | null }): string {
  return d.title_ar || d.title || d.file_name || 'وثيقة بلا عنوان'
}

export function pathText(p: { name: string }[] | null | undefined): string {
  return (p ?? []).map((x) => x.name).join(' ← ')
}

export function uuid(): string {
  return crypto.randomUUID()
}

export function extOf(name: string | null | undefined): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name ?? '')
  return m ? m[1].toLowerCase() : ''
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document'
}
