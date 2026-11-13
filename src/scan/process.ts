// One captured photo → a clean, straight page (and the numbers that say if it must be retaken).
import { fitCanvas, inkRatio, makeCanvas, sharpness, toBlob } from '@/prep/image'
import { enhance, type EnhanceMode } from './enhance'
import { detectQuad, fullQuad, luma, quadSize, warp, type Quad } from './geometry'

export type Processed = { blob: Blob; quad: Quad; sharp: number; blank: boolean; width: number; height: number }

const DETECT_EDGE = 360
const MAX_SOURCE = 3000
const MAX_OUT = 2400

export function detectOn(src: CanvasImageSource & { width: number; height: number }): Quad | null {
  const small = fitCanvas(src, DETECT_EDGE)
  const ctx = small.getContext('2d', { willReadFrequently: true })!
  const { data, width, height } = ctx.getImageData(0, 0, small.width, small.height)
  const q = detectQuad(luma(data, width * height), width, height)
  if (!q) return null
  const kx = src.width / small.width
  const ky = src.height / small.height
  return q.map((p) => ({ x: p.x * kx, y: p.y * ky })) as Quad
}

export function sourceCanvas(src: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  return fitCanvas(src, MAX_SOURCE)
}

export async function processCapture(src: HTMLCanvasElement, o: { quad?: Quad | null; mode: EnhanceMode; rotate?: number }): Promise<Processed> {
  const quad = o.quad ?? detectOn(src) ?? fullQuad(src.width, src.height)
  const sctx = src.getContext('2d', { willReadFrequently: true })!
  const sdata = sctx.getImageData(0, 0, src.width, src.height).data
  const size = quadSize(quad)
  const k = Math.min(1, MAX_OUT / Math.max(size.w, size.h))
  const ow = Math.max(200, Math.round(size.w * k))
  const oh = Math.max(200, Math.round(size.h * k))
  const flat = warp(sdata, src.width, src.height, quad, ow, oh)
  const img = enhance(new ImageData(flat as Uint8ClampedArray<ArrayBuffer>, ow, oh), o.mode)
  let out = makeCanvas(ow, oh)
  out.getContext('2d')!.putImageData(img, 0, 0)
  const rot = ((o.rotate ?? 0) % 360 + 360) % 360
  if (rot) {
    const r = makeCanvas(rot % 180 ? oh : ow, rot % 180 ? ow : oh)
    const c = r.getContext('2d')!
    c.translate(r.width / 2, r.height / 2)
    c.rotate((rot * Math.PI) / 180)
    c.drawImage(out, -ow / 2, -oh / 2)
    out = r
  }
  const blob = await toBlob(out, 'image/jpeg', o.mode === 'bw' ? 0.8 : 0.88)
  return { blob, quad, sharp: sharpness(out), blank: inkRatio(out) < 0.0025, width: out.width, height: out.height }
}

/** mean absolute difference between two small grey frames (to know when the phone is still) */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 255
  let s = 0
  for (let i = 0; i < a.length; i += 3) s += Math.abs(a[i] - b[i])
  return s / (a.length / 3)
}
