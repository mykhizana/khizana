import { Building2, MapPin, Search, User, Users } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { roleLabel } from '@/lib/labels'
import { useEntities } from '@/lib/queries'
import { PageHeader } from '@/ui/bits'
import { Badge, Card, Empty, Input, Segmented, Skeleton } from '@/ui/kit'

const ROLE_FILTERS = [
  { key: '', label: 'الكل' },
  { key: 'professor', label: 'أساتذة' },
  { key: 'physician', label: 'أطباء' },
  { key: 'author', label: 'مؤلفون' },
  { key: 'supervisor', label: 'مشرفون' },
]

export default function PeoplePage() {
  const [kind, setKind] = useState<'person' | 'org' | 'place'>('person')
  const [q, setQ] = useState('')
  const [role, setRole] = useState('')
  const { data, isLoading } = useEntities(kind, q)
  const list = (data ?? []).filter((e) => !role || e.roles?.includes(role))
  const Icon = kind === 'person' ? User : kind === 'org' ? Building2 : MapPin

  return (
    <div>
      <PageHeader title="الأشخاص والجهات" icon={Users} subtitle="كل دكتور وأستاذ وجهة وردت في وثائقك، بأسمائه المختلفة موحّدة." />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'person', label: 'الأشخاص', icon: User },
            { value: 'org', label: 'الجهات', icon: Building2 },
            { value: 'place', label: 'الأماكن', icon: MapPin },
          ]}
        />
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث بالاسم، بالعربية أو اللاتينية" className="ps-9" />
        </div>
      </div>
      {kind === 'person' && (
        <div className="mb-4 flex flex-wrap gap-2">
          {ROLE_FILTERS.map((r) => (
            <button key={r.key} onClick={() => setRole(r.key)} className={`rounded-full border px-3 py-1 text-[13px] ${role === r.key ? 'border-brand-600 bg-brand-700 text-white' : 'border-line bg-surface hover:border-brand-500'}`}>
              {r.label}
            </button>
          ))}
        </div>
      )}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card>
          <Empty icon={Icon} title="لا أحد بعد">
            تظهر هنا تلقائياً الأسماء التي يقرؤها التطبيق في وثائقك: الأساتذة والمؤلفون والأطباء والجهات.
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((e) => (
            <Link key={e.id} to={`/people/${e.id}`} className="group rounded-2xl border border-line bg-surface p-4 shadow-soft transition hover:border-brand-200 hover:shadow-card">
              <div className="flex items-start gap-3">
                <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-brand-50 text-lg font-semibold text-brand-700">{e.name.replace(/^(ال)/, '').slice(0, 1)}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-ink group-hover:text-brand-700">
                    {e.honorific ? `${e.honorific} ` : ''}
                    {e.name}
                  </div>
                  {e.name_latin && (
                    <div className="latin truncate text-xs text-muted" dir="ltr">
                      {e.name_latin}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge tone="brand">{e.doc_count} وثيقة</Badge>
                    {e.years?.from ? <Badge>{e.years.from === e.years.to ? e.years.from : `${e.years.from}–${e.years.to}`}</Badge> : null}
                    {(e.roles ?? [])
                      .filter((r) => !['mentioned', 'organization'].includes(r))
                      .slice(0, 2)
                      .map((r) => (
                        <Badge key={r}>{roleLabel(r)}</Badge>
                      ))}
                    {!e.confirmed && kind === 'person' && <Badge tone="brass">جديد</Badge>}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
