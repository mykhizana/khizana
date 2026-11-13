// Which Claude reads a document. Opus 5.5 is the most accurate; Sonnet 5.5 costs exactly half of it
// (2$/10$ against 4$/20$ per million tokens) and takes over a big import — or everything, if the owner
// chooses. A document the owner asks to read again is always read by Opus.
// Pure functions only (no settings, no network): the queue and the transport decide with them.
export const OPUS = 'claude-opus-5-5'
export const SONNET = 'claude-sonnet-5-5'

export type ReadingMode = 'auto' | 'opus' | 'sonnet'
/** «auto»: from this many documents in line (waiting or being read), the import is read by Sonnet until the line is empty */
export const ECONOMY_FROM = 5

export const isOpus = (m: string | null | undefined) => !!m && m.startsWith('claude-opus')
export const isSonnet = (m: string | null | undefined) => !!m && m.startsWith('claude-sonnet')

/** «claude-sonnet-5-5» → «Claude Sonnet 5.5» */
export function modelName(m: string | null | undefined): string {
  if (!m) return 'Claude'
  const x = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(m)
  if (!x) return m
  return `Claude ${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? '.' + x[3] : ''}`
}

/** the setting as stored (anything unknown, or nothing yet, is «auto») */
export const readingMode = (v: unknown): ReadingMode => (v === 'opus' || v === 'sonnet' ? v : 'auto')

/** «auto»: a big import starts an economy wave, which lasts until the line is empty */
export function economyWave(o: { mode: ReadingMode; wave: boolean; busy: number }): boolean {
  if (o.mode !== 'auto' || o.busy <= 0) return false
  return o.wave || o.busy >= ECONOMY_FROM
}

/** the model for one document */
export function pickModel(o: { mode: ReadingMode; wave: boolean; opus?: boolean }): string {
  if (o.opus || o.mode === 'opus') return OPUS
  if (o.mode === 'sonnet') return SONNET
  return o.wave ? SONNET : OPUS
}

/**
 * Sonnet did not give an answer: what next.
 *  • it declined the document (a refusal): Opus, with its own server-side fallback, reads it instead;
 *  • the request was refused (400), the model unknown (404) or not allowed for this key (403):
 *    Opus reads it, and this session stops using Sonnet;
 *  • anything else (no internet, rate limit, credit, server): the usual handling.
 */
export function sonnetFallback(e: { kind: string; status?: number }): 'opus' | 'opus_off' | null {
  if (e.kind === 'refusal') return 'opus'
  if (e.kind === 'credit' || e.kind === 'rate' || e.kind === 'network') return null
  if (e.status === 400 || e.status === 403 || e.status === 404) return 'opus_off'
  return null
}
