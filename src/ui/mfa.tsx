// Cloud mode: the second factor (an authenticator app). The vault (IDs, passports, medical files)
// opens only in a session verified with it.
import { KeyRound, Lock, ShieldCheck, ShieldOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { MODE } from '@/lib/config'
import { Badge, Button, Card, Input } from './kit'
import { DeviceVaultUnlock, useVault } from './vault'

async function sb() {
  const { supabase } = await import('@/db/cloud')
  return supabase()
}

export function useAal() {
  const [aal, setAal] = useState<{ current: string; next: string } | null>(null)
  const refresh = async () => {
    if (MODE !== 'cloud') return setAal({ current: 'aal2', next: 'aal2' })
    const { data } = await (await sb()).auth.mfa.getAuthenticatorAssuranceLevel()
    setAal(data ? { current: data.currentLevel ?? 'aal1', next: data.nextLevel ?? 'aal1' } : null)
  }
  useEffect(() => {
    void refresh()
  }, [])
  return { aal, refresh }
}

/** opens the vault in this session (asks the 6-digit code) */
export function VaultUnlock({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (MODE === 'local') return <DeviceVaultUnlock count={count} onOpen={onOpen} />
  return <CloudVaultUnlock count={count} onOpen={onOpen} />
}

function CloudVaultUnlock({ count, onOpen }: { count: number; onOpen: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const { aal } = useAal()
  if (MODE !== 'cloud' || !count || !aal || aal.current === 'aal2') return null
  const enrolled = aal.next === 'aal2'
  return (
    <Card className="flex flex-wrap items-center gap-3 border-brass-400/50 bg-brass-100/50 p-4">
      <Lock className="size-5 text-brass-600" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold text-ink">الخزنة مقفلة: {count} وثيقة حساسة مخفية</div>
        <div className="text-muted">{enrolled ? 'أدخل رمز تطبيق المصادقة لفتحها في هذه الجلسة.' : 'فعّل التحقق الثنائي من الإعدادات لتصل إليها.'}</div>
      </div>
      {enrolled && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            const client = await sb()
            const f = await client.auth.mfa.listFactors()
            const totp = f.data?.totp?.[0]
            const { error } = totp ? await client.auth.mfa.challengeAndVerify({ factorId: totp.id, code: code.trim() }) : { error: new Error('no factor') }
            setBusy(false)
            if (error) return toast.error('الرمز غير صحيح')
            toast.success('فُتحت الخزنة')
            onOpen()
          }}
        >
          <Input inputMode="numeric" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="w-28 text-center tracking-widest" />
          <Button type="submit" variant="brass" loading={busy} icon={KeyRound}>
            افتح
          </Button>
        </form>
      )}
    </Card>
  )
}

export function MfaSettings() {
  const [factors, setFactors] = useState<{ id: string; status: string }[] | null>(null)
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const { data } = await (await sb()).auth.mfa.listFactors()
    setFactors((data?.totp ?? []).map((f) => ({ id: f.id, status: f.status })))
  }
  useEffect(() => {
    void load()
  }, [])
  const active = factors?.find((f) => f.status === 'verified')
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {active ? (
          <Badge tone="success" icon={ShieldCheck}>
            التحقق الثنائي مفعّل
          </Badge>
        ) : (
          <Badge tone="warning" icon={ShieldOff}>
            غير مفعّل — الخزنة لن تُفتح
          </Badge>
        )}
      </div>
      {!active && !enroll && (
        <Button
          icon={ShieldCheck}
          loading={busy}
          onClick={async () => {
            setBusy(true)
            const { data, error } = await (await sb()).auth.mfa.enroll({ factorType: 'totp', friendlyName: `khizana-${Date.now()}` })
            setBusy(false)
            if (error || !data) return toast.error(error?.message ?? 'تعذّر التفعيل')
            setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret })
          }}
        >
          فعّل التحقق الثنائي
        </Button>
      )}
      {enroll && (
        <Card className="p-4">
          <p className="text-sm text-text">امسح الرمز بتطبيق مصادقة (Google Authenticator أو Microsoft Authenticator)، ثم أدخل الرقم الذي يظهر فيه:</p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <img src={enroll.qr} alt="QR" className="size-40 rounded-xl bg-white p-2" />
            <div className="space-y-2">
              <div className="latin text-xs text-muted" dir="ltr">
                {enroll.secret}
              </div>
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault()
                  setBusy(true)
                  const { error } = await (await sb()).auth.mfa.challengeAndVerify({ factorId: enroll.id, code: code.trim() })
                  setBusy(false)
                  if (error) return toast.error('الرمز غير صحيح')
                  toast.success('فُعّل التحقق الثنائي — الخزنة مفتوحة في هذه الجلسة')
                  setEnroll(null)
                  setCode('')
                  void load()
                }}
              >
                <Input inputMode="numeric" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="w-32 text-center tracking-widest" />
                <Button type="submit" loading={busy}>
                  تأكيد
                </Button>
              </form>
            </div>
          </div>
        </Card>
      )}
      {active && (
        <Button
          variant="ghost"
          size="sm"
          className="text-danger"
          onClick={async () => {
            if (!confirm('إلغاء التحقق الثنائي؟ ستبقى الخزنة مقفلة حتى تفعّله من جديد.')) return
            await (await sb()).auth.mfa.unenroll({ factorId: active.id })
            void load()
          }}
        >
          إلغاء التحقق الثنائي
        </Button>
      )}
    </div>
  )
}

/** a backup taken while the vault is locked would leave its documents out: say so */
export function VaultBackupNote() {
  const { aal } = useAal()
  const v = useVault()
  const [count, setCount] = useState(0)
  useEffect(() => {
    void import('@/db/api').then(({ api }) => api.vaultCount()).then((r) => setCount(r.count))
  }, [])
  const closed = MODE === 'local' ? v.configured && !v.open : !!aal && aal.current !== 'aal2'
  if (!count || !closed) return null
  return (
    <p className="mt-3 rounded-xl bg-warning-bg px-3 py-2 text-sm text-warning">
      الخزنة مقفلة الآن: النسخة الاحتياطية لن تتضمن وثائقها ({count}). افتحها أولاً من الصفحة الرئيسية ({MODE === 'local' ? 'بالبصمة' : 'برمز التحقق الثنائي'}).
    </p>
  )
}
