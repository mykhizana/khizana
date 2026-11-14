// Google Drive on screen: the state in the menu, the «continue» bar when Google's hour is over, and
// the settings block (linking a device, what waits to be sent, room on this device).
import { AlertTriangle, CheckCircle2, Cloud, CloudOff, FolderTree, HardDrive, KeyRound, Link2, LogIn, RefreshCw, Unlink, UploadCloud } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { auth } from '@/drive/auth'
import { driveSync, type DriveSnapshot } from '@/drive/sync'
import type { ArchiveInfo } from '@/drive/engine'
import { fmtNum, fmtSize } from '@/lib/format'
import { Badge, Button, Card, Dialog, Field, Input, Progress, Spinner, Switch, cn } from './kit'

export function useDrive(): DriveSnapshot {
  return useSyncExternalStore(driveSync.subscribe, driveSync.getSnapshot)
}

function ago(t: number | null) {
  if (!t) return 'لم تتم بعد'
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'الآن'
  if (s < 3600) return `قبل ${Math.round(s / 60)} دقيقة`
  if (s < 86400) return `قبل ${Math.round(s / 3600)} ساعة`
  return `قبل ${Math.round(s / 86400)} يوم`
}

async function reconnect() {
  try {
    await auth.connect()
    toast.success('عاد الاتصال بـ Google Drive')
    void driveSync.syncNow()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const LABEL: Record<DriveSnapshot['state'], string> = {
  off: 'على هذا الجهاز',
  ready: 'متزامن مع Drive',
  busy: 'يتزامن مع Drive…',
  auth: 'Drive ينتظر ضغطة',
  offline: 'بلا اتصال',
  full: 'Drive ممتلئ',
  error: 'خطأ في المزامنة',
}

/** a small line in the menu: where the archive is and how the sync goes */
export function DriveChip({ className }: { className?: string }) {
  const d = useDrive()
  if (!d.linked)
    return (
      <span className={cn('inline-flex items-center gap-1.5', className)} title="كل شيء محفوظ في هذا المتصفح">
        <HardDrive className="size-3.5" />
        على هذا الجهاز
      </span>
    )
  const Icon = d.state === 'busy' ? RefreshCw : d.state === 'ready' ? Cloud : d.state === 'offline' ? CloudOff : AlertTriangle
  return (
    <button
      type="button"
      onClick={d.state === 'auth' ? reconnect : undefined}
      data-drive-renew
      title={d.busy ?? d.message ?? `آخر مزامنة: ${ago(d.lastSync)}`}
      className={cn('inline-flex items-center gap-1.5', d.state === 'auth' || d.state === 'full' || d.state === 'error' ? 'text-warning' : '', className)}
    >
      <Icon className={cn('size-3.5', d.state === 'busy' && 'animate-spin')} />
      {LABEL[d.state]}
    </button>
  )
}

/** above every screen when the sync stopped and needs the owner */
export function DriveBanner() {
  const d = useDrive()
  if (!d.linked || (d.state !== 'auth' && d.state !== 'full')) return null
  return (
    <Card className="mb-5 flex flex-wrap items-center gap-3 border-brass-400/50 bg-brass-100/50 p-4">
      <Cloud className="size-5 text-brass-600" />
      <div className="min-w-0 flex-1 text-sm">
        {d.state === 'auth' ? (
          <>
            <div className="font-semibold text-ink">انتهت ساعة Google Drive</div>
            <div className="text-muted">
              ما تضيفه محفوظ على هذا الجهاز{d.status?.outbox || d.status?.uploads ? ` (${fmtNum((d.status?.outbox ?? 0) + (d.status?.uploads ?? 0))} بانتظار الإرسال)` : ''}، ويُرسل بعد ضغطة واحدة.
            </div>
          </>
        ) : (
          <>
            <div className="font-semibold text-ink">مساحة Google Drive ممتلئة</div>
            <div className="text-muted">{d.message}</div>
          </>
        )}
      </div>
      {d.state === 'auth' && (
        <Button variant="brass" icon={LogIn} onClick={reconnect} data-drive-renew>
          متابعة
        </Button>
      )}
    </Card>
  )
}

/**
 * Google's permission lasts an hour and only a tap may open Google's window to renew it. So the first
 * tap anywhere in the app, once the permission is about to end (or has ended), renews it — a Google
 * window may flash and close — and the waiting changes go out at once. Without this, a device that
 * stayed open stopped syncing until the owner noticed «متابعة», and the other device saw an old archive.
 */
export function DriveAutoRenew() {
  const d = useDrive()
  useEffect(() => {
    if (!d.linked || !auth.canRenewInPlace()) return
    let last = 0
    const onTap = (ev: MouseEvent) => {
      if (Date.now() - last < 90_000) return
      // the banner's and the chip's own buttons renew by themselves
      if ((ev.target as HTMLElement | null)?.closest?.('[data-drive-renew]')) return
      void (async () => {
        const end = await auth.expiresAt()
        if (end && end - Date.now() > 10 * 60_000) return
        last = Date.now()
        try {
          await auth.connect()
          void driveSync.syncNow()
        } catch {
          /* the banner stays: one tap on «متابعة» */
        }
      })()
    }
    document.addEventListener('click', onTap, true)
    return () => document.removeEventListener('click', onTap, true)
  }, [d.linked])
  return null
}

type Plan = Awaited<ReturnType<typeof driveSync.inspect>>

function LinkDialog({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  if (!plan) return null
  const merge = !!plan.archive && !plan.pristine
  const go = async () => {
    setBusy(true)
    try {
      await driveSync.link(plan.archive as ArchiveInfo | null, (t) => setStep(t))
      toast.success(plan.archive ? 'هذا الجهاز متصل بأرشيفك في Drive' : 'أُنشئ أرشيفك في Drive: تُرفع الملفات في الخلفية')
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      setStep('')
    }
  }
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={plan.archive ? (merge ? 'دمج هذا الجهاز مع أرشيفك في Drive' : 'وجدنا أرشيفك في Drive') : 'إنشاء أرشيفك في Drive'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ليس الآن
          </Button>
          <Button icon={Link2} loading={busy} onClick={go}>
            {merge ? 'ادمج' : 'ابدأ'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-text">
        {!plan.archive ? (
          <>
            <p>يصير هذا الجهاز أصل أرشيفك في Google Drive.</p>
            <p className="text-muted">
              يُرفع ما عليه في الخلفية: <span className="num">{fmtNum(plan.documents)}</span> وثيقة (<span className="num">{fmtSize(plan.bytes)}</span>). تبقى كل وثيقة متاحة هنا أثناء الرفع.
            </p>
          </>
        ) : merge ? (
          <>
            <p>
              على هذا الجهاز <span className="num">{fmtNum(plan.documents)}</span> وثيقة ليست في أرشيف Drive. سيُدمج الاثنان دون تكرار، وتبقى إعدادات أرشيف Drive (السقف الشهري، الرفوف).
            </p>
          </>
        ) : (
          <>
            <p>يُنزَّل فهرس أرشيفك إلى هذا الجهاز، فيعمل البحث فيه حتى دون إنترنت.</p>
            <p className="text-muted">تُفتح الملفات من Drive عند الحاجة، ويحتفظ الجهاز بما فتحته.</p>
          </>
        )}
        {busy && (
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">
            <Spinner className="size-4" />
            {step || 'لحظة…'}
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** the settings block */
export function DriveSettings() {
  const d = useDrive()
  const [clientId, setClientId] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [freed, setFreed] = useState<number | null>(null)

  useEffect(() => {
    auth.prepare()
    void auth.clientId().then((id) => setSavedId(id || null))
    driveSync.watchFull(true)
    void driveSync.refresh()
    const t = setInterval(() => void driveSync.refresh(), 5000)
    return () => {
      clearInterval(t)
      driveSync.watchFull(false)
    }
  }, [])

  const connect = async () => {
    setBusy(true)
    try {
      await auth.connect()
      setPlan(await driveSync.inspect())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const s = d.status
  const quota = d.quota && d.quota.limit > 0 ? d.quota : null

  if (!d.linked)
    return (
      <div className="space-y-4">
        <ul className="space-y-1.5 text-sm leading-relaxed text-text">
          <li>• الملفات في Drive الخاص بك، في مجلد «خزانة» مرتب حسب الرفوف، وكل ورقة ممسوحة ملف PDF.</li>
          <li>• الفهرس على الحاسوب والهاتف معاً، يتزامن عبر Drive، والبحث يعمل دون إنترنت.</li>
          <li>• يستعمل مساحة Google One التي تدفع ثمنها، دون أي اشتراك آخر.</li>
        </ul>
        {!auth.builtIn && !auth.fake && (
          <Field label="معرّف Google (Client ID)" hint="تنشئه مجاناً مرة واحدة في Google Cloud: الخطوات في الدليل. ليس سراً.">
            <div className="flex gap-2">
              <Input dir="ltr" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={savedId ?? '1234…apps.googleusercontent.com'} />
              <Button
                variant="secondary"
                icon={KeyRound}
                onClick={async () => {
                  if (!/\.apps\.googleusercontent\.com$/.test(clientId.trim())) return toast.error('المعرّف ينتهي بـ apps.googleusercontent.com')
                  await auth.setClientId(clientId)
                  setSavedId(clientId.trim())
                  setClientId('')
                  auth.prepare()
                  toast.success('حُفظ المعرّف')
                }}
              >
                حفظ
              </Button>
            </div>
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={Cloud} loading={busy} disabled={!savedId} onClick={connect}>
            اربط Google Drive
          </Button>
          {savedId && !auth.fake && (
            <Button variant="ghost" size="sm" onClick={() => void auth.redirect().catch((e) => toast.error((e as Error).message))}>
              الدخول بطريقة أخرى
            </Button>
          )}
        </div>
        <LinkDialog plan={plan} onClose={() => setPlan(null)} />
      </div>
    )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={d.state === 'ready' ? 'success' : d.state === 'busy' ? 'info' : 'warning'} icon={d.state === 'ready' ? CheckCircle2 : d.state === 'busy' ? RefreshCw : AlertTriangle}>
          {LABEL[d.state]}
        </Badge>
        {d.email && <Badge>{d.email}</Badge>}
        <span className="text-xs text-muted">آخر مزامنة: {ago(d.lastSync)}</span>
      </div>
      {d.busy && <p className="text-xs text-muted">{d.busy}</p>}
      {d.state === 'auth' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning-bg px-3 py-2 text-sm text-warning">
          <span className="flex-1">انتهت ساعة Google: ضغطة واحدة تكمل المزامنة.</span>
          <Button size="sm" variant="brass" icon={LogIn} onClick={reconnect}>
            متابعة
          </Button>
        </div>
      )}
      {d.message && d.state !== 'auth' && <p className="rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">{d.message}</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { l: 'تغييرات بانتظار الإرسال', v: fmtNum(s?.outbox ?? 0) },
          { l: 'ملفات بانتظار الرفع', v: s?.uploads ? `${fmtNum(s.uploads)} · ${fmtSize(s.upload_bytes)}` : '0' },
          { l: 'ملفات في Drive', v: fmtNum(s?.in_drive ?? 0) },
          { l: 'نسخ في مجلد «خزانة»', v: fmtNum(s?.mirrored ?? 0) },
        ].map((x) => (
          <div key={x.l} className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
            <div className="text-xs text-muted">{x.l}</div>
            <div className="num font-semibold text-ink">{x.v}</div>
          </div>
        ))}
      </div>
      {s?.stuck ? (
        <p className="rounded-xl bg-warning-bg px-3 py-2 text-xs text-warning">
          تعذّر رفع <span className="num">{fmtNum(s.stuck)}</span> ملفاً بعد عدة محاولات{s.last_error ? `: ${s.last_error}` : ''}. «زامن الآن» يعيد المحاولة.
        </p>
      ) : null}

      {quota && (
        <div>
          <div className="mb-1.5 flex justify-between text-xs text-muted">
            <span>مساحة Google</span>
            <span className="num" dir="ltr">
              {fmtSize(quota.used) || '0 B'} / {fmtSize(quota.limit)}
            </span>
          </div>
          <Progress value={quota.used / quota.limit} tone={quota.used / quota.limit > 0.9 ? 'danger' : 'brand'} />
        </div>
      )}

      <div className="rounded-xl border border-line p-3">
        <Switch checked={d.mirror} onChange={(v) => void driveSync.setMirror(v)} label={<span className="font-medium text-ink">نسخة مقروءة في مجلد «خزانة»</span>} />
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          <FolderTree className="me-1 inline size-3.5" />
          كل وثيقة في مجلد رفها، باسم واضح، والورقة الممسوحة ملف PDF. تراها من تطبيق Drive نفسه، وتبقى لك مهما حدث. وثائق الخزنة لا تظهر فيها أبداً.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={RefreshCw} onClick={() => void driveSync.syncNow()}>
          زامن الآن
        </Button>
        <Button
          variant="secondary"
          icon={UploadCloud}
          onClick={async () => {
            if (s?.uploads) return toast.error('انتظر حتى تُرفع كل الملفات')
            const n = await driveSync.freeSpace()
            setFreed(n)
            toast.success(n ? `أُفرغت ${fmtNum(n)} نسخة من هذا الجهاز (تبقى في Drive)` : 'لا شيء لإفراغه')
          }}
        >
          وفّر مساحة هذا الجهاز
        </Button>
        <Button
          variant="ghost"
          icon={Unlink}
          className="text-danger"
          onClick={async () => {
            if (!confirm('فصل هذا الجهاز عن Drive؟ يبقى الأرشيف عليه وفي Drive، لكن لا يتزامن حتى تربطه من جديد.')) return
            await driveSync.unlink()
            await auth.disconnect()
          }}
        >
          افصل هذا الجهاز
        </Button>
      </div>
      {freed !== null && <p className="text-xs text-muted">الصور المصغرة والوثائق المعلّمة «متاحة دون إنترنت» تبقى على الجهاز دائماً.</p>}
    </div>
  )
}
