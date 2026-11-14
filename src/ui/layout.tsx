// The frame around every screen: side menu (computer), bottom bar (phone), search, add, background work.
import {
  AlarmClock,
  Archive,
  Camera,
  CircleDot,
  Cloud,
  HardDrive,
  Home,
  Inbox,
  Library,
  MessagesSquare,
  Menu as MenuIcon,
  Moon,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  Upload,
  Users,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { isSonnet } from '@/ai/models'
import { MODE } from '@/lib/config'
import { useAiMode, useCounts, useQueue } from '@/lib/queries'
import { queue } from '@/pipeline/queue'
import { Logo } from './bits'
import { DriveAutoRenew, DriveBanner, DriveChip } from './drive'
import { StorageBanner } from './storage'
import { Badge, Button, Dialog, IconButton, Progress, cn } from './kit'

const NAV = [
  { to: '/', label: 'الرئيسية', icon: Home, end: true },
  { to: '/search', label: 'البحث', icon: Search },
  { to: '/ask', label: 'اسأل خزانتك', icon: MessagesSquare },
  { to: '/deadlines', label: 'الآجال', icon: AlarmClock },
  { to: '/library', label: 'المكتبة والرفوف', icon: Library },
  { to: '/review', label: 'تحتاج قرارك', icon: Inbox, badge: true },
  { to: '/people', label: 'الأشخاص والجهات', icon: Users },
  { to: '/places', label: 'أماكن الأصول الورقية', icon: Archive },
  { to: '/settings', label: 'الإعدادات', icon: Settings },
]

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('kh:theme', next ? 'dark' : 'light')
    } catch {
      /* private mode */
    }
  }
  return { dark, toggle }
}

function QueueCard() {
  const q = useQueue()
  // without a Claude key the approximate classifier works: no model to show
  const claude = useAiMode().data === 'claude'
  if (!q.running.length && !q.pending && !q.paused && !q.failed.length && !q.foreign.length) return null
  return (
    <div className="rounded-2xl border border-line bg-surface-2 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
          <Sparkles className={cn('size-3.5 text-brass-500', q.running.length && 'animate-pulse')} />
          {q.paused ? 'المعالجة متوقفة' : q.pending || q.running.length ? `يعالج ${q.pending || q.running.length} وثيقة` : 'المعالجة'}
        </span>
        {q.paused ? (
          <IconButton icon={Play} label="استئناف" size="sm" onClick={() => queue.resume()} />
        ) : (
          <IconButton icon={Pause} label="إيقاف مؤقت" size="sm" onClick={() => queue.pause('manual', 'أوقفتَ المعالجة مؤقتاً')} />
        )}
      </div>
      {q.message && <p className="mb-2 leading-relaxed text-warning">{q.message}</p>}
      {claude && q.economy && !q.paused && <p className="mb-2 leading-relaxed text-muted">يقرؤها Sonnet 5.5 بنصف الثمن</p>}
      {q.foreign.length > 0 && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-surface px-2 py-1.5 text-muted">
          <span className="min-w-0">{q.foreign.length === 1 ? 'وثيقة أضافها جهازك الآخر: يقرؤها هو' : `${q.foreign.length} وثائق أضافها جهازك الآخر: يقرؤها هو`}</span>
          <button type="button" className="shrink-0 font-semibold text-brand-700 hover:underline dark:text-brand-200" onClick={() => void queue.readHere(q.foreign)}>
            اقرأها هنا
          </button>
        </div>
      )}
      {q.failed.length > 0 && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-danger-bg px-2 py-1.5 text-danger">
          <Link to={`/doc/${q.failed[0]}`} className="min-w-0 truncate hover:underline">
            تعذّرت معالجة {q.failed.length === 1 ? 'وثيقة' : `${q.failed.length} وثائق`}
          </Link>
          <button type="button" className="shrink-0 font-semibold hover:underline" onClick={() => void queue.retry(q.failed)}>
            أعد المحاولة
          </button>
        </div>
      )}
      <div className="space-y-2">
        {q.running.map((j) => (
          <Link key={j.id} to={`/doc/${j.id}`} className="block">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-text">{j.title}</span>
              {claude && isSonnet(j.model) && <span className="shrink-0 rounded-md bg-surface px-1.5 text-[10px] text-muted">Sonnet</span>}
            </div>
            <div className="truncate text-muted">{j.detail ?? '…'}</div>
            <Progress value={j.ratio ?? 0.15} className="mt-1" />
          </Link>
        ))}
      </div>
    </div>
  )
}

