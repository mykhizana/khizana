// Cloud mode: the owner's Supabase project (database + private file storage + sign-in).
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_KEY, SUPABASE_URL } from '@/lib/config'

let client: SupabaseClient | null = null

export function supabase(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase is not configured')
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'kh-auth' },
    })
  }
  return client
}

export async function cloudCall<T>(fn: string, p: unknown): Promise<T> {
  const { data, error } = await supabase().rpc(fn, { p: p ?? {} })
  if (error) throw new Error(error.message)
  return data as T
}
