// Fingerprints used by the duplicate detector:
// layer 1 SHA-256 of the bytes · layer 2 hash of the normalised text · layer 3 dHash of every page image
// layer 4 MinHash of the text (+ LSH bands) · layer 5 hash of every page text.
import { norm } from './norm.ts'

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data)
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** hash of a text after normalisation; null when there is too little text to mean anything */
export async function textHash(t: string, min = 40): Promise<string | null> {
  const n = norm(t)
  if (n.replace(/\s/g, '').length < min) return null
  return (await sha256Hex(n)).slice(0, 32)
}

// ---------------------------------------------------------------- MinHash
const K = 128
const BANDS = 32
const ROWS = K / BANDS

function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
function mix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** 128 signed 32-bit values over word 3-grams of the normalised text (null when the text is too short) */
export function minhash(t: string, maxChars = 250_000): number[] | null {
  const words = norm(t.slice(0, maxChars)).split(' ').filter(Boolean)
  if (words.length < 8) return null
  const sig = new Uint32Array(K).fill(0xffffffff)
  const n = words.length >= 3 ? words.length - 2 : words.length
  for (let i = 0; i < n; i++) {
    const sh = words.length >= 3 ? `${words[i]} ${words[i + 1]} ${words[i + 2]}` : words[i]
    const h1 = fnv1a(sh)
    const h2 = mix(h1 ^ 0x9e3779b9) | 1
    for (let k = 0; k < K; k++) {
      const v = (h1 + Math.imul(k, h2)) >>> 0
      if (v < sig[k]) sig[k] = v
    }
  }
  return Array.from(sig, (v) => v | 0)
}

/** 32 bands of 4 rows → one hash per band (stored as text: they are bigint in the database) */
export function lshBands(sig: number[]): string[] {
  const out: string[] = []
  for (let b = 0; b < BANDS; b++) {
    let h = 0x811c9dc5 ^ b
    for (let r = 0; r < ROWS; r++) {
      h ^= sig[b * ROWS + r]
      h = Math.imul(h, 0x01000193)
    }
    out.push(String(h | 0))
  }
  return out
}

export function minhashSimilarity(a: number[], b: number[]): number {
  let same = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++
  return same / Math.max(a.length, 1)
}

// ---------------------------------------------------------------- dHash (page images)
/**
 * 64-bit difference hash of an image (as a signed decimal string for the bigint column).
 * Returns null for near-uniform pages (blank) where the hash means nothing.
 */
export function dhash(gray9x8: Float32Array | number[]): string | null {
  let min = Infinity
  let max = -Infinity
  for (const v of gray9x8) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (max - min < 6) return null
  let bits = 0n
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      bits <<= 1n
      if (gray9x8[y * 9 + x] < gray9x8[y * 9 + x + 1]) bits |= 1n
    }
  return BigInt.asIntN(64, bits).toString()
}

export function hamming(a: string, b: string): number {
  let x = BigInt.asUintN(64, BigInt(a) ^ BigInt(b))
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}
