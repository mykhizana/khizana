// Warns while the archive's storage is at risk (a nearly full disk: browsers then delete site data).
import { HardDrive } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fmtSize } from '@/lib/format'
import { storageHealth, type StorageHealth } from '@/lib/storage'
import { useDrive } from './drive'
import { Card, cn } from './kit'

export function useStorageHealth(): StorageHealth | null {
  const [h, setH] = useState<StorageHealth | null>(null)
  useEffect(() => {
    let alive = true
    const check = () => void storageHealth().then((x) => alive && setH(x))
    check()
    const t = setInterval(check, 5 * 60_000)
    document.addEventListener('visibilitychange', check)
    return () => {
      alive = false
      clearInterval(t)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  return h
}

export function StorageBanner() {
  const h = useStorageHealth()
  const d = useDrive()
  if (!h || h.risk === 'ok') return null
  const critical = h.risk === 'critical'
  const left = Math.max(0, h.quota - h.used)
  return (
    <Card className={cn('mb-5 flex flex-wrap items-center gap-3 p-4', critical ? 'border-danger/30 bg-danger-bg' : 'border-warning/30 bg-warning-bg')}>
      <HardDrive className={cn('size-5 shrink-0', critical ? 'text-danger' : 'text-warning')} />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        <div className={cn('font-semibold', critical ? 'text-danger' : 'text-warning')}>{critical ? 'قرص حاسوبك ممتلئ تقريباً' : 'المساحة الفارغة في قرص حاسوبك قليلة'}</div>
        <div className="text-text">
          لم يبقَ للمتصفح إلا نحو <span className="num">{fmtSize(left)}</span>.{' '}
          {critical ? 'قد يحذف المتصفح خزانة كلها عند تحديث الصفحة: حرّر مساحة في القرص الآن، ولا تضف وثائق قبل ذلك.' : 'إن امتلأ القرص قد يحذف المتصفح بيانات خزانة: حرّر بعض المساحة.'}{' '}
          {d.linked ? 'نسختك في Google Drive سليمة.' : 'واربط Google Drive لتبقى نسخة من أرشيفك خارج هذا الجهاز.'}
        </div>
      </div>
    </Card>
  )
}
