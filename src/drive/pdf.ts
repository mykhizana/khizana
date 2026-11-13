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

export function jpegPdf(pages: Uint8Array[], title = ''): Blob {
  const enc = new TextEncoder()
  const parts: (Uint8Array | string)[] = []
  const offsets: number[] = []
  let size = 0
  const add = (x: Uint8Array | string) => {
    parts.push(x)
    size += typeof x === 'string' ? enc.encode(x).length : x.length
  }
  const obj = (n: number, body: string) => {
    offsets[n] = size
    add(`${n} 0 obj\n${body}\nendobj\n`)
  }
  add('%PDF-1.4\n')
  add(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])) // the «binary file» marker
  const usable = pages.map((b) => ({ b, info: jpegInfo(b) })).filter((p) => p.info)
  // 1 catalog, 2 pages, 3 info, then 3 objects per page (page, content, image)
  const kids = usable.map((_, i) => `${4 + i * 3} 0 R`).join(' ')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${usable.length} >>`)
  obj(3, `<< /Producer (Khizana) /Title <FEFF${utf16hex(title)}> >>`)
  usable.forEach(({ b, info }, i) => {
    const n = 4 + i * 3
    // a scan is about 200 dpi: the page keeps the paper's real size
    const w = Math.max(1, Math.round((info!.width * 72) / 200))
    const h = Math.max(1, Math.round((info!.height * 72) / 200))
    const space = info!.channels === 1 ? '/DeviceGray' : info!.channels === 4 ? '/DeviceCMYK' : '/DeviceRGB'
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`)
    obj(n + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    offsets[n + 2] = size
    add(`${n + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info!.width} /Height ${info!.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${info!.channels === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} /Length ${b.length} >>\nstream\n`)
    add(b)
    add('\nendstream\nendobj\n')
  })
  const count = 4 + usable.length * 3
  const xref = size
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let n = 1; n < count; n++) table += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`
  add(table)
  add(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
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
