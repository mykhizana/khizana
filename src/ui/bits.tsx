// Small shared pieces: logo, thumbnails, highlighted text, document rows and cards, category path.
import { ChevronLeft, FileWarning, Heart, Lock, MapPin, Sparkles } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router'
import { files } from '@/db/files'
import { driveSync } from '@/drive/sync'
import { fmtDate, docTitle } from '@/lib/format'
import { highlight } from '@/lib/norm'
import { STATE_LABEL, roleLabel, typeIcon, typeLabel } from '@/lib/labels'
import type { PathItem, SearchItem } from '@/lib/types'
import { Badge, cn } from './kit'

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="15" fill="var(--brand-800)" />
      <path d="M18 52V30c0-9 6.3-16 14-16s14 7 14 16v22" fill="none" stroke="var(--brass-400)" strokeWidth="4" strokeLinecap="round" />
      <path d="M14 52h36" stroke="var(--brass-400)" strokeWidth="4" strokeLinecap="round" />
      <rect x="24" y="31" width="16" height="4" rx="2" fill="#f7efdc" />
      <rect x="24" y="38" width="16" height="4" rx="2" fill="#f7efdc" opacity=".85" />
      <rect x="24" y="45" width="16" height="4" rx="2" fill="#f7efdc" opacity=".7" />
    </svg>
  )
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark className="size-9 shrink-0" />
      {!compact && (
        <span className="leading-none">
          <span className="font-display block text-[22px] text-ink">خزانة</span>
          <span className="mt-0.5 block text-[11px] text-muted">أرشيفك الذي يفهم</span>
        </span>
      )}
    </span>
  )
}

export function useFileUrl(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null)
  // a file kept only in Drive (added on the other device) shows once this device can reach it
  const drive = useSyncExternalStore(driveSync.subscribe, () => driveSync.getSnapshot().state)
  const waiting = url === null ? drive : 'shown'
  useEffect(() => {
    let alive = true
    if (path) void files.url(path).then((u) => alive && setUrl(u))
    else setUrl(null)
    return () => {
      alive = false
    }
  }, [path, waiting])
  useEffect(() => setUrl(null), [path])
  return url
}

export function Thumb({ path, type, className, alt = '' }: { path: string | null | undefined; type?: string | null; className?: string; alt?: string }) {
  const url = useFileUrl(path)
  const Icon = typeIcon(type)
  return (
    <div className={cn('relative grid shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-surface-2', className)}>
      {url ? <img src={url} alt={alt} loading="lazy" className="size-full object-cover object-top" /> : <Icon className="size-1/3 text-subtle" />}
    </div>
  )
}