function SearchBox({ className, autoFocus }: { className?: string; autoFocus?: boolean }) {
  const nav = useNavigate()
  const loc = useLocation()
  const [q, setQ] = useState('')
  useEffect(() => {
    if (loc.pathname === '/search') setQ(new URLSearchParams(loc.search).get('q') ?? '')
  }, [loc])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    nav(`/search?q=${encodeURIComponent(q.trim())}`)
  }
  return (
    <form onSubmit={submit} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute start-3.5 top-1/2 size-[18px] -translate-y-1/2 text-subtle" />
      <input
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        placeholder="ابحث بكلمة، دكتور، مجال، سنة…"
        className="h-11 w-full rounded-2xl border border-line bg-surface ps-10 pe-4 text-sm text-ink shadow-soft outline-none placeholder:text-subtle focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15"
      />
    </form>
  )
}

function AddMenu({ onDone }: { onDone?: () => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Link to="/scan" onClick={onDone} className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface-2 p-5 text-center hover:border-brand-500">
        <span className="grid size-12 place-items-center rounded-2xl bg-brand-700 text-white">
          <Camera className="size-6" />
        </span>
        <span className="text-sm font-semibold text-ink">امسح بالكاميرا</span>
        <span className="text-xs text-muted">ورقة، رزمة أو بطاقة</span>
      </Link>
      <Link to="/add" onClick={onDone} className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface-2 p-5 text-center hover:border-brand-500">
        <span className="grid size-12 place-items-center rounded-2xl bg-brass-500 text-brand-950">
          <Upload className="size-6" />
        </span>
        <span className="text-sm font-semibold text-ink">ارفع ملفات</span>
        <span className="text-xs text-muted">PDF، صور، Word، مجلدات، ZIP</span>
      </Link>
    </div>
  )
}

