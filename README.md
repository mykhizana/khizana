# خزانة · Khizana

A private, AI-organised document archive (Arabic-first, RTL) — documents are read and classified by Claude Opus 5.5, duplicates are stopped by six layers of fingerprints, and everything is searchable across Arabic, French, Spanish and English.

**Open it**: <https://mykhizana.github.io/khizana/> — only the app's code lives here. Documents, the index and the keys stay on each device and in the owner's own Google Drive. Every push to `main` runs all the tests, then publishes ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)).

- **Stack**: React 19 · Vite 8 · TypeScript 7 · Tailwind 4 · TanStack Query · PGlite (Postgres in the browser) / Supabase · pdf.js · fflate · @anthropic-ai/sdk
- **One data layer, two homes**: `supabase/schema.sql` defines every table, rule and `kh_*` function. The same file runs in the browser (device mode, with `supabase/local-stubs.sql`) and in Supabase (cloud mode). The app only calls functions (`src/db/api.ts`).
- **Pipeline**: `src/pipeline/ingest.ts` → `queue.ts` → `process.ts` (OCR → split stacks → duplicates → understand → identity check) with decisions in `dedup.ts`.
- **AI**: `src/ai/claude.ts` (transcribe · understand · split · judge · parse query) through `src/ai/transport.ts` (browser key in device mode, `supabase/functions/kh-ai` in cloud mode, monthly cap, server-side refusal fallback). Who reads a document (`src/ai/models.ts`, setting `reading_mode`): Opus 5.5, or Sonnet 5.5 at exactly half the price for a big import (5+ documents in line, until the line is empty); a Sonnet refusal or an unusable Sonnet request is asked again of Opus; «read the pages again with Opus» on any Sonnet-read document. (The Message Batches API refuses browser origins — CORS — so batches would need a relay.)
- **Ask your archive** (`/ask`, `src/ai/ask.ts` + `ask-format.ts`, `src/pages/ask.tsx`): a streaming tool-use conversation (`converse()` in the transport) where Claude Opus 5.5 calls two tools run on the device — `search_archive` (the local full-text search) and `read_document` (card + pages, cut to 20k characters) — and cites every fact as `[[doc:ID|p:PAGE]]`, rendered as chips that open the page. The vault stays hidden while closed (RLS); the conversation is kept in memory only.
- **Scanner**: `src/scan/*` (paper detection with line-fitted corners, perspective warp, shadow removal, adaptive threshold) — no OpenCV.
- **Google Drive sync** (device mode, no server): `supabase/local-sync.sql` (row versions, outbox, tombstones, last-writer-wins apply, snapshots, file and mirror queues) + `src/drive/*` (Drive v3 client, sync engine, Google sign-in). Stored files go to Drive's hidden app folder; a readable copy of every non-vault document goes to a visible «خزانة» folder (one folder per shelf, scans as PDF). The vault opens with a device passkey (`src/ui/vault.tsx`).

```bash
npm install
npm run dev          # http://localhost:5177/khizana/
npm run test:db      # schema, API functions, security (PGlite)
npm run test:lib     # normalisation parity, fingerprints, detection, decisions
npm run test:sync    # two/three devices exchanging changesets and snapshots (SQL layer)
npm run test:drive   # the sync engine against a stand-in for Google Drive (scripts/fake-drive.mjs)
npm run build
```

User guide (Arabic): [docs/GUIDE.md](docs/GUIDE.md)
