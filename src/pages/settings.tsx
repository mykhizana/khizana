import { useQueryClient } from '@tanstack/react-query'
import { Bot, CheckCircle2, Cloud, Database, DownloadCloud, FolderTree, Gauge, HardDrive, KeyRound, LogOut, Moon, ShieldCheck, Trash2, UploadCloud, Wallet, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { idb } from '@/db/idb'
import { ECONOMY_FROM, modelName, readingMode } from '@/ai/models'
import { economyProblem, getLocalKey, resetAiStatus, resetBudgetCache, setLocalKey, testAi } from '@/ai/transport'
import { MODE } from '@/lib/config'
import { fmtUsd } from '@/lib/cost'
import { fmtNum, fmtSize } from '@/lib/format'
import { allIds, useAiMode, useCounts, useSettings, useUsage } from '@/lib/queries'
import { queue } from '@/pipeline/queue'
import { PageHeader } from '@/ui/bits'
import { exportEverything, importEverything } from '@/ui/download'
import { Badge, Button, Card, Field, Input, Progress, cn } from '@/ui/kit'
import { useTheme } from '@/ui/layout'
import { MfaSettings, VaultBackupNote } from '@/ui/mfa'
import { useStorageHealth } from '@/ui/storage'
import { ensurePersistence } from '@/lib/storage'
import { DriveSettings } from '@/ui/drive'
import { DeviceVaultSettings } from '@/ui/vault'

const OPS: Record<string, string> = { transcribe: 'قراءة الصفحات', understand: 'الفهم والتصنيف', split: 'فصل الرزم', judge: 'مقارنة المتشابهات', query: 'فهم البحث', test: 'اختبار' }

function Block({ id, icon: Icon, title, children, desc }: { id?: string; icon: React.ComponentType<{ className?: string }>; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-24 p-5 sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <Icon className="size-5" />
        </div>
        <div>
          <h2 className="font-semibold text-ink">{title}</h2>
          {desc && <p className="mt-0.5 text-sm leading-relaxed text-muted">{desc}</p>}
        </div>
      </div>
      {children}
    </Card>
  )
}

export default function SettingsPage() {
  const qc = useQueryClient()
  const settings = useSettings().data
  const usage = useUsage().data
  const ai = useAiMode().data
  const counts = useCounts().data
  const { dark, toggle } = useTheme()
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; model?: string; economy?: boolean; error?: string } | null>(null)
  const [cap, setCap] = useState('')
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null)
  const [backup, setBackup] = useState<{ done: number; total: number } | null>(null)
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void getLocalKey().then((k) => setHasKey(!!k))
    void idb.usage().then(setStorage)
  }, [])
  useEffect(() => {
    if (settings?.monthly_cap_usd != null) setCap(String(settings.monthly_cap_usd))
  }, [settings?.monthly_cap_usd])
  useEffect(() => {
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' }), 300)
  }, [])

  const capNum = Number(usage?.cap ?? 0)
  const spent = Number(usage?.month_cost ?? 0)
  const autonomy = (settings?.autonomy as string) ?? 'ask'
  const reading = readingMode(settings?.reading_mode)
  const economyIssue = economyProblem()
  const health = useStorageHealth()

  const saveKey = async () => {
    if (!key.trim().startsWith('sk-ant-')) return toast.error('مفتاح Claude يبدأ بـ sk-ant-')
    await setLocalKey(key.trim())
    setKey('')
    setHasKey(true)
    setTesting(true)
    const r = await testAi()
    setTest(r)
    setTesting(false)
    resetAiStatus()
    await qc.invalidateQueries({ queryKey: ['ai-mode'] })
    if (r.ok) {
      toast.success('Claude متصل. ستُقرأ الوثائق التي صُنفت تقريبياً من جديد.')
      // everything the approximate brain classified is read again by Claude (the owner's corrections stay)
      const demo = await allIds({ ai_mode: 'demo' })
      if (demo.length) await queue.retry(demo)
      else queue.resume()
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="الإعدادات" icon={ShieldCheck} />
      <div className="space-y-5">
        <Block id="ai" icon={Bot} title="الذكاء الاصطناعي: Claude" desc="يقرأ الصفحات الممسوحة (العربية والفرنسية والإسبانية وخط اليد)، يفهم كل وثيقة ويصنفها، يقارن المتشابهات، ويفهم جمل البحث.">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone={ai === 'claude' ? 'success' : 'warning'} icon={ai === 'claude' ? CheckCircle2 : XCircle}>
              {ai === 'claude' ? 'متصل' : 'غير متصل — التصنيف تقريبي'}
            </Badge>
            {test?.model && <Badge>{modelName(test.model)}</Badge>}
            {test?.ok && test.economy && <Badge>Claude Sonnet 5.5</Badge>}
          </div>
          {MODE === 'local' ? (
            <>
              <div className="flex gap-2">
                <Input type="password" dir="ltr" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? '•••••••• (محفوظ على هذا الجهاز)' : 'sk-ant-…'} />
                <Button onClick={saveKey} loading={testing} icon={KeyRound}>
                  {hasKey ? 'تغيير' : 'حفظ واختبار'}
                </Button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                تنشئ المفتاح بنفسك في console.anthropic.com (Settings ← API Keys). يُحفظ في هذا المتصفح فقط ولا يُرسل إلا إلى Anthropic. في نسخة السحابة يُحفظ المفتاح في خادمك ولا يمر بالمتصفح.
              </p>
              {hasKey && (
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={testing}
                    onClick={async () => {
                      setTesting(true)
                      setTest(await testAi())
                      setTesting(false)
                    }}
                  >
                    اختبر الاتصال
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    onClick={async () => {
                      await setLocalKey(null)
                      setHasKey(false)
                      setTest(null)
                      await qc.invalidateQueries({ queryKey: ['ai-mode'] })
                    }}
                  >
                    احذف المفتاح
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">المفتاح محفوظ في دالة «kh-ai» على Supabase (متغير ANTHROPIC_API_KEY).</p>
          )}
          {test && !test.ok && <p className="mt-3 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">{test.error}</p>}
          {test?.ok && test.economy === false && (
            <p className="mt-3 rounded-xl bg-warning-bg px-3 py-2 text-sm text-warning">مفتاحك لا يصل إلى Claude Sonnet 5.5: يقرأ Opus 5.5 كل شيء بالسعر الكامل.</p>
          )}
        </Block>

        <Block id="reading" icon={Gauge} title="من يقرأ وثائقك" desc="Claude Opus 5.5 هو الأدق، وClaude Sonnet 5.5 بنصف ثمنه بالضبط. البحث يبقى مع Opus دائماً.">
          <div className="space-y-2">
            {[
              { v: 'auto', t: 'تلقائي (ينصح به)', d: `وثيقة أو بضع وثائق: Opus 5.5. استيراد كبير (${ECONOMY_FROM} وثائق فأكثر في الانتظار): Sonnet 5.5 بنصف الثمن حتى ينتهي.` },
              { v: 'opus', t: 'Opus 5.5 دائماً', d: 'الأدق في كل شيء، بالسعر الكامل.' },
              { v: 'sonnet', t: 'Sonnet 5.5 دائماً', d: 'نصف الثمن في كل شيء.' },
            ].map((o) => (
              <label key={o.v} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-3', reading === o.v ? 'border-brand-500 bg-brand-50' : 'border-line')}>
                <input
                  type="radio"
                  name="reading_mode"
                  className="mt-1 accent-[var(--brand-600)]"
                  checked={reading === o.v}
                  onChange={async () => {
                    await api.setSetting('reading_mode', o.v)
                    await qc.invalidateQueries({ queryKey: ['settings'] })
                  }}
                />
                <span>
                  <span className="block text-sm font-medium text-ink">{o.t}</span>
                  <span className="text-xs leading-relaxed text-muted">{o.d}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            وثيقة قرأها Sonnet ولم تعجبك قراءتها: افتحها، ثم ⋮ ← «اقرأ الصفحات من جديد بـ Opus 5.5». وكل ما يرفضه Sonnet يقرؤه Opus تلقائياً.
          </p>
          {economyIssue && <p className="mt-3 rounded-xl bg-warning-bg px-3 py-2 text-sm text-warning">توقف استعمال Sonnet 5.5 في هذه الجلسة، ويقرأ Opus كل شيء: {economyIssue}</p>}
        </Block>

        <Block icon={Wallet} title="الميزانية الشهرية" desc="لا تُنفق أي تكلفة فوق هذا السقف: تتوقف المعالجة وتنتظر إذنك.">
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="text-muted">هذا الشهر</span>
            <span className="num font-semibold text-ink">
              {fmtUsd(spent)} / {capNum ? `${capNum}$` : 'بلا سقف'}
            </span>
          </div>
          <Progress value={capNum ? spent / capNum : 0} tone={capNum && spent / capNum > (Number(usage?.alert_ratio) || 0.8) ? 'danger' : 'brand'} />
          <div className="mt-4 flex items-end gap-2">
            <Field label="السقف الشهري (دولار)" className="w-44">
              <Input type="number" min={0} step={5} dir="ltr" value={cap} onChange={(e) => setCap(e.target.value)} />
            </Field>
            <Button
              variant="secondary"
              onClick={async () => {
                await api.setSetting('monthly_cap_usd', Number(cap) || 0)
                resetBudgetCache()
                await qc.invalidateQueries()
                toast.success('حُفظ السقف')
                if (queue.getSnapshot().paused === 'budget') queue.resume()
              }}
            >
              حفظ
            </Button>
          </div>
          {usage && Object.keys(usage.by_op).length > 0 && (
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {Object.entries(usage.by_op).map(([op, c]) => (
                <div key={op} className="flex justify-between rounded-xl bg-surface-2 px-3 py-2 text-sm">
                  <span className="text-muted">{OPS[op] ?? op}</span>
                  <span className="num text-ink">{fmtUsd(Number(c))}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            <span className="num">{fmtNum(usage?.month_calls ?? 0)}</span> طلباً هذا الشهر · المجموع منذ البداية <span className="num">{fmtUsd(Number(usage?.total_cost ?? 0))}</span> · لكل مليون رمز (مدخل / مخرج): Opus 5.5 ‏4$ / 20$، وSonnet 5.5 ‏2$ / 10$.
          </p>
        </Block>

        <Block icon={FolderTree} title="الرفوف الجديدة" desc="حين لا يجد رفاً مناسباً لوثيقة، يقترح التطبيق رفاً جديداً. أنت تقرر:">
          <div className="space-y-2">
            {[
              { v: 'ask', t: 'اسألني دائماً', d: 'لا يُنشأ أي رف إلا بموافقتك (ينصح به)' },
              { v: 'ask_top', t: 'اسألني عن الرفوف الرئيسية فقط', d: 'الرفوف الفرعية تُنشأ تلقائياً' },
              { v: 'auto', t: 'أنشئها تلقائياً', d: 'تراها في المكتبة بعلامة «مقترح» ويمكنك دمجها أو حذفها' },
            ].map((o) => (
              <label key={o.v} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-3', autonomy === o.v ? 'border-brand-500 bg-brand-50' : 'border-line')}>
                <input
                  type="radio"
                  name="autonomy"
                  className="mt-1 accent-[var(--brand-600)]"
                  checked={autonomy === o.v}
                  onChange={async () => {
                    await api.setSetting('autonomy', o.v)
                    await qc.invalidateQueries({ queryKey: ['settings'] })
                  }}
                />
                <span>
                  <span className="block text-sm font-medium text-ink">{o.t}</span>
                  <span className="text-xs text-muted">{o.d}</span>
                </span>
              </label>
            ))}
          </div>
        </Block>

        <Block icon={Database} title="النسخ الاحتياطي" desc="نسخة كاملة: كل البيانات وكل الملفات في ملف ZIP واحد. احتفظ بها في مكان آخر (Google Drive أو قرص خارجي).">
          <div className="flex flex-wrap gap-2">
            <Button
              icon={DownloadCloud}
              loading={!!backup}
              onClick={async () => {
                setBackup({ done: 0, total: 1 })
                try {
                  await exportEverything((done, total) => setBackup({ done, total }))
                  toast.success('النسخة جاهزة')
                } catch (e) {
                  toast.error((e as Error).message)
                } finally {
                  setBackup(null)
                }
              }}
            >
              نسخة احتياطية كاملة
            </Button>
            <Button variant="secondary" icon={UploadCloud} onClick={() => importRef.current?.click()}>
              استرجاع من نسخة
            </Button>
            <input
              ref={importRef}
              type="file"
              accept=".zip"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                const t = toast.loading('استرجاع…')
                try {
                  const r = await importEverything(f)
                  toast.success(`استُرجع ${r.rows} سجلاً`, { id: t })
                  await qc.invalidateQueries()
                } catch (err) {
                  toast.error((err as Error).message, { id: t })
                }
              }}
            />
          </div>
          {backup && <Progress className="mt-3" value={backup.done / Math.max(1, backup.total)} />}
          <VaultBackupNote />
          <p className="mt-3 text-xs leading-relaxed text-muted">الاسترجاع لا يكرر شيئاً: ما هو موجود يبقى كما هو. ويصلح لنقل أرشيف هذا الجهاز إلى نسخة السحابة.</p>
        </Block>

        {MODE === 'local' && (
          <Block id="drive" icon={Cloud} title="Google Drive: أرشيفك على الهاتف والحاسوب" desc="أرشيفك في Google Drive الخاص بك، والفهرس على كل جهاز يتزامن عبره.">
            <DriveSettings />
          </Block>
        )}

        <Block icon={MODE === 'local' ? HardDrive : Cloud} title="مكان الحفظ" desc={MODE === 'local' ? 'نسخة الأرشيف على هذا الجهاز (في هذا المتصفح). بربط Google Drive تصل إليه من الهاتف والحاسوب معاً.' : 'أرشيفك في مشروع Supabase الخاص بك: قاعدة بيانات بصلاحيات صارمة وتخزين خاص.'}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
              <div className="text-xs text-muted">الوثائق</div>
              <div className="num font-semibold text-ink">{fmtNum(counts?.documents ?? 0)}</div>
            </div>
            <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
              <div className="text-xs text-muted">في السلة</div>
              <div className="num font-semibold text-ink">{fmtNum(counts?.trash ?? 0)}</div>
            </div>
            {storage && (
              <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                <div className="text-xs text-muted">المساحة المستعملة</div>
                <div className="num font-semibold text-ink">
                  {fmtSize(storage.used)} <span className="text-xs font-normal text-muted">من {fmtSize(storage.quota)}</span>
                </div>
              </div>
            )}
          </div>
          {MODE === 'local' && health && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {health.persisted ? (
                <Badge tone="success" icon={ShieldCheck}>
                  حفظ دائم: لن يحذف المتصفح بيانات خزانة من تلقاء نفسه
                </Badge>
              ) : (
                <>
                  <Badge tone="warning">قد يحذف المتصفح بيانات خزانة إن امتلأ القرص</Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      const ok = await ensurePersistence(true)
                      if (ok) toast.success('صار الحفظ دائماً')
                      else toast('لم يوافق المتصفح بعد. أضف خزانة إلى الشاشة الرئيسية (تثبيت التطبيق) أو إلى المفضلة، ثم أعد المحاولة. وأبقِ Google Drive مربوطاً.')
                    }}
                  >
                    اطلب الحفظ الدائم
                  </Button>
                </>
              )}
            </div>
          )}
          {MODE === 'cloud' && (
            <Button
              variant="ghost"
              icon={LogOut}
              className="mt-4"
              onClick={async () => {
                const { supabase } = await import('@/db/cloud')
                await supabase().auth.signOut()
                location.reload()
              }}
            >
              تسجيل الخروج
            </Button>
          )}
        </Block>

        {MODE === 'local' && (
          <Block id="vault" icon={ShieldCheck} title="الخزنة" desc="الوثائق الحساسة (الهوية، الجواز، بطاقة الإقامة، الطبي، البنك) تختفي من كل مكان حتى تفتحها ببصمتك أو برمز قفل الجهاز.">
            <DeviceVaultSettings />
          </Block>
        )}

        {MODE === 'cloud' && (
          <Block icon={ShieldCheck} title="الأمان والخزنة" desc="الوثائق الحساسة (الهوية، الجواز، بطاقة الإقامة، الطبي، البنك) لا تُفتح إلا بعد رمز من تطبيق مصادقة على هاتفك.">
            <MfaSettings />
          </Block>
        )}

        <Block icon={Moon} title="المظهر">
          <Button variant="secondary" onClick={toggle}>
            {dark ? 'الوضع الفاتح' : 'الوضع الداكن'}
          </Button>
        </Block>

        {MODE === 'local' && (
          <Block icon={Trash2} title="منطقة الخطر">
            <Button
              variant="danger"
              icon={Trash2}
              onClick={async () => {
                if (!confirm('سيُحذف كل الأرشيف من هذا المتصفح نهائياً. هل أخذت نسخة احتياطية؟')) return
                if (prompt('اكتب «احذف» للتأكيد') !== 'احذف') return
                await idb.clear('blobs')
                await idb.clear('kv')
                indexedDB.deleteDatabase('/pglite/khizana')
                location.reload()
              }}
            >
              احذف كل البيانات من هذا الجهاز
            </Button>
          </Block>
        )}
      </div>
    </div>
  )
}