export function Shell() {
  const counts = useCounts().data
  const ai = useAiMode().data
  const { dark, toggle } = useTheme()
  const loc = useLocation()
  const [addOpen, setAddOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const decisions = (counts?.reviews ?? 0) + (counts?.proposals ?? 0)
  useEffect(() => {
    setMoreOpen(false)
    setAddOpen(false)
    window.scrollTo({ top: 0 })
  }, [loc.pathname])

  return (
    <div className="kh-paper min-h-dvh">
      {/* side menu (computer) */}
      <aside className="kh-no-print fixed inset-y-0 start-0 z-30 hidden w-[264px] flex-col border-e border-line bg-surface/80 px-4 py-5 backdrop-blur lg:flex">
        <Link to="/" className="px-2">
          <Logo />
        </Link>
        <Button className="mt-6 w-full" icon={Plus} onClick={() => setAddOpen(true)}>
          أضف وثائق
        </Button>
        <nav className="mt-5 space-y-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors', isActive ? 'bg-brand-700 text-white shadow-soft' : 'text-text hover:bg-surface-2')
              }
            >
              <n.icon className="size-[18px] shrink-0" />
              <span className="flex-1">{n.label}</span>
              {n.badge && decisions > 0 ? <span className="num rounded-full bg-brass-500 px-2 text-[11px] font-semibold leading-5 text-brand-950">{decisions}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <QueueCard />
          <div className="flex items-center justify-between rounded-2xl border border-line px-3 py-2 text-[11px] text-muted">
            {MODE === 'local' ? (
              <DriveChip />
            ) : (
              <span className="inline-flex items-center gap-1.5" title="محفوظ في سحابتك الخاصة">
                <Cloud className="size-3.5" />
                في السحابة
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <CircleDot className={cn('size-3', ai === 'claude' ? 'text-success' : 'text-warning')} />
              {ai === 'claude' ? 'Claude Opus 5.5' : 'تصنيف تقريبي'}
            </span>
            <IconButton icon={dark ? Sun : Moon} label="تبديل المظهر" size="sm" onClick={toggle} />
          </div>
        </div>
      </aside>

      {/* top bar */}
      <header className="kh-no-print sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur lg:ms-[264px]">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="lg:hidden">
            <Logo compact />
          </Link>
          {loc.pathname !== '/' && loc.pathname !== '/search' ? <SearchBox className="flex-1" /> : <div className="flex-1" />}
          <IconButton icon={dark ? Sun : Moon} label="تبديل المظهر" onClick={toggle} className="lg:hidden" />
        </div>
      </header>

      <main className="pb-28 lg:ms-[264px] lg:pb-10">
        <div className="mx-auto max-w-6xl px-4 pt-5 sm:px-6 sm:pt-7">
          {MODE === 'local' && <StorageBanner />}
          {MODE === 'local' && <DriveBanner />}
          {MODE === 'local' && <DriveAutoRenew />}
          <Outlet />
        </div>
      </main>

      {/* bottom bar (phone) */}
      <nav className="kh-no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        <div className="mx-auto grid max-w-md grid-cols-5 items-end px-2">
          {[NAV[0], NAV[1]].map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cn('flex flex-col items-center gap-1 py-2.5 text-[11px]', isActive ? 'text-brand-700 dark:text-brand-200' : 'text-muted')}>
              <n.icon className="size-5" />
              {n.label}
            </NavLink>
          ))}
          <button onClick={() => setAddOpen(true)} className="-mt-5 flex flex-col items-center gap-1 pb-2 text-[11px] text-muted" aria-label="أضف وثائق">
            <span className="kh-pulse grid size-14 place-items-center rounded-2xl bg-brand-700 text-white shadow-card">
              <Plus className="size-7" />
            </span>
          </button>
          <NavLink to="/review" className={({ isActive }) => cn('relative flex flex-col items-center gap-1 py-2.5 text-[11px]', isActive ? 'text-brand-700 dark:text-brand-200' : 'text-muted')}>
            <Inbox className="size-5" />
            قراراتك
            {decisions > 0 && <span className="num absolute end-3 top-1.5 rounded-full bg-brass-500 px-1.5 text-[10px] font-bold leading-4 text-brand-950">{decisions}</span>}
          </NavLink>
          <button onClick={() => setMoreOpen(true)} className="flex flex-col items-center gap-1 py-2.5 text-[11px] text-muted">
            <MenuIcon className="size-5" />
            المزيد
          </button>
        </div>
      </nav>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="أضف إلى خزانتك">
        <AddMenu onDone={() => setAddOpen(false)} />
        <p className="mt-4 text-xs leading-relaxed text-muted">لا تحتاج إلى ترتيب أي شيء: كل وثيقة تُقرأ وتُصنف ويُفحص تكرارها تلقائياً.</p>
      </Dialog>

      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="المزيد">
        <div className="space-y-1">
          {NAV.slice(2).map((n) => (
            <NavLink key={n.to} to={n.to} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-text hover:bg-surface-2">
              <n.icon className="size-5 text-brand-600" />
              {n.label}
            </NavLink>
          ))}
        </div>
        <div className="mt-4">
          <QueueCard />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {MODE === 'local' ? (
            <Badge icon={HardDrive}>
              <DriveChip />
            </Badge>
          ) : (
            <Badge icon={Cloud}>في السحابة</Badge>
          )}
          <Badge tone={ai === 'claude' ? 'success' : 'warning'}>{ai === 'claude' ? 'Claude Opus 5.5' : 'تصنيف تقريبي'}</Badge>
        </div>
      </Dialog>
    </div>
  )
}

export { SearchBox, AddMenu }
