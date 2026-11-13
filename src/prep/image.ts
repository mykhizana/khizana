// Image helpers on canvas: decode, resize, encode, grey 9×8 sample for the dHash, blank-page check.
import { dhash } from '@/lib/hash'

export type Raster = { canvas: HTMLCanvasElement | OffscreenCanvas; width: number; height: number }

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    // some browsers refuse options; try plain decoding through an <img>
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return await createImageBitmap(img)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** draw a source into a canvas whose long edge is at most `edge` (never upscales) */
export function fitCanvas(src: CanvasImageSource & { width: number; height: number }, edge: number): HTMLCanvasElement {
  const w = src.width
  const h = src.height
  const k = Math.min(1, edge / Math.max(w, h))
  const c = makeCanvas(w * k, h * k)
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, c.width, c.height)
  return c
}

export function toBlob(c: HTMLCanvasElement, type = 'image/jpeg', quality = 0.86): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality))
}

/** grey 9×8 averages of the page (after cropping 3 % of the edges: scanner borders vary) */
export function grey9x8(src: CanvasImageSource & { width: number; height: number }): Float32Array {
  const c = makeCanvas(9, 8)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const mx = src.width * 0.03
  const my = src.height * 0.03
  ctx.imageSmoothingQuality = 'high'
  // two steps keep the averaging honest on large images
  const mid = makeCanvas(72, 64)
  const mctx = mid.getContext('2d')!
  mctx.imageSmoothingQuality = 'high'
  mctx.drawImage(src, mx, my, src.width - 2 * mx, src.height - 2 * my, 0, 0, 72, 64)
  ctx.drawImage(mid, 0, 0, 9, 8)
  const d = ctx.getImageData(0, 0, 9, 8).data
  const out = new Float32Array(72)
  for (let i = 0; i < 72; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
  return out
}

/**
 * dHash of a page. The source is first redrawn on a 512 px canvas so that the same page gives the
 * same hash whatever it came from (a PDF rendering, a photo bitmap, a scanner page, any resolution).
 */
export function pageHash(src: CanvasImageSource & { width: number; height: number }): string | null {
  return dhash(grey9x8(fitCanvas(src, 512)))
}

/** share of «ink» pixels: a page under ~0.25 % ink is considered blank */
export function inkRatio(src: CanvasImageSource & { width: number; height: number }): number {
  const c = fitCanvas(src, 400)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const { data } = ctx.getImageData(0, 0, c.width, c.height)
  let sum = 0
  const n = c.width * c.height
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    sum += lum[i]
  }
  const mean = sum / n
  let ink = 0
  for (let i = 0; i < n; i++) if (lum[i] < mean - 60) ink++
  return ink / n
}

/** variance of the Laplacian: low = blurred photo */
export function sharpness(src: CanvasImageSource & { width: number; height: number }): number {
  const c = fitCanvas(src, 900)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const { data, width: w, height: h } = ctx.getImageData(0, 0, c.width, c.height)
  const g = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  let sum = 0
  let sum2 = 0
  let n = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i]
      sum += v
      sum2 += v * v
      n++
    }
  const mean = sum / n
  return sum2 / n - mean * mean
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}
