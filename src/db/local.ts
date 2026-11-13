// Device mode: the same supabase/schema.sql runs in the browser (PGlite), so every kh_* call
// behaves exactly as in the cloud; supabase/local-sync.sql adds what keeps several devices in step
// through Google Drive. The schema is (re)applied when it changes.
//
// Every call runs as the signed-in role (row level security applies, as in the cloud), with the
// vault open or closed for this tab (src/ui/vault.tsx: the fingerprint / screen lock opens it).
import { PGliteWorker } from '@electric-sql/pglite/worker'
import stubs from '../../supabase/local-stubs.sql?raw'
import schema from '../../supabase/schema.sql?raw'
import sync from '../../supabase/local-sync.sql?raw'
import { isVaultOpen } from './vault-state'

let db: PGliteWorker | null = null
let ready: Promise<PGliteWorker> | null = null

function schemaVersion(): string {
  let h = 0x811c9dc5
  const s = stubs + schema + sync
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + ':' + s.length
}

async function open(): Promise<PGliteWorker> {
  const pg = await PGliteWorker.create(new Worker(new URL('./pg-worker.ts', import.meta.url), { type: 'module' }))
  await pg.exec('create table if not exists public.kh_local_meta (key text primary key, value text)')
  const v = schemaVersion()
  const cur = (await pg.query<{ value: string }>(`select value from public.kh_local_meta where key = 'schema'`)).rows[0]?.value
  if (cur !== v) {
    await pg.exec(stubs)
    await pg.exec(schema)
    await pg.exec(sync)
    await pg.query(`insert into public.kh_local_meta (key, value) values ('schema', $1) on conflict (key) do update set value = excluded.value`, [v])
  }
  db = pg
  return pg
}

export function localDb(): Promise<PGliteWorker> {
  if (db) return Promise.resolve(db)
  ready ??= open().catch((e) => {
    ready = null
    throw e
  })
  return ready
}

export async function localCall<T>(fn: string, p: unknown): Promise<T> {
  if (!/^kh_[a-z_]+$/.test(fn)) throw new Error('bad function name')
  const pg = await localDb()
  return pg.transaction(async (tx) => {
    await tx.query(`select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)`, [isVaultOpen() ? '{"aal":"aal2"}' : '{"aal":"aal1"}'])
    const r = await tx.query<{ r: T }>(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p ?? {})])
    return r.rows[0]?.r as T
  })
}
