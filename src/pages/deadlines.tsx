// «الآجال» — the deadline radar: validity dates of the papers (passport, residence card, insurance,
// contracts…) and the dates letters ask for, the owner's own reminders, and the phone reminders
// through Google Calendar (src/drive/reminders.ts).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, BellRing, CalendarClock, Check, FileText, Lock, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { reminders } from '@/drive/reminders'
import { MODE } from '@/lib/config'
import { daysUntil, fmtDate } from '@/lib/format'
import type { DeadlineItem } from '@/lib/types'
import { PageHeader } from '@/ui/bits'
import { Badge, Button, Card, Field, IconButton, Input, Skeleton, cn } from '@/ui/kit'
import { useVault, vault } from '@/ui/vault'

const KIND: Record<DeadlineItem['kind'], { label: string; icon: typeof AlarmClock }> = {
  expiry: { label: 'انتهاء صلاحية', icon: CalendarClock },
  action: { label: 'موعد مطلوب', icon: AlarmClock },
  reminder: { label: 'تذكير', icon: BellRing },
}

function ago(t: number | null) {
  if (!t) return null
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'الآن' : m < 60 ? `قبل ${m} دقيقة` : m < 1440 ? `قبل ${Math.round(m / 60)} ساعة` : `قبل ${Math.round(m / 1440)} يوم`
}

function Row({ d, onChange }: { d: DeadlineItem; onChange: () => Promise<void> }) {
  const n = daysUntil(d.due_date)
  const K = KIND[d.kind] ?? KIND.reminder
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
      <div className={cn('grid size-9 shrink-0 place-items-center rounded-lg', d.done ? 'bg-surface-2 text-subtle' : n < 0 ? 'bg-danger-bg text-danger' : n <= 30 ? 'bg-warning-bg text-warning' : 'bg-brand-50 text-brand-600')}>
        <K.icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm font-medium text-ink', d.done && 'text-muted line-through')}>{d.title}</div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="num">{fmtDate(d.due_date)}</span>
          <span>· {K.label}</span>
          {d.document_id && (
            <Link to={`/doc/${d.document_id}`} className="inline-flex min-w-0 items-center gap-1 text-brand-700 hover:underline dark:text-brand-200">
              · {d.vault && <Lock className="size-3" />}
              <span className="max-w-[14rem] truncate">{d.doc_title}</span>
            </Link>
          )}
        </div>
      </div>
      {!d.done && <Badge tone={n < 0 ? 'danger' : n <= 30 ? 'warning' : 'neutral'}>{n < 0 ? `فات منذ ${-n} يوم` : n === 0 ? 'اليوم' : `بعد ${n} يوم`}</Badge>}
      <IconButton
        icon={d.done ? RotateCcw : Check}
        label={d.done ? 'أعده إلى القائمة' : 'أُنجز'}
        size="sm"
        onClick={async () => {
          await api.deadlineDone(d.id, !d.done)
          await onChange()
        }}
      />
      <IconButton
        icon={Trash2}
        label="احذف"
        size="sm"
        className="hover:text-danger"
        onClick={async () => {
          if (!confirm('أحذف هذا الموعد؟')) return
          await api.deadlineDelete(d.id)
          await onChange()
        }}
      />
    </li>
  )
}

