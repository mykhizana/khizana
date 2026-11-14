// Data hooks (TanStack Query). Every screen refreshes when the background worker finishes a document.
import { QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { api } from '@/db/api'
import { MODE } from '@/lib/config'
import { aiMode } from '@/ai/transport'
import { queue } from '@/pipeline/queue'
import type { SearchFilters } from './types'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
})

export function refreshAll() {
  void queryClient.invalidateQueries()
}

queue.onDocDone = (id) => {
  void queryClient.invalidateQueries({ queryKey: ['doc', id] })
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'doc' })
  // a document read may bring new deadlines: the phone reminders follow a minute later
  if (MODE === 'local') void import('@/drive/reminders').then(({ reminders }) => reminders.soon())
}

export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: api.overview })
export const useCounts = () => useQuery({ queryKey: ['counts'], queryFn: api.counts, refetchInterval: 20_000 })
export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: api.categories })
export const useLocations = () => useQuery({ queryKey: ['locations'], queryFn: api.locations })
export const useReviews = () => useQuery({ queryKey: ['reviews'], queryFn: api.reviews })
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: api.settings })
export const useUsage = () => useQuery({ queryKey: ['usage'], queryFn: api.usage })
export const useAiMode = () => useQuery({ queryKey: ['ai-mode'], queryFn: aiMode, staleTime: 60_000 })
export const useDoc = (id: string | undefined) => useQuery({ queryKey: ['doc', id], queryFn: () => api.doc(id!), enabled: !!id })
export const useEntities = (kind: string, q: string) => useQuery({ queryKey: ['entities', kind, q], queryFn: () => api.entities({ kind, q }) })
export const useEntity = (id: string | undefined) => useQuery({ queryKey: ['entity', id], queryFn: () => api.entity(id!), enabled: !!id })

export function useSearch(p: { q?: string; filters?: SearchFilters; sort?: string; limit?: number; offset?: number; facets?: boolean }, enabled = true) {
  return useQuery({ queryKey: ['search', p], queryFn: () => api.search(p), enabled, placeholderData: (prev) => prev })
}

/** pages of 30 results, fetched one after the other («عرض المزيد»); facets come with the first page */
export function useSearchPages(p: { q?: string; filters?: SearchFilters; sort?: string }, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: ['search-pages', p],
    queryFn: ({ pageParam }) => api.search({ ...p, limit: 30, offset: pageParam, facets: pageParam === 0 }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, x) => n + x.items.length, 0)
      return loaded < last.total && last.items.length > 0 ? loaded : undefined
    },
    enabled,
    placeholderData: (prev) => prev,
  })
  const first = q.data?.pages[0]
  const data = first ? { ...first, items: q.data!.pages.flatMap((x) => x.items) } : undefined
  return { ...q, data }
}

/** every id matching some filters (for «move all», re-reading after a key…), page by page */
export async function allIds(filters: SearchFilters): Promise<string[]> {
  const out: string[] = []
  for (let offset = 0; ; offset += 200) {
    const r = await api.search({ filters, limit: 200, offset, facets: false })
    out.push(...r.items.map((x) => x.id))
    if (r.items.length < 200 || out.length >= r.total) return out
  }
}

export function useQueue() {
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot)
}