export function Hl({ text, tokens, className }: { text: string | null | undefined; tokens: string[]; className?: string }) {
  if (!text) return null
  return (
    <span className={className}>
      {highlight(text, tokens).map((s, i) => (s.hit ? <mark key={i} className="kh-hit">{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </span>
  )
}

export function CatPath({ path, className, link = true }: { path: PathItem[] | null | undefined; className?: string; link?: boolean }) {
  if (!path?.length) return <span className={cn('text-subtle', className)}>غير مصنفة</span>
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5', className)}>
      {path.map((p, i) => (
        <span key={p.id} className="inline-flex items-center gap-1">
          {i > 0 && <ChevronLeft className="size-3 text-subtle" />}
          {link ? (
            <Link to={`/library?cat=${p.id}`} className="hover:text-brand-600 hover:underline" onClick={(e) => e.stopPropagation()}>
              {p.name}
            </Link>
          ) : (
            p.name
          )}
        </span>
      ))}
    </span>
  )
}

/** why a document waits or failed, in words (the queue stores a short code or the error message) */
export function stateReason(state: string, detail?: string | null): string | null {
  if (!detail || (state !== 'error' && state !== 'waiting')) return null
  const words: Record<string, string> = {
    budget: 'بلغت تكلفة هذا الشهر السقف الذي حددته في الإعدادات',
    credit: 'نفد رصيد Claude API في حسابك',
    network: 'لا اتصال بالإنترنت',
    rate: 'ضغط مؤقت على خدمة Claude، تُعاد المحاولة وحدها',
    files: 'صور صفحاتها ما تزال على جهازك الآخر، وتُقرأ حين تصل إلى Drive',
    auth: 'مفتاح Claude غير صالح أو غير مضاف',
  }
  return words[detail] ?? detail
}

export function StateBadge({ state, detail }: { state: string; detail?: string | null }) {
  if (state === 'ready') return null
  const tone = state === 'error' ? 'danger' : state === 'waiting' ? 'warning' : state === 'review' ? 'brass' : 'info'
  return (
    <Badge tone={tone} icon={state === 'error' ? FileWarning : Sparkles} className={cn(['new', 'reading', 'understanding', 'checking'].includes(state) && 'animate-pulse')}>
      <span title={detail ?? undefined}>{STATE_LABEL[state] ?? state}</span>
    </Badge>
  )
}

export function DocRow({ d, tokens = [], query, selected, onSelect, extra }: { d: SearchItem; tokens?: string[]; query?: string; selected?: boolean; onSelect?: (v: boolean) => void; extra?: ReactNode }) {
  const title = docTitle(d)
  const hl = query?.trim() || tokens.join(' ')
  const to = `/doc/${d.id}${d.best_page ? `?page=${d.best_page}` : ''}${hl ? `${d.best_page ? '&' : '?'}hl=${encodeURIComponent(hl)}` : ''}`
  return (
    <div className={cn('group relative flex gap-3.5 rounded-2xl border bg-surface p-3 shadow-soft transition hover:border-brand-200 hover:shadow-card sm:p-3.5', selected ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-line')}>
      {onSelect ? (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={(e) => onSelect(e.target.checked)}
          className="absolute start-2 top-2 z-10 size-4 accent-[var(--brand-600)]"
          aria-label="تحديد"
        />
      ) : null}
      <Link to={to} className="shrink-0">
        <Thumb path={d.thumb} type={d.doc_type} className="h-[88px] w-[68px] sm:h-[104px] sm:w-[80px]" />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <Link to={to} className="min-w-0">
            <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug text-ink group-hover:text-brand-700 dark:group-hover:text-brand-200">
              <Hl text={title} tokens={tokens} />
            </h3>
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            {d.sensitivity === 'vault' && <Lock className="size-3.5 text-brass-600" aria-label="في الخزنة" />}
            {d.favorite && <Heart className="size-3.5 fill-brass-500 text-brass-500" aria-label="مفضلة" />}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            {(() => {
              const I = typeIcon(d.doc_type)
              return <I className="size-3.5" />
            })()}
            {typeLabel(d.doc_type)}
          </span>
          {(d.doc_date || d.academic_year) && <span className="num">· {d.academic_year || fmtDate(d.doc_date, d.date_precision)}</span>}
          {d.page_count > 0 && <span>· {d.page_count} ص</span>}
          <span className="hidden sm:inline">·</span>
          <CatPath path={d.category_path} className="hidden sm:inline-flex" />
        </div>
        {d.people?.length > 0 && (
          <div className="mt-1 truncate text-xs text-muted">
            {d.people.map((p) => `${p.name}${p.role && p.role !== 'mentioned' ? ` (${roleLabel(p.role)})` : ''}`).join('، ')}
          </div>
        )}
        {d.snippet && tokens.length > 0 ? (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-text/85">
            {d.best_page ? <span className="num me-1 rounded bg-surface-2 px-1 text-[11px] text-muted">ص {d.best_page}</span> : null}
            <Hl text={d.snippet.replace(/\s+/g, ' ')} tokens={tokens} />
          </p>
        ) : d.summary_ar ? (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-text/80">{d.summary_ar}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StateBadge state={d.state} detail={d.state_detail} />
          {d.state === 'error' && stateReason(d.state, d.state_detail) && (
            <span dir="auto" className="min-w-0 max-w-full truncate text-xs text-danger">
              {stateReason(d.state, d.state_detail)}
            </span>
          )}
          {d.proposal_name && <Badge tone="brass">رف مقترح: {d.proposal_name}</Badge>}
          {d.location && (
            <Badge icon={MapPin} tone="neutral">
              {d.location}
            </Badge>
          )}
          {extra}
        </div>
      </div>
    </div>
  )
}

export function DocTile({ d }: { d: { id: string; title: string; doc_type: string | null; thumb: string | null; state?: string; category_path?: PathItem[] } }) {
  return (
    <Link to={`/doc/${d.id}`} className="group block">
      <Thumb path={d.thumb} type={d.doc_type} className="aspect-[3/4] w-full transition group-hover:shadow-card" />
      <div className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug text-ink group-hover:text-brand-700">{d.title}</div>
      <div className="mt-0.5 truncate text-[11px] text-muted">{typeLabel(d.doc_type)}</div>
      {d.state && d.state !== 'ready' ? (
        <div className="mt-1">
          <StateBadge state={d.state} />
        </div>
      ) : null}
    </Link>
  )
}

export function PageHeader({ title, subtitle, actions, icon: Icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {Icon ? (
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-600">
            <Icon className="size-5" />
          </div>
        ) : null}
        <div className="min-w-0">
          <h1 className="font-display text-[26px] leading-tight text-ink">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
