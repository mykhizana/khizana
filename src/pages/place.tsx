import { useQueryClient } from '@tanstack/react-query'
import { Archive, ArrowRight, Camera, Pencil, Printer, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { LOCATION_KINDS } from '@/lib/labels'
import { useLocations, useSearch } from '@/lib/queries'
import { DocRow } from '@/ui/bits'
import { Button, Card, Empty, LinkButton, Skeleton } from '@/ui/kit'
import { LocationForm } from './places'

export default function PlacePage() {
  const { id } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const loc = (useLocations().data ?? []).find((l) => l.id === id)
  const docs = useSearch({ filters: { location_id: id }, sort: 'newest', limit: 200 }, !!id)
  const [edit, setEdit] = useState(false)
  if (!loc) return <Skeleton className="h-64" />
  return (
    <div>
      <button onClick={() => nav('/places')} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowRight className="size-4" /> كل الأماكن
      </button>
      <Card className="mb-6 p-6">
        <div className="flex flex-wrap items-start gap-4">
          <div className="kh-arch grid h-20 w-16 place-items-end bg-brand-700 pb-3 text-white">
            <Archive className="mx-auto size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[28px] text-ink">{loc.name}</h1>
            <p className="text-sm text-muted">
              {LOCATION_KINDS[loc.kind]}
              {loc.place ? ` · ${loc.place}` : ''} · الرمز <span className="latin font-semibold">{loc.code}</span>
            </p>
            {loc.notes && <p className="mt-2 text-sm text-text">{loc.notes}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <LinkButton to={`/scan?location=${loc.id}`} icon={Camera}>
              جلسة مسح لهذا المكان
            </LinkButton>
            <LinkButton to={`/add?location=${loc.id}`} variant="secondary" icon={Upload}>
              رفع
            </LinkButton>
            <LinkButton to={`/labels?ids=${loc.id}`} variant="secondary" icon={Printer}>
              ملصق QR
            </LinkButton>
            <Button variant="ghost" icon={Pencil} onClick={() => setEdit(true)}>
              تعديل
            </Button>
            <Button
              variant="ghost"
              icon={Trash2}
              className="text-danger"
              onClick={async () => {
                if (!confirm('حذف هذا المكان؟ تبقى الوثائق، ويُمحى عنها هذا المكان فقط.')) return
                await api.locationDelete(loc.id)
                await qc.invalidateQueries()
                toast.success('حُذف المكان')
                nav('/places')
              }}
            />
          </div>
        </div>
      </Card>
      <h2 className="mb-3 text-lg font-semibold text-ink">
        ما يحتويه <span className="num text-sm font-normal text-muted">({docs.data?.total ?? '…'})</span>
      </h2>
      <div className="space-y-3">
        {docs.isLoading ? (
          <Skeleton className="h-28" />
        ) : docs.data?.items.length ? (
          docs.data.items.map((d) => <DocRow key={d.id} d={d} />)
        ) : (
          <Card>
            <Empty icon={Archive} title="لا وثائق مسجلة في هذا المكان بعد" />
          </Card>
        )}
      </div>
      {edit && <LocationForm value={loc} onClose={() => setEdit(false)} />}
    </div>
  )
}
