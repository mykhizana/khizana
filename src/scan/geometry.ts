// Paper detection and straightening, in plain TypeScript (no OpenCV):
// Otsu threshold → largest bright region → convex hull → best 4-corner polygon → homography warp.
export type Pt = { x: number; y: number }
export type Quad = [Pt, Pt, Pt, Pt] // top-left, top-right, bottom-right, bottom-left

/** luminance of an RGBA buffer */
export function luma(data: Uint8ClampedArray, n: number): Uint8Array {
  const g = new Uint8Array(n)
  for (let i = 0; i < n; i++) g[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8
  return g
}

function boxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1)
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1)
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

export function otsu(g: Uint8Array): number {
  const hist = new Array(256).fill(0)
  for (const v of g) hist[v]++
  const total = g.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      thr = t
    }
  }
  return thr
}

function cross(o: Pt, a: Pt, b: Pt) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

export function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

const triArea = (a: Pt, b: Pt, c: Pt) => Math.abs(cross(a, b, c)) / 2
export const polyArea = (p: Pt[]) => {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i]
    const b = p[(i + 1) % p.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/** reduce a convex polygon to 4 corners by removing the vertex that loses the least area (Visvalingam) */
export function toQuad(hull: Pt[]): Pt[] {
  const p = [...hull]
  while (p.length > 4) {
    let bi = 0
    let ba = Infinity
    for (let i = 0; i < p.length; i++) {
      const a = triArea(p[(i - 1 + p.length) % p.length], p[i], p[(i + 1) % p.length])
      if (a < ba) {
        ba = a
        bi = i
      }
    }
    p.splice(bi, 1)
  }
  return p
}

/** order 4 points as top-left, top-right, bottom-right, bottom-left */
export function orderQuad(p: Pt[]): Quad {
  const s = [...p].sort((a, b) => a.y - b.y)
  const top = s.slice(0, 2).sort((a, b) => a.x - b.x)
  const bottom = s.slice(2).sort((a, b) => a.x - b.x)
  return [top[0], top[1], bottom[1], bottom[0]]
}

export function fullQuad(w: number, h: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ]
}

/**
 * find the sheet of paper in a small grey image (w×h, ~360 px): returns its corners or null.
 * The paper is assumed brighter than the table; the user can always move the corners by hand.
 */
export function detectQuad(g: Uint8Array, w: number, h: number): Quad | null {
  const b = boxBlur(boxBlur(g, w, h, 2), w, h, 2)
  const t = otsu(b)
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) mask[i] = b[i] > t ? 1 : 0
  // largest 4-connected bright component
  const label = new Int32Array(w * h)
  let bestLabel = 0
  let bestSize = 0
  let next = 1
  const stack: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i]) continue
    let size = 0
    label[i] = next
    stack.push(i)
    while (stack.length) {
      const k = stack.pop()!
      size++
      const x = k % w
      const y = (k / w) | 0
      if (x > 0 && mask[k - 1] && !label[k - 1]) (label[k - 1] = next), stack.push(k - 1)
      if (x < w - 1 && mask[k + 1] && !label[k + 1]) (label[k + 1] = next), stack.push(k + 1)
      if (y > 0 && mask[k - w] && !label[k - w]) (label[k - w] = next), stack.push(k - w)
      if (y < h - 1 && mask[k + w] && !label[k + w]) (label[k + w] = next), stack.push(k + w)
    }
    if (size > bestSize) {
      bestSize = size
      bestLabel = next
    }
    next++
  }
  if (bestSize < w * h * 0.12) return null
  // boundary points only (row and column extremes: every edge of the sheet is sampled)
  const pts: Pt[] = []
  for (let y = 0; y < h; y++) {
    let first = -1
    let last = -1
    for (let x = 0; x < w; x++)
      if (label[y * w + x] === bestLabel) {
        if (first < 0) first = x
        last = x
      }
    if (first >= 0) pts.push({ x: first, y: y + 0.5 }, { x: last + 1, y: y + 0.5 })
  }
  for (let x = 0; x < w; x++) {
    let first = -1
    let last = -1
    for (let y = 0; y < h; y++)
      if (label[y * w + x] === bestLabel) {
        if (first < 0) first = y
        last = y
      }
    if (first >= 0) pts.push({ x: x + 0.5, y: first }, { x: x + 0.5, y: last + 1 })
  }
  const hull = convexHull(pts)
  if (hull.length < 4) return null
  const quad = toQuad(hull)
  if (quad.length !== 4) return null
  const area = polyArea(quad)
  if (area < w * h * 0.15) return null
  return refineQuad(orderQuad(quad), pts, w, h)
}

