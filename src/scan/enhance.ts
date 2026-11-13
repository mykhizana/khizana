// Cleaning a photographed page: shadows removed (divide by the estimated background), contrast restored,
// optional black & white (Bradley adaptive threshold). Stamps keep their colour in «document» mode.
export type EnhanceMode = 'document' | 'color' | 'gray' | 'bw'

function background(g: Float32Array, w: number, h: number): Float32Array {
  // downscale ×8 with max-pooling (paper is the brightest), blur, upscale bilinear
  const s = 8
  const sw = Math.max(1, Math.ceil(w / s))
  const sh = Math.max(1, Math.ceil(h / s))
  const small = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let m = 0
      for (let yy = y * s; yy < Math.min(h, y * s + s); yy++)
        for (let xx = x * s; xx < Math.min(w, x * s + s); xx++) m = Math.max(m, g[yy * w + xx])
      small[y * sw + x] = m
    }
  // blur the small map a few times
  let cur = small
  for (let pass = 0; pass < 3; pass++) {
    const nxt = new Float32Array(sw * sh)
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let acc = 0
        let n = 0
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const X = x + dx
            const Y = y + dy
            if (X < 0 || Y < 0 || X >= sw || Y >= sh) continue
            acc += cur[Y * sw + X]
            n++
          }
        nxt[y * sw + x] = acc / n
      }
    cur = nxt
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, y / s - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, x / s - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const tx = fx - x0
      const top = cur[y0 * sw + x0] + (cur[y0 * sw + x1] - cur[y0 * sw + x0]) * tx
      const bot = cur[y1 * sw + x0] + (cur[y1 * sw + x1] - cur[y1 * sw + x0]) * tx
      out[y * w + x] = Math.max(24, top + (bot - top) * ty)
    }
  }
  return out
}

export function enhance(img: ImageData, mode: EnhanceMode): ImageData {
  const { data, width: w, height: h } = img
  if (mode === 'color') return img
  const n = w * h
  const g = new Float32Array(n)
  for (let i = 0; i < n; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  const out = new ImageData(w, h)
  const o = out.data
  if (mode === 'gray') {
    for (let i = 0; i < n; i++) {
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = g[i]
      o[i * 4 + 3] = 255
    }
    return out
  }
  const bg = background(g, w, h)
  if (mode === 'document') {
    for (let i = 0; i < n; i++) {
      const k = 245 / bg[i]
      for (let c = 0; c < 3; c++) {
        // normalise by the background, then a gentle S-curve for ink
        let v = (data[i * 4 + c] * k) / 255
        v = v >= 1 ? 1 : v < 0.04 ? 0 : Math.pow(v, 1.35)
        o[i * 4 + c] = v * 255
      }
      o[i * 4 + 3] = 255
    }
    return out
  }
  // bw: normalise then Bradley threshold on an integral image
  const nrm = new Float32Array(n)
  for (let i = 0; i < n; i++) nrm[i] = Math.min(255, (g[i] * 245) / bg[i])
  const integ = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += nrm[y * w + x]
      integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row
    }
  }
  const r = Math.max(8, Math.round(Math.max(w, h) / 32))
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const cnt = (x1 - x0) * (y1 - y0)
      const sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0]
      const v = nrm[y * w + x] * cnt < sum * 0.86 ? 0 : 255
      const i = y * w + x
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v
      o[i * 4 + 3] = 255
    }
  }
  return out
}
