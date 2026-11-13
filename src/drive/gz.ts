// gzip in and out (the changesets and snapshots in Drive are compressed JSON)
export async function gzipText(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' })
}

export async function gunzipText(blob: Blob): Promise<string> {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()
}

/** a gzipped file of lines, read one line at a time (a whole archive never sits in memory as one
 *  string; a very long line is gathered without being split again and again) */
export async function* gzipLines(blob: Blob): AsyncGenerator<string> {
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader()
  let rest: string[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const cut = value.lastIndexOf('\n')
    if (cut < 0) {
      rest.push(value)
      continue
    }
    const block = rest.join('') + value.slice(0, cut)
    rest = [value.slice(cut + 1)]
    for (const line of block.split('\n')) if (line) yield line
  }
  const last = rest.join('')
  if (last.trim()) yield last
}

/** lines produced on demand → one gzipped Blob */
export async function gzipStream(next: () => Promise<string | null>): Promise<Blob> {
  const enc = new TextEncoder()
  const source = new ReadableStream<BufferSource>({
    // (a pull that enqueues nothing is not called again: keep going until there is something)
    async pull(ctrl) {
      for (;;) {
        const chunk = await next()
        if (chunk === null) return ctrl.close()
        if (chunk) return ctrl.enqueue(enc.encode(chunk))
      }
    },
  })
  return new Blob([await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()], { type: 'application/gzip' })
}
