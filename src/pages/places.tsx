import { useQueryClient } from '@tanstack/react-query'
import { Archive, Camera, MapPin, Pencil, Plus, Printer, QrCode } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { LOCATION_KINDS } from '@/lib/labels'
import { useLocations } from '@/lib/queries'
import type { Location } from '@/lib/types'
import { PageHeader } from '@/ui/bits'
import { Badge, Button, Card, Dialog, Empty, Field, IconButton, Input, LinkButton, Select, Skeleton, Textarea } from '@/ui/kit'

export function LocationForm({ value, onClose }: { value: Partial<Location> | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState<Partial<Location>>(value ?? {})
  if (!value) return null
  return (
    <Dialog
      open
      onClose={onClose}
      title={f.id ? 'تعديل المكان' : 'مكان جديد للأوراق الأصلية'}
      footer={
        <Button
          onClick={async () => {
            if (!f.name?.trim()) return
            await api.locationSave({ ...f, name: f.name.trim() })
            await qc.invalidateQueries()
            toast.success('حُفظ')
            onClose()
          }}
        >
          حفظ
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="الاسم">
          <Input autoFocus value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="صندوق 3" />
        </Field>
        <Field label="النوع">
          <Select value={f.kind ?? 'box'} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(LOCATION_KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="أين يوجد؟" className="sm:col-span-2">
          <Input value={f.place ?? ''} onChange={(e) => setF({ ...f, place: e.target.value })} placeholder="بيت العائلة — تطوان، الغرفة العلوية" />
        </Field>
        <Field label="ملاحظات" className="sm:col-span-2" hint="من يستطيع إحضاره؟ ماذا يحتوي تقريباً؟">
          <Textarea rows={2} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  )
}

export default function PlacesPage() {
  const { data, isLoading } = useLocations()
  const [form, setForm] = useState<Partial<Location> | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const list = data ?? []

  return (
    <div>
      <PageHeader
        title="أماكن الأصول الورقية"
        icon={Archive}
        subtitle="كل وثيقة رقمية تعرف أين ورقتها الأصلية: صندوق في بيت العائلة، ملف معك في إسبانيا، عند محامٍ…"
        actions={
          <>
            {sel.size > 0 && (
              <LinkButton to={`/labels?ids=${[...sel].join(',')}`} variant="secondary" icon={Printer}>
                اطبع {sel.size} ملصق
              </LinkButton>
            )}
            <Button icon={Plus} onClick={() => setForm({ name: `صندوق ${list.length + 1}`, kind: 'box' })}>
              مكان جديد
            </Button>
          </>
        }
      />
      <Card className="mb-6 flex flex-wrap items-center gap-4 border-brand-200/60 bg-brand-50/60 p-4 text-sm">
        <QrCode className="size-8 text-brand-600" />
        <p className="min-w-0 flex-1 leading-relaxed text-text">
          اطبع ملصق QR لكل صندوق والصقه عليه، ثم افتح «جلسة مسح» لذلك الصندوق: كل ورقة تمسحها تُسجَّل تلقائياً بمكانها. مسح الملصق لاحقاً بالهاتف يعرض محتوى الصندوق.
        </p>
      </Card>
      {isLoading ? (
        <Skeleton className="h-48" />
      ) : list.length === 0 ? (
        <Card>
          <Empty icon={MapPin} title="لا أماكن بعد" action={<Button icon={Plus} onClick={() => setForm({ name: 'صندوق 1', kind: 'box' })}>أضف أول صندوق</Button>}>
            قبل السفر: ضع أوراقك في صناديق مرقمة، أضفها هنا، واطبع ملصقاتها.
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((l) => (
            <Card key={l.id} className="p-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--brand-600)]"
                  checked={sel.has(l.id)}
                  onChange={(e) =>
                    setSel((s) => {
                      const n = new Set(s)
                      if (e.target.checked) n.add(l.id)
                      else n.delete(l.id)
                      return n
                    })
                  }
                  aria-label="تحديد للطباعة"
                />
                <Link to={`/places/${l.id}`} className="min-w-0 flex-1">
                  <div className="font-semibold text-ink hover:text-brand-700">{l.name}</div>
                  <div className="truncate text-xs text-muted">{l.place || LOCATION_KINDS[l.kind]}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="brand">{l.doc_count ?? 0} وثيقة</Badge>
                    <Badge>
                      <span className="latin">{l.code}</span>
                    </Badge>
                  </div>
                </Link>
                <IconButton icon={Pencil} label="تعديل" size="sm" onClick={() => setForm(l)} />
              </div>
              <div className="mt-3 flex gap-2">
                <LinkButton to={`/scan?location=${l.id}`} size="sm" variant="secondary" icon={Camera} className="flex-1">
                  جلسة مسح
                </LinkButton>
                <LinkButton to={`/labels?ids=${l.id}`} size="sm" variant="ghost" icon={Printer}>
                  ملصق
                </LinkButton>
              </div>
            </Card>
          ))}
        </div>
      )}
      {form && <LocationForm key={form.id ?? 'new'} value={form} onClose={() => setForm(null)} />}
    </div>
  )
}