function Group({ title, items, onChange, tone }: { title: string; items: DeadlineItem[]; onChange: () => Promise<void>; tone?: 'danger' | 'warning' }) {
  if (!items.length) return null
  return (
    <section>
      <h2 className={cn('mb-2 text-sm font-semibold', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink')}>
        {title} <span className="num text-muted">({items.length})</span>
      </h2>
      <ul className="space-y-2">
        {items.map((d) => (
          <Row key={d.id} d={d} onChange={onChange} />
        ))}
      </ul>
    </section>
  )
}

function PhoneReminders() {
  const r = useSyncExternalStore(reminders.subscribe, reminders.get)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void reminders.refresh()
  }, [])
  const act = async (f: () => Promise<void>, ok?: string) => {
    setBusy(true)
    try {
      await f()
      if (ok) toast.success(ok)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <BellRing className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink">تذكير على هاتفك</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-muted">
            تكتب خزانة كل موعد في تقويم «خزانة — الآجال» داخل Google Calendar: تذكير قبل شهرين، وقبل شهر، وقبل أسبوع، وفي اليوم نفسه، الساعة 9 صباحاً، مع رابط الوثيقة. تطبيق Google Calendar في هاتفك يرسل الإشعار ولو كانت خزانة مغلقة. وثائق الخزنة تظهر بعنوان محايد.
          </p>
          {r.enabled && r.granted && (
            <p className="mt-2 text-sm text-ink">
              <span className="text-success">مفعّل</span>
              {r.total != null && (
                <>
                  {' '}
                  · <span className="num">{r.total}</span> تذكيراً في تقويمك
                </>
              )}
              {r.lastSync && <span className="text-muted"> · آخر تحديث {ago(r.lastSync)}</span>}
            </p>
          )}
          {r.enabled && !r.granted && <p className="mt-2 text-sm text-warning">التذكير مفعّل، لكن هذا الجهاز لم يُعطَ صلاحية التقويم بعد.</p>}
          {r.error && <p className="mt-2 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">{r.error}</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {!r.enabled ? (
          <Button icon={BellRing} loading={busy} onClick={() => act(() => reminders.enable(), 'فُعّل التذكير: افتح Google Calendar في هاتفك لترى تقويم «خزانة — الآجال»')}>
            فعّل التذكير في Google Calendar
          </Button>
        ) : !r.granted ? (
          <Button icon={BellRing} loading={busy} onClick={() => act(() => reminders.enable(), 'صار هذا الجهاز يحدّث التذكيرات أيضاً')}>
            أعطِ هذا الجهاز صلاحية التقويم
          </Button>
        ) : (
          <>
            <Button variant="secondary" icon={RefreshCw} loading={busy || r.busy} onClick={() => act(() => reminders.syncNow(), 'حُدّثت التذكيرات')}>
              حدّث الآن
            </Button>
            <Button variant="ghost" loading={busy} onClick={() => act(() => reminders.disable(), 'أوقِف تحديث التذكيرات')}>
              أوقف
            </Button>
          </>
        )}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        إن لم تصلك الإشعارات: في تطبيق Google Calendar ← القائمة ← الإعدادات ← «خزانة — الآجال»، وتأكد أن التقويم ظاهر وأن إشعاراته مفعّلة.
      </p>
    </Card>
  )
}

export default function DeadlinesPage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [withDone, setWithDone] = useState(false)
  const list = useQuery({ queryKey: ['deadlines', withDone], queryFn: () => api.deadlines(withDone) })
  const v = useVault()
  const docId = params.get('doc')
  const docTitle = params.get('title')
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [adding, setAdding] = useState(false)

  const changed = async () => {
    await qc.invalidateQueries({ queryKey: ['deadlines'] })
    await qc.invalidateQueries({ queryKey: ['overview'] })
    if (docId) await qc.invalidateQueries({ queryKey: ['doc', docId] })
    if (MODE === 'local') reminders.soon()
  }

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !date) return toast.error('اكتب الموعد واختر تاريخه')
    setAdding(true)
    try {
      await api.deadlineAdd({ title: title.trim(), due_date: date, document_id: docId, kind: docId ? 'action' : 'reminder' })
      setTitle('')
      setDate('')
      if (docId) setParams({}, { replace: true })
      toast.success('أُضيف الموعد')
      await changed()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const items = list.data ?? []
  const open = items.filter((d) => !d.done)
  const days = (d: DeadlineItem) => daysUntil(d.due_date)

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="الآجال" icon={AlarmClock} subtitle="تواريخ انتهاء صلاحية وثائقك والمواعيد التي تطلبها منك، تكتشفها خزانة وحدها، ومعها تذكير على هاتفك." />

      {MODE === 'local' && <PhoneReminders />}

      {MODE === 'local' && v.configured && !v.open && (
        <Card className="flex flex-wrap items-center gap-3 border-brass-400/50 bg-brass-100/50 p-4 text-sm">
          <Lock className="size-5 shrink-0 text-brass-600" />
          <span className="min-w-0 flex-1 leading-relaxed">الخزنة مقفلة: مواعيد وثائقها مخفية هنا (لكن تذكيراتها في هاتفك باقية).</span>
          <Button size="sm" variant="brass" onClick={() => void vault.open()}>
            افتح الخزنة
          </Button>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="font-semibold text-ink">أضف موعداً</h2>
        {docId && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
            <FileText className="size-4" /> للوثيقة: <span className="text-ink">{docTitle ?? '…'}</span>
          </p>
        )}
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={add}>
          <Field label="ما الموعد؟" className="min-w-[12rem] flex-1">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً: تجديد بطاقة الإقامة" dir="auto" />
          </Field>
          <Field label="التاريخ" className="w-44">
            <Input type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Button type="submit" icon={Plus} loading={adding}>
            أضف
          </Button>
        </form>
      </Card>

      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : open.length === 0 && !withDone ? (
        <Card className="p-6 text-center text-sm leading-relaxed text-muted">
          لا موعد مفتوحاً. حين تقرأ خزانة جوازاً أو بطاقة إقامة أو تأميناً أو عقداً أو رسالة تطلب منك شيئاً بتاريخ، يظهر موعده هنا وحده.
        </Card>
      ) : (
        <div className="space-y-5">
          <Group title="فات موعدها" tone="danger" items={open.filter((d) => days(d) < 0)} onChange={changed} />
          <Group title="خلال 30 يوماً" tone="warning" items={open.filter((d) => days(d) >= 0 && days(d) <= 30)} onChange={changed} />
          <Group title="خلال ستة أشهر" items={open.filter((d) => days(d) > 30 && days(d) <= 183)} onChange={changed} />
          <Group title="بعد ذلك" items={open.filter((d) => days(d) > 183)} onChange={changed} />
          {withDone && <Group title="أُنجزت" items={items.filter((d) => d.done)} onChange={changed} />}
        </div>
      )}
      <button type="button" className="text-sm text-brand-700 hover:underline dark:text-brand-200" onClick={() => setWithDone((x) => !x)}>
        {withDone ? 'أخفِ ما أُنجز' : 'اعرض ما أُنجز أيضاً'}
      </button>
    </div>
  )
}
