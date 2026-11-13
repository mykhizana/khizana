// node scripts/make-icons.mjs — draws the app icons (PNG) from the same geometry as public/logo.svg.
// Pure Node: shapes are rasterised with 4×4 supersampling and encoded with zlib.
import { writeFileSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'

const BG = [0x0f, 0x3d, 0x39]
const BRASS = [0xcf, 0xa7, 0x5f]
const PAPER = [0xf7, 0xef, 0xdc]

const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}
const roundRect = (px, py, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2
  const qx = Math.abs(px - cx) - (w / 2 - r), qy = Math.abs(py - cy) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
// the arch: two legs and the top half-ellipse, as a polyline
const ARCH = []
for (let i = 0; i <= 48; i++) {
  const a = Math.PI + (Math.PI * i) / 48
  ARCH.push([32 + 14 * Math.cos(a), 30 + 16 * Math.sin(a)])
}
const ARCH_LINES = [[[18, 52], [18, 30]], ...ARCH.slice(1).map((p, i) => [ARCH[i], p]), [[46, 30], [46, 52]], [[14, 52], [50, 52]]]

function shade(x, y, full) {
  // returns [r,g,b,a] in design units (0..64)
  let col = full || roundRect(x, y, 0, 0, 64, 64, 15) <= 0 ? [...BG, 1] : [0, 0, 0, 0]
  const over = (c, a) => {
    if (a <= 0) return
    col = [c[0] * a + col[0] * (1 - a), c[1] * a + col[1] * (1 - a), c[2] * a + col[2] * (1 - a), Math.max(col[3], a)]
  }
  let d = Infinity
  for (const [[ax, ay], [bx, by]] of ARCH_LINES) d = Math.min(d, segDist(x, y, ax, ay, bx, by))
  if (d <= 2) over(BRASS, 1)
  ;[[31, 1], [38, 0.85], [45, 0.7]].forEach(([top, a]) => {
    if (roundRect(x, y, 24, top, 16, 4, 2) <= 0) over(PAPER, a)
  })
  return col
}

function png(size, { maskable = false } = {}) {
  const S = 4
  const raw = Buffer.alloc((size * 4 + 1) * size)
  // maskable icons: full-bleed background, artwork inside the 80 % safe zone
  const scale = maskable ? 64 / (size * 0.8) : 64 / size
  const off = maskable ? (size * 0.1) : 0
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const X = (px + (sx + 0.5) / S - off) * scale
          const Y = (py + (sy + 0.5) / S - off) * scale
          const c = maskable && (X < 0 || Y < 0 || X > 64 || Y > 64) ? [...BG, 1] : shade(X, Y, maskable)
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]
        }
      const i = py * (size * 4 + 1) + 1 + px * 4
      const n = S * S
      raw[i] = a ? Math.round(r / a) : 0
      raw[i + 1] = a ? Math.round(g / a) : 0
      raw[i + 2] = a ? Math.round(b / a) : 0
      raw[i + 3] = Math.round((a / n) * 255)
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

writeFileSync('public/icon-192.png', png(192))
writeFileSync('public/icon-512.png', png(512))
writeFileSync('public/icon-maskable-512.png', png(512, { maskable: true }))
writeFileSync('public/apple-touch-icon.png', png(180, { maskable: true }))
console.log('icons written')
