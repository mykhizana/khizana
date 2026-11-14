// «الملفات الجاهزة» — the papers one procedure asks for, gathered once: an ordered PDF to print or
// send, a share link that can be taken back, and Claude's checklist of what is still missing.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FilePlus2, FolderCheck, Link2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/db/api'
import { docsAr, relTime, uuid } from '@/lib/format'
import { PageHeader } from '@/ui/bits'
import { Badge, Button, Card, Chip, Field, Input, Skeleton } from '@/ui/kit'
import { ShareLinks, useOpenLinks } from '@/ui/share'

/** procedures the owner is likely to meet between Morocco and Spain */
export const PROCEDURES = [
  'تجديد بطاقة الإقامة (TIE)',
  'تجديد جواز السفر المغربي',
  'طلب الجنسية الإسبانية',
  'التسجيل في البلدية (Empadronamiento)',
  'معادلة شهادة جامعية (Homologación)',
  'التسجيل في الجامعة أو الدكتوراه',
  'إيداع أطروحة الدكتوراه ومناقشتها',
  'كراء شقة',
  'فتح حساب بنكي',
  'طلب منحة',
]

export default function DossiersPage() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const list = useQuery({ queryKey: ['dossiers'], queryFn: () => api.dossiers() })
  const links = useOpenLinks()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async (e?: FormEvent, n = name) => {
    e?.preventDefault()
    if (!n.trim()) return toast.error('سمِّ الملف باسم الإجراء')
    setBusy(true)
    try {
      const id = uuid()
      await api.dossierSave({ new_id: id, name: n.trim() })
      await qc.invalidateQueries({ queryKey: ['dossiers'] })
      nav(`/dossiers/${id}`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const items = list.data ?? []
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="الملفات الجاهزة"
        icon={FolderCheck}
        subtitle="اجمع الوثائق التي يطلبها إجراء ما في ملف واحد مرتّب: PDF واحد بفهرس للطباعة أو الإرسال، ورابط مشاركة تسحبه متى شئت، ويقول لك Claude ما الذي ينقصك."
      />

      <Card className="p-5">
        <h2 className="font-semibold text-ink">ملف جديد</h2>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={create}>
          <Field label="الإجراء" className="min-w-[14rem] flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: تجديد بطاقة الإقامة 2027" dir="auto" />
          </Field>
          <Button type="submit" icon={FilePlus2} loading={busy}>
            أنشئ
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {PROCEDURES.map((p) => (
            <Chip key={p} onClick={() => void create(undefined, p)}>
              {p}
            </Chip>
          ))}
        </div>
      </Card>

      {list.isLoading ? (
        <Skeleton className="h-32" />
      ) : items.length === 0 ? (
        <Card className="p-6 text-center text-sm leading-relaxed text-muted">
          لا ملف بعد. اختر إجراءً أعلاه: تجمع فيه وثائقه بالترتيب، ويفحص Claude أرشيفك ليقول لك ما الموجود وما انتهت صلاحيته وما ينقص.
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((d) => (
            <li key={d.id}>
              <Link to={`/dossiers/${d.id}`} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 transition hover:border-line-2 hover:shadow-soft">
                <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                  <FolderCheck className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink">{d.name}</div>
                  <div className="text-xs text-muted">
                    {d.documents ? docsAr(d.documents) : 'فارغ'} · أُنشئ {relTime(d.created_at)}
                  </div>
                </div>
                {d.missing > 0 && (
                  <Badge tone="warning" icon={AlertTriangle}>
                    ينقص {d.missing}
                  </Badge>
                )}
                {d.shared > 0 && (
                  <Badge tone="success" icon={Link2}>
                    رابط مفتوح
                  </Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!!links.data?.length && (
        <Card className="p-5">
          <h2 className="mb-1 font-semibold text-ink">الروابط المفتوحة الآن</h2>
          <p className="mb-3 text-xs text-muted">كل ما شاركته من ملفات ووثائق ولم ينتهِ بعد.</p>
          <ShareLinks links={links.data} onChange={() => qc.invalidateQueries({ queryKey: ['shares'] })} showName />
        </Card>
      )}
    </div>
  )
}
