// Prices in dollars per million tokens (Anthropic first-party API). Cache writes (5 min) cost 1.25 × input.
type Price = { in: number; out: number; cacheRead: number }
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
}

export type Usage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function priceOf(model: string): Price {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(k + '-')) ?? 'claude-opus-5-5'
  return PRICES[key]
}

export function costOf(model: string, u: Usage, batch = false): number {
  const p = priceOf(model)
  const usd =
    ((u.input_tokens ?? 0) * p.in +
      (u.output_tokens ?? 0) * p.out +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.in * 1.25) /
    1e6
  return batch ? usd / 2 : usd
}

/** rough estimate before a call: ~1,600 tokens for a page image, ~1 token per 2.6 characters of Arabic/Latin text */
export function estimateCost(o: { images?: number; chars?: number; outTokens?: number; model?: string }): number {
  const p = priceOf(o.model ?? 'claude-opus-5-5')
  const input = (o.images ?? 0) * 1600 + (o.chars ?? 0) / 2.6 + 3500
  const output = o.outTokens ?? 1500
  return (input * p.in + output * p.out) / 1e6
}

export const fmtUsd = (v: number) => (v < 0.01 && v > 0 ? '<0.01$' : `${v.toFixed(v < 10 ? 2 : 1)}$`)
