// Device mode: the vault (IDs, passports, medical and bank papers) opens with the fingerprint, the face
// or the screen lock of this device — a passkey that stays in the device; nothing about it leaves it.
// Closed, the vault's documents are hidden everywhere (the database's own rules, as in the cloud).
// It closes again when the app has been in the background for 5 minutes.
import { Fingerprint, Lock, LockOpen, ShieldCheck, ShieldOff } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { idb } from '@/db/idb'
import { isVaultOpen, setVaultOpen } from '@/db/vault-state'
import { queryClient } from '@/lib/queries'
import { Badge, Button, Card } from './kit'

const KV = 'vault_lock'
type Passkey = { id: string; at: string }
let key: Passkey | null = null
let state = { configured: false, open: true }
const listeners = new Set<() => void>()
const emit = () => {
  state = { configured: !!key, open: isVaultOpen() }
  listeners.forEach((f) => f())
}

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const challenge = () => crypto.getRandomValues(new Uint8Array(32))

let hiddenAt = 0
let watching = false

export const vault = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },
  get: () => state,

  /** at start-up: a vault with a lock starts closed */
  async init() {
    key = (await idb.get<Passkey>('kv', KV).catch(() => undefined)) ?? null
    setVaultOpen(!key)
    emit()
    if (!watching && typeof document !== 'undefined') {
      watching = true
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') hiddenAt = Date.now()
        else if (key && isVaultOpen() && hiddenAt && Date.now() - hiddenAt > 5 * 60_000) void vault.close()
      })
    }
  },

  async supported(): Promise<boolean> {
    try {
      return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) === true
    } catch {
      return false
    }
  },

  /** a passkey of this device for the vault (the device asks for the fingerprint / screen lock) */
  async setup() {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: challenge(),
        rp: { name: 'خزانة' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'khizana-vault', displayName: 'خزنة خزانة' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null
    if (!cred) throw new Error('لم يكتمل إعداد القفل')
    key = { id: b64(cred.rawId), at: new Date().toISOString() }
    await idb.set('kv', KV, key)
    setVaultOpen(true)
    emit()
  },

  /** the owner proves it is them (fingerprint, face or the device's code) */
  async verify(): Promise<boolean> {
    if (!key) return true
    try {
      const r = await navigator.credentials.get({
        publicKey: { challenge: challenge(), allowCredentials: [{ type: 'public-key', id: unb64(key.id) }], userVerification: 'required', timeout: 60_000 },
      })
      return !!r
    } catch {
      return false
    }
  },

  async open() {
    if (!(await vault.verify())) return false
    setVaultOpen(true)
    emit()
    await queryClient.invalidateQueries()
    return true
  },
  async close() {
    if (!key) return
    setVaultOpen(false)
    emit()
    await queryClient.invalidateQueries()
  },
  async remove() {
    if (!(await vault.verify())) return false
    key = null
    await idb.del('kv', KV)
    setVaultOpen(true)
    emit()
    await queryClient.invalidateQueries()
    return true
  },
}

export function useVault() {
  return useSyncExternalStore(vault.subscribe, vault.get)
}

/** on the home page: the vault is closed and holds documents */
export function DeviceVaultUnlock({ count, onOpen }: { count: number; onOpen: () => void }) {
  const v = useVault()
  const [busy, setBusy] = useState(false)
  if (!v.configured || v.open || !count) return null
  return (
    <Card className="flex flex-wrap items-center gap-3 border-brass-400/50 bg-brass-100/50 p-4">
      <Lock className="size-5 text-brass-600" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold text-ink">الخزنة مقفلة: {count} وثيقة حساسة مخفية</div>
        <div className="text-muted">تُفتح ببصمتك أو برمز قفل هذا الجهاز.</div>
      </div>
      <Button
        variant="brass"
        icon={Fingerprint}
        loading={busy}
        onClick={async () => {
          setBusy(true)
          const ok = await vault.open()
          setBusy(false)
          if (ok) {
            toast.success('فُتحت الخزنة')
            onOpen()
          } else toast.error('لم يتم التحقق')
        }}
      >
        افتح الخزنة
      </Button>
    </Card>
  )
}

/** the settings block (device mode) */
export function DeviceVaultSettings() {
  const v = useVault()
  const [can, setCan] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void vault.supported().then(setCan)
  }, [])
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      const r = await fn()
      if (r !== false) toast.success(done)
      else toast.error('لم يتم التحقق')
    } catch (e) {
      toast.error((e as Error).message || 'تعذّر ذلك')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {v.configured ? (
          <Badge tone="success" icon={ShieldCheck}>
            الخزنة مقفلة ببصمة هذا الجهاز
          </Badge>
        ) : (
          <Badge tone="warning" icon={ShieldOff}>
            بلا قفل على هذا الجهاز
          </Badge>
        )}
        {v.configured && <Badge icon={v.open ? LockOpen : Lock}>{v.open ? 'مفتوحة الآن' : 'مقفلة الآن'}</Badge>}
      </div>
      {can === false && !v.configured && <p className="text-sm text-muted">هذا المتصفح لا يدعم القفل بالبصمة أو برمز الجهاز. على الهاتف وفي Windows Hello يعمل عادةً.</p>}
      <div className="flex flex-wrap gap-2">
        {!v.configured && can && (
          <Button icon={Fingerprint} loading={busy} onClick={() => run(() => vault.setup(), 'أُقفلت الخزنة ببصمتك: تُفتح عند الحاجة')}>
            اقفل الخزنة بالبصمة
          </Button>
        )}
        {v.configured && v.open && (
          <Button variant="secondary" icon={Lock} onClick={() => run(() => vault.close(), 'أُقفلت الخزنة')}>
            أقفلها الآن
          </Button>
        )}
        {v.configured && !v.open && (
          <Button variant="secondary" icon={Fingerprint} loading={busy} onClick={() => run(() => vault.open(), 'فُتحت الخزنة')}>
            افتحها
          </Button>
        )}
        {v.configured && (
          <Button variant="ghost" className="text-danger" loading={busy} onClick={() => run(() => vault.remove(), 'أزيل القفل')}>
            أزل القفل
          </Button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted">
        يقفل كل جهاز خزنته بنفسه (ببصمته أو برمز قفله). ونسخة الأرشيف في Google Drive يحميها حساب Google: فعّل فيه «التحقق بخطوتين».
      </p>
    </div>
  )
}
