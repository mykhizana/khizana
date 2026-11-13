import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { createBrowserRouter, Navigate, RouterProvider, useParams } from 'react-router'
import { Toaster } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/db/api'
import { idb } from '@/db/idb'
import { BASE, MODE } from '@/lib/config'
import { queryClient } from '@/lib/queries'
import { setOwner } from '@/lib/session'
import { queue } from '@/pipeline/queue'
import { auth } from '@/drive/auth'
import { driveSync } from '@/drive/sync'
import { vault } from '@/ui/vault'
import { LogoMark } from '@/ui/bits'
import { Button, Spinner } from '@/ui/kit'
import { Shell } from '@/ui/layout'

const Home = lazy(() => import('@/pages/home'))
const SearchPage = lazy(() => import('@/pages/search'))
const LibraryPage = lazy(() => import('@/pages/library'))
const DocPage = lazy(() => import('@/pages/doc'))
const AddPage = lazy(() => import('@/pages/add'))
const ScanPage = lazy(() => import('@/pages/scan'))
const ReviewPage = lazy(() => import('@/pages/review'))
const PeoplePage = lazy(() => import('@/pages/people'))
const PersonPage = lazy(() => import('@/pages/person'))
const PlacesPage = lazy(() => import('@/pages/places'))
const PlacePage = lazy(() => import('@/pages/place'))
const LabelsPage = lazy(() => import('@/pages/labels'))
const SettingsPage = lazy(() => import('@/pages/settings'))
const LoginPage = lazy(() => import('@/pages/login'))

function Loading() {
  return (
    <div className="grid min-h-[40vh] place-items-center">
      <Spinner />
    </div>
  )
}

const page = (el: ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>

function BoxRedirect() {
  const { code } = useParams()
  const [to, setTo] = useState<string | null>(null)
  useEffect(() => {
    void api.locationByCode(code ?? '').then((l) => setTo(l ? `/places/${l.id}` : '/places'))
  }, [code])
  return to ? <Navigate to={to} replace /> : <Loading />
}

const router = createBrowserRouter(
  [
    { path: '/scan', element: page(<ScanPage />) },
    { path: '/labels', element: page(<LabelsPage />) },
    {
      path: '/',
      element: <Shell />,
      children: [
        { index: true, element: page(<Home />) },
        { path: 'search', element: page(<SearchPage />) },
        { path: 'library', element: page(<LibraryPage />) },
        { path: 'doc/:id', element: page(<DocPage />) },
        { path: 'add', element: page(<AddPage />) },
        { path: 'review', element: page(<ReviewPage />) },
        { path: 'people', element: page(<PeoplePage />) },
        { path: 'people/:id', element: page(<PersonPage />) },
        { path: 'places', element: page(<PlacesPage />) },
        { path: 'places/:id', element: page(<PlacePage />) },
        { path: 'l/:code', element: <BoxRedirect /> },
        { path: 'settings', element: page(<SettingsPage />) },
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: BASE.replace(/\/$/, '') || '/' },
)

function Splash({ text }: { text: string }) {
  return (
    <div className="kh-paper grid min-h-dvh place-items-center px-6">
      <div className="flex flex-col items-center text-center">
        <LogoMark className="size-16 animate-pulse" />
        <div className="font-display mt-4 text-3xl text-ink">خزانة</div>
        <div className="mt-2 text-sm text-muted">{text}</div>
      </div>
    </div>
  )
}

export function App() {
  const [state, setState] = useState<'loading' | 'ready' | 'signin' | 'error'>('loading')
  const [error, setError] = useState('')

  const start = async () => {
    setState('loading')
    try {
      if (MODE === 'cloud') {
        const { supabase } = await import('@/db/cloud')
        const { data } = await supabase().auth.getSession()
        if (!data.session) {
          setState('signin')
          return
        }
      }
      // back from Google's sign-in page (the other way of signing in, see src/drive/auth.ts)
      const back = MODE === 'local' ? await auth.takeRedirect().catch(() => null) : null
      // a vault locked with the fingerprint starts closed
      if (MODE === 'local') await vault.init()
      const b = await api.bootstrap()
      setOwner(b.owner)
      setState('ready')
      queue.kick()
      if (MODE === 'local') {
        void idb.persist()
        void driveSync.start()
        if (back && back !== '/') void router.navigate(back)
      }
    } catch (e) {
      setError((e as Error).message || String(e))
      setState('error')
    }
  }

  useEffect(() => {
    void start()
  }, [])

  if (state === 'loading') return <Splash text="يفتح أرشيفك…" />
  if (state === 'signin')
    return (
      <Suspense fallback={<Splash text="…" />}>
        <LoginPage onSignedIn={start} />
      </Suspense>
    )
  if (state === 'error')
    return (
      <div className="kh-paper grid min-h-dvh place-items-center px-6">
        <div className="max-w-md text-center">
          <AlertTriangle className="mx-auto size-10 text-warning" />
          <h1 className="mt-3 text-lg font-semibold text-ink">تعذّر فتح الأرشيف</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <Button className="mt-5" onClick={start}>
            حاول مرة أخرى
          </Button>
        </div>
      </div>
    )
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-center" dir="rtl" richColors closeButton toastOptions={{ style: { fontFamily: 'var(--ff-sans)' } }} />
    </QueryClientProvider>
  )
}
