// The device-mode database: real Postgres (PGlite) in a worker, saved in IndexedDB.
// Several tabs share it (one tab leads, the others talk to it).
import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'

worker({
  async init() {
    return await PGlite.create('idb://khizana', { extensions: { pg_trgm }, relaxedDurability: true })
  },
})
