import { AlarmClock, Archive, ArrowLeft, Camera, CopyCheck, FileStack, FolderTree, Inbox, KeyRound, Search, Sparkles, Upload, Users } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '@/db/api'
import { daysUntil, fmtDate, fmtNum } from '@/lib/format'
import { categoryIcon } from '@/lib/labels'
import { useAiMode, useCategories, useCounts, useOverview, useQueue } from '@/lib/queries'
import { DocTile } from '@/ui/bits'
import { Badge, Card, Empty, LinkButton, Section, Skeleton, Stat, cn } from '@/ui/kit'
import { VaultUnlock } from '@/ui/mfa'

const EXAMPLES = ['محاضرات القانون الإداري', 'جواز السفر', 'الدكتور بنعلي 2018', 'Sanitas', 'شهادة الماستر']

export default function Home() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const ov = useOverview().data
  const counts = useCounts().data
  const cats = useCategories().data
  const ai = useAiMode().data
  const queue = useQueue()
  const qc = useQueryClient()
  const vault = useQuery({ queryKey: ['vault'], queryFn: api.vaultCount }).data?.count
  const decisions = (counts?.reviews ?? 0) + (counts?.proposals ?? 0)
  const roots = (cats ?? []).filter((c) => !c.parent_id)
  const totals = new Map<string, number>()
  if (cats) {
    const parent = new Map(cats.map((c) => [c.id, c.parent_id]))
    for (const c of cats) {
      let cur: string | null = c.id
      let guard = 0
      while (cur && guard++ < 12) {
        totals.set(cur, (totals.get(cur) ?? 0) + c.doc_count)
        cur = parent.get(cur) ?? null
      }
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    nav(`/search?q=${encodeURIComponent(q.trim())}`)
  }

  return (
    <div className="space-y-8">
      {/* hero */}
      <div className="kh-hero relative overflow-hidden rounded-[28px] px-5 py-8 text-white shadow-card sm:px-10 sm:py-11">
        <div className="pointer-events-none absolute -end-16 -top-24 size-80 rounded-full border-[28px] border-white/5" />
        <div className="pointer-events-none absolute end-24 top-10 hidden h-44 w-32 rounded-t-full border-4 border-brass-400/25 sm:block" />
        <p className="text-sm text-brass-200/90">خزانتك الشخصية</p>
        <h1 className="font-display mt-1 text-[34px] leading-tight sm:text-[42px]">ماذا تبحث عنه اليوم؟</h1>
        <form onSubmit={submit} className="relative mt-6 max-w-2xl">
          <Search className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2 text-brand-700" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="كلمة، دكتور، تخصص، مكان، سنة… أو اكتب جملة كما تتذكرها"
            className="h-14 w-full rounded-2xl border-0 bg-white ps-12 pe-28 text-[15px] text-[#0e1f1c] shadow-pop outline-none placeholder:text-[#8f9c97] focus:ring-4 focus:ring-brass-400/40"
          />
          <button type="submit" className="absolute end-2 top-2 h-10 rounded-xl bg-brass-500 px-5 text-sm font-semibold text-brand-950 hover:bg-brass-400">
            ابحث
          </button>
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((x) => (
            <button key={x} onClick={() => nav(`/search?q=${encodeURIComponent(x)}`)} className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[13px] text-white/90 hover:bg-white/20">
              {x}
            </button>
          ))}
        </div>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link to="/scan" className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-brand-800 hover:bg-brass-100">
            <Camera className="size-4" /> امسح ورقة
          </Link>
          <Link to="/add" className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/20">
            <Upload className="size-4" /> ارفع ملفات أو مجلداً
          </Link>
        </div>
      </div>

      <VaultUnlock count={vault ?? 0} onOpen={() => qc.invalidateQueries()} />

      {ai === 'demo' && (
        <Card className="flex flex-wrap items-center gap-4 border-warning/30 bg-warning-bg p-4">
          <KeyRound className="size-6 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-semibold text-ink">Claude غير مربوط بعد — التصنيف الآن تقريبي</div>
            <div className="mt-0.5 text-muted">أضف مفتاح Claude لتُقرأ الوثائق الممسوحة وتُفهم وتُصنف بدقة، وتُقارن المتشابهات.</div>
          </div>
          <LinkButton to="/settings#ai" variant="secondary" size="sm">
            إضافة المفتاح
          </LinkButton>
        </Card>
      )}

      {/* numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {ov ? (
          <>
            <Stat icon={FileStack} label="وثيقة" value={fmtNum(ov.documents)} />
            <Stat icon={Archive} label="صفحة" value={fmtNum(ov.pages)} />
            <Stat icon={Users} label="شخص" value={fmtNum(ov.people)} />
            <Stat icon={FolderTree} label="رف" value={fmtNum(ov.categories)} />
            <Stat icon={CopyCheck} label="تكرار مُنع" value={fmtNum(ov.duplicates_avoided)} />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[68px]" />)
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* decisions + radar */}
        <div className="space-y-6 lg:col-span-1">
          <Card className={cn('p-5', decisions > 0 && 'border-brass-400/50')}>
            <div className="flex items-start gap-3">
              <div className="grid size-11 place-items-center rounded-2xl bg-brass-100 text-brass-600">
                <Inbox className="size-5" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-ink">تحتاج قرارك</h3>
                <p className="mt-0.5 text-sm text-muted">
                  {decisions > 0 ? (
                    <>
                      {counts?.proposals ? <span className="num">{counts.proposals}</span> : 0} رف مقترح · <span className="num">{counts?.reviews ?? 0}</span> سؤال
                    </>
                  ) : (
                    'لا شيء ينتظرك. كل شيء مرتب.'
                  )}
                </p>
              </div>
            </div>
            {decisions > 0 && (
              <LinkButton to="/review" variant="brass" size="sm" className="mt-4 w-full">
                راجع الآن
              </LinkButton>
            )}
          </Card>

          {(queue.running.length > 0 || queue.pending > 0) && (
            <Card className="p-5">
              <h3 className="flex items-center gap-2 font-semibold text-ink">
                <Sparkles className="size-4 animate-pulse text-brass-500" /> يعمل في الخلفية
              </h3>
              <p className="mt-1 text-sm text-muted">
                <span className="num">{queue.pending}</span> وثيقة تُقرأ وتُصنف الآن. يمكنك متابعة عملك.
              </p>
            </Card>
          )}

          <Card className="p-5">
            <h3 className="flex items-center gap-2 font-semibold text-ink">
              <AlarmClock className="size-4 text-brand-600" /> رادار الآجال
            </h3>
            {ov?.deadlines.length ? (
              <ul className="mt-3 space-y-2.5">
                {ov.deadlines.slice(0, 6).map((d) => {
                  const n = daysUntil(d.due_date)
                  return (
                    <li key={d.id}>
                      <Link to={`/doc/${d.document_id}`} className="flex items-center justify-between gap-3 text-sm hover:text-brand-700">
                        <span className="min-w-0 truncate">{d.title}</span>
                        <Badge tone={n < 0 ? 'danger' : n <= 30 ? 'warning' : 'neutral'}>{n < 0 ? 'انتهت' : n === 0 ? 'اليوم' : `بعد ${n} يوم`}</Badge>
                      </Link>
                      <div className="num text-xs text-subtle">{fmtDate(d.due_date)}</div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">تواريخ انتهاء الجواز وبطاقة الإقامة والتأمين والعقود تظهر هنا تلقائياً.</p>
            )}
          </Card>
        </div>

        {/* shelves */}
        <Section
          title="الرفوف"
          className="lg:col-span-2"
          action={
            <Link to="/library" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline">
              كل المكتبة <ArrowLeft className="size-4" />
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {roots.map((c) => {
              const Icon = categoryIcon(c.icon)
              return (
                <Link key={c.id} to={`/library?cat=${c.id}`} className="group rounded-2xl border border-line bg-surface p-4 shadow-soft transition hover:border-brand-200 hover:shadow-card">
                  <div className="flex items-center justify-between">
                    <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600 group-hover:bg-brand-700 group-hover:text-white">
                      <Icon className="size-5" />
                    </span>
                    <span className="num text-lg font-semibold text-ink">{totals.get(c.id) ?? 0}</span>
                  </div>
                  <div className="mt-3 text-sm font-medium leading-snug text-ink">{c.name_ar}</div>
                </Link>
              )
            })}
          </div>
        </Section>
      </div>

      <Section title="أضيفت مؤخراً">
        {ov && ov.recent.length === 0 ? (
          <Card>
            <Empty
              icon={Archive}
              title="خزانتك فارغة"
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <LinkButton to="/scan" icon={Camera}>
                    امسح ورقة
                  </LinkButton>
                  <LinkButton to="/add" variant="secondary" icon={Upload}>
                    ارفع ملفات
                  </LinkButton>
                </div>
              }
            >
              ابدأ بمسح بعض الأوراق أو رفع ملفات من حاسوبك. لا ترتّب شيئاً: خزانة تقرأ كل وثيقة وتضعها في رفها وتمنع تكرارها.
            </Empty>
          </Card>
        ) : (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
            {(ov?.recent ?? []).map((d) => (
              <DocTile key={d.id} d={d} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