/**
 * straight sides: the blur rounds the corners, so the rough corners sit a little inside the sheet.
 * Fit a line to the boundary points along the middle of each side (wide tolerance first, then
 * tighter), and take the corners at the intersections.
 */
function refineQuad(q0: Quad, pts: Pt[], w: number, h: number): Quad {
  let q = q0
  for (const tol of [14, 6, 3]) q = refinePass(q, pts, w, h, tol)
  return q
}

function refinePass(q: Quad, pts: Pt[], w: number, h: number, tol: number): Quad {
  type Line = { x: number; y: number; dx: number; dy: number }
  const lines: (Line | null)[] = []
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    const ex = b.x - a.x
    const ey = b.y - a.y
    const len2 = ex * ex + ey * ey
    const len = Math.sqrt(len2)
    if (len < 10) {
      lines.push(null)
      continue
    }
    const sel = pts.filter((p) => {
      const t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2
      const d = Math.abs((p.x - a.x) * -ey + (p.y - a.y) * ex) / len
      return t > 0.15 && t < 0.85 && d < tol
    })
    if (sel.length < 8) {
      lines.push(null)
      continue
    }
    let mx = 0
    let my = 0
    for (const p of sel) {
      mx += p.x
      my += p.y
    }
    mx /= sel.length
    my /= sel.length
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (const p of sel) {
      sxx += (p.x - mx) ** 2
      sxy += (p.x - mx) * (p.y - my)
      syy += (p.y - my) ** 2
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    lines.push({ x: mx, y: my, dx: Math.cos(ang), dy: Math.sin(ang) })
  }
  const out = q.map((corner, i) => {
    const l1 = lines[(i + 3) % 4]
    const l2 = lines[i]
    if (!l1 || !l2) return corner
    const det = l1.dx * l2.dy - l1.dy * l2.dx
    if (Math.abs(det) < 1e-6) return corner
    const t = ((l2.x - l1.x) * l2.dy - (l2.y - l1.y) * l2.dx) / det
    const p = { x: l1.x + t * l1.dx, y: l1.y + t * l1.dy }
    // a corner never jumps far from the rough one (and stays near the frame)
    if (Math.hypot(p.x - corner.x, p.y - corner.y) > Math.max(w, h) * 0.08) return corner
    return { x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) }
  })
  return out as Quad
}

// ---------------------------------------------------------------- perspective
/** 3×3 homography mapping the unit square corners → quad (as 8 numbers, h33 = 1) */
function squareToQuad(q: Quad): number[] {
  const [p0, p1, p2, p3] = q
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const sx = p0.x - p1.x + p2.x - p3.x
  const sy = p0.y - p1.y + p2.y - p3.y
  let g = 0
  let hh = 0
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1
    g = (sx * dy2 - dx2 * sy) / det
    hh = (dx1 * sy - sx * dy1) / det
  }
  const a = p1.x - p0.x + g * p1.x
  const b = p3.x - p0.x + hh * p3.x
  const c = p0.x
  const d = p1.y - p0.y + g * p1.y
  const e = p3.y - p0.y + hh * p3.y
  const f = p0.y
  return [a, b, c, d, e, f, g, hh]
}

export function quadSize(q: Quad): { w: number; h: number } {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  return { w: Math.max(d(q[0], q[1]), d(q[3], q[2])), h: Math.max(d(q[0], q[3]), d(q[1], q[2])) }
}

/** straighten the quad of `src` (RGBA, sw×sh) into an image of ow×oh (bilinear sampling) */
export function warp(src: Uint8ClampedArray, sw: number, sh: number, q: Quad, ow: number, oh: number): Uint8ClampedArray {
  const [a, b, c, d, e, f, g, hh] = squareToQuad(q)
  const out = new Uint8ClampedArray(ow * oh * 4)
  for (let y = 0; y < oh; y++) {
    const v = (y + 0.5) / oh
    for (let x = 0; x < ow; x++) {
      const u = (x + 0.5) / ow
      const den = g * u + hh * v + 1
      const X = (a * u + b * v + c) / den - 0.5
      const Y = (d * u + e * v + f) / den - 0.5
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(X)))
      const y0 = Math.max(0, Math.min(sh - 2, Math.floor(Y)))
      const fx = Math.min(1, Math.max(0, X - x0))
      const fy = Math.min(1, Math.max(0, Y - y0))
      const i00 = (y0 * sw + x0) * 4
      const i10 = i00 + 4
      const i01 = i00 + sw * 4
      const i11 = i01 + 4
      const o = (y * ow + x) * 4
      for (let k = 0; k < 3; k++) {
        const top = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx
        const bot = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx
        out[o + k] = top + (bot - top) * fy
      }
      out[o + 3] = 255
    }
  }
  return out
}
