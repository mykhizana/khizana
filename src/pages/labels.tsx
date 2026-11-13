// Printable QR labels for the boxes and folders that keep the paper originals.
import { ArrowRight, Printer } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api } from '@/db/api'
import { BASE } from '@/lib/config'
import type { Location } from '@/lib/types'
import { LogoMark } from '@/ui/bits'
import { Button } from '@/ui/kit'

export default function LabelsPage() {
  const [sp] = useSearchParams()
  const ids = (sp.get('ids') ?? '').split(',').filter(Boolean)
  const [labels, setLabels] = useState<(Location & { qr: string })[]>([])
  useEffect(() => {
    void (async () => {
      const all = await api.locations()
      const chosen = all.filter((l) => ids.includes(l.id))
      const out = []
      for (const l of chosen) {
        const url = `${location.origin}${BASE}l/${l.code}`
        out.push({ ...l, qr: await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#0c2e2b', light: '#ffffff' } }) })
      }
      setLabels(out)
    })()
  }, [sp])
  return (
    <div className="min-h-dvh bg-white p-6 text-[#0e1f1c]">
      <div className="kh-no-print mx-auto mb-6 flex max-w-4xl items-center justify-between">
        <Link to="/places" className="inline-flex items-center gap-1.5 text-sm text-[#5b6965]">
          <ArrowRight className="size-4" /> رجوع
        </Link>
        <Button icon={Printer} onClick={() => window.print()}>
          اطبع
        </Button>
      </div>
      <div className="mx-auto grid max-w-4xl grid-cols-2 gap-5 print:gap-3">
        {labels.map((l) => (
          <div key={l.id} className="flex items-center gap-4 rounded-2xl border-2 border-dashed border-[#d6cbb3] p-4 break-inside-avoid">
            <img src={l.qr} alt="" className="size-32 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-[#5b6965]">
                <LogoMark className="size-5" /> خزانة
              </div>
              <div className="font-display mt-1 text-2xl leading-tight">{l.name}</div>
              {l.place && <div className="mt-0.5 text-sm text-[#5b6965]">{l.place}</div>}
              <div className="latin mt-2 text-3xl font-bold tracking-[0.2em]">{l.code}</div>
            </div>
          </div>
        ))}
      </div>
      {!labels.length && <p className="text-center text-sm text-[#5b6965]">اختر مكاناً واحداً على الأقل من صفحة الأماكن.</p>}
    </div>
  )
}
