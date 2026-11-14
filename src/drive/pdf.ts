// Scanned pages (JPEG) → one PDF, for the readable copy of a scanned document in Drive.
// The JPEG bytes go into the PDF as they are (no re-compression, no quality loss).

/** width, height and colour channels from the JPEG header (SOF marker) */
export function jpegInfo(b: Uint8Array): { width: number; height: number; channels: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = (b[i + 2] << 8) | b[i + 3]
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], channels: b[i + 9] }
    }
    i += 2 + len
  }
  return null
}

/** A4 in PDF points */
const A4 = { w: 595.28, h: 841.89 }

/**
 * JPEG pages → one PDF. By default each page keeps the paper's real size (a scan is about 200 dpi).
 * `a4`: every page is an A4 sheet (turned when the picture is wider than tall) with the picture fitted
 * in it, for a dossier that prints evenly. `numbers`: «3 / 12» at the foot of each page.
 */
export function jpegPdf(pages: Uint8Array[], title = '', opts: { a4?: boolean; numbers?: boolean } = {}): Blob {
  const enc = new TextEncoder()
  const parts: (Uint8Array | string)[] = []
  const offsets: number[] = []
  let size = 0
  const NL = '\n'
  const add = (x: Uint8Array | string) => {
    parts.push(x)
    size += typeof x === 'string' ? enc.encode(x).length : x.length
  }
  const obj = (n: number, body: string) => {
    offsets[n] = size
    add(`${n} 0 obj${NL}${body}${NL}endobj${NL}`)
  }
  add(`%PDF-1.4${NL}`)
  add(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])) // the «binary file» marker
  const usable = pages.map((b) => ({ b, info: jpegInfo(b) })).filter((p) => p.info)
  // 1 catalog, 2 pages, 3 info, then 3 objects per page (page, content, image), then the font
  const kids = usable.map((_, i) => `${4 + i * 3} 0 R`).join(' ')
  const font = 4 + usable.length * 3
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${usable.length} >>`)
  obj(3, `<< /Producer (Khizana) /Title <FEFF${utf16hex(title)}> >>`)
  const r2 = (x: number) => Math.round(x * 100) / 100
  usable.forEach(({ b, info }, i) => {
    const n = 4 + i * 3
    let w: number
    let h: number
    let draw: string
    if (opts.a4) {
      const wide = info!.width > info!.height
      w = wide ? A4.h : A4.w
      h = wide ? A4.w : A4.h
      // room for the page number; the picture keeps its proportions, centred
      const m = opts.numbers ? 22 : 0
      const s = Math.min(w / info!.width, (h - m * 2) / info!.height)
      const iw = info!.width * s
      const ih = info!.height * s
      draw = `q ${r2(iw)} 0 0 ${r2(ih)} ${r2((w - iw) / 2)} ${r2((h - ih) / 2)} cm /Im0 Do Q`
    } else {
      // a scan is about 200 dpi: the page keeps the paper's real size
      w = Math.max(1, Math.round((info!.width * 72) / 200))
      h = Math.max(1, Math.round((info!.height * 72) / 200))
      draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`
    }
    const label = `${i + 1} / ${usable.length}`
    const content = opts.numbers ? `${draw}${NL}BT /F1 8 Tf 0.45 g ${r2(w / 2 - label.length * 2.2)} 9 Td (${label}) Tj ET` : draw
    const space = info!.channels === 1 ? '/DeviceGray' : info!.channels === 4 ? '/DeviceCMYK' : '/DeviceRGB'
    const fonts = opts.numbers ? ` /Font << /F1 ${font} 0 R >>` : ''
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${r2(w)} ${r2(h)}] /Resources << /XObject << /Im0 ${n + 2} 0 R >>${fonts} >> /Contents ${n + 1} 0 R >>`)
    obj(n + 1, `<< /Length ${content.length} >>${NL}stream${NL}${content}${NL}endstream`)
    offsets[n + 2] = size
    const decode = info!.channels === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''
    add(`${n + 2} 0 obj${NL}<< /Type /XObject /Subtype /Image /Width ${info!.width} /Height ${info!.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${decode} /Length ${b.length} >>${NL}stream${NL}`)
    add(b)
    add(`${NL}endstream${NL}endobj${NL}`)
  })
  if (opts.numbers) obj(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const count = font + (opts.numbers ? 1 : 0)
  const xref = size
  let table = `xref${NL}0 ${count}${NL}0000000000 65535 f ${NL}`
  for (let n = 1; n < count; n++) table += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n ${NL}`
  add(table)
  add(`trailer${NL}<< /Size ${count} /Root 1 0 R /Info 3 0 R >>${NL}startxref${NL}${xref}${NL}%%EOF${NL}`)
  return new Blob(parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p)) as BlobPart[], { type: 'application/pdf' })
}

function utf16hex(s: string) {
  let out = ''
  for (const ch of s.slice(0, 200)) {
    const c = ch.codePointAt(0)!
    if (c > 0xffff) {
      const v = c - 0x10000
      out += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0')
    } else out += c.toString(16).padStart(4, '0')
  }
  return out
}
