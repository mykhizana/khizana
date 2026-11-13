// Cloud mode sign-in: e-mail + password, then the second factor (authenticator app) when enrolled.
import { KeyRound, Lock, Mail } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { supabase } from '@/db/cloud'
import { LogoMark } from '@/ui/bits'
import { Button, Card, Field, Input } from '@/ui/kit'

export default function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [factor, setFactor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const signIn = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error: err } = await supabase().auth.signInWithPassword({ email: email.trim(), password })
    if (err) {
      setError('البريد أو كلمة السر غير صحيحة')
      setBusy(false)
      return
    }
    const { data } = await supabase().auth.mfa.getAuthenticatorAssuranceLevel()
    if (data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2') {
      const f = await supabase().auth.mfa.listFactors()
      const totp = f.data?.totp?.[0]
      if (totp) {
        setFactor(totp.id)
        setBusy(false)
        return
      }
    }
    onSignedIn()
  }

  const verify = async (e: FormEvent) => {
    e.preventDefault()
    if (!factor) return
    setBusy(true)
    setError('')
    const { error: err } = await supabase().auth.mfa.challengeAndVerify({ factorId: factor, code: code.trim() })
    if (err) {
      setError('الرمز غير صحيح')
      setBusy(false)
      return
    }
    onSignedIn()
  }

  return (
    <div className="kh-paper grid min-h-dvh place-items-center px-4">
      <Card className="w-full max-w-sm p-7">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark className="size-14" />
          <h1 className="font-display mt-3 text-3xl text-ink">خزانة</h1>
          <p className="mt-1 text-sm text-muted">أرشيفك الخاص — ادخل لتصل إليه</p>
        </div>
        {!factor ? (
          <form onSubmit={signIn} className="space-y-4">
            <Field label="البريد الإلكتروني">
              <div className="relative">
                <Mail className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                <Input type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="ps-9" />
              </div>
            </Field>
            <Field label="كلمة السر">
              <div className="relative">
                <Lock className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                <Input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="ps-9" />
              </div>
            </Field>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" className="w-full" loading={busy}>
              دخول
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <Field label="رمز التحقق من تطبيق المصادقة" hint="6 أرقام">
              <div className="relative">
                <KeyRound className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                <Input inputMode="numeric" dir="ltr" autoFocus value={code} onChange={(e) => setCode(e.target.value)} className="ps-9 text-center tracking-[0.4em]" />
              </div>
            </Field>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" className="w-full" loading={busy}>
              تحقق
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}
