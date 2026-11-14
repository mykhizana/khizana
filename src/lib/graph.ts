// The placement of the map of relations: a force-directed layout (Fruchterman–Reingold) — points that
// share documents pull together, all points push apart. Groups that share nothing (the papers of Spain,
// those of the university…) are laid out each on its own, then set side by side, so none is squeezed
// into a corner. No randomness: the same map always gets the same picture. Pure (the tests run it).
export type GNode = { id: string; count: number }
export type GEdge = { s: string; t: string; w: number }
export type Pos = { x: number; y: number }

function layoutOne(nodes: GNode[], edges: GEdge[], o: { size?: number; iterations?: number; margin?: number } = {}): Map<string, Pos> {
  const size = o.size ?? 1000
  const margin = o.margin ?? size * 0.06
  const n = nodes.length
  const out = new Map<string, Pos>()
  if (!n) return out
  if (n === 1) {
    out.set(nodes[0].id, { x: size / 2, y: size / 2 })
    return out
  }
  const idx = new Map(nodes.map((v, i) => [v.id, i]))
  // start on a golden-angle spiral, the biggest in the middle
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[b].count - nodes[a].count || (nodes[a].id < nodes[b].id ? -1 : 1))
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  order.forEach((i, r) => {
    const a = r * 2.399963229728653
    const rad = (Math.sqrt(r + 0.5) / Math.sqrt(n)) * size * 0.45
    x[i] = size / 2 + rad * Math.cos(a)
    y[i] = size / 2 + rad * Math.sin(a)
  })
  const E: [number, number, number][] = []
  for (const e of edges) {
    const a = idx.get(e.s)
    const b = idx.get(e.t)
    if (a !== undefined && b !== undefined && a !== b) E.push([a, b, 1 + Math.log2(1 + Math.max(1, e.w))])
  }
  const k = Math.sqrt((size * size) / n) * 0.7
  const iters = o.iterations ?? Math.min(500, 150 + 5 * n)
  let temp = size / 10
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  const c = size / 2
  for (let it = 0; it < iters; it++) {
    dx.fill(0)
    dy.fill(0)
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j]
        let ey = y[i] - y[j]
        let d2 = ex * ex + ey * ey
        if (d2 < 1e-4) {
          // two points on top of each other: part them the same way every time
          ex = ((i * 31 + j * 17) % 7) - 3 || 1
          ey = ((i * 13 + j * 29) % 5) - 2 || 1
          d2 = ex * ex + ey * ey
        }
        const f = (k * k) / d2
        dx[i] += ex * f
        dy[i] += ey * f
        dx[j] -= ex * f
        dy[j] -= ey * f
      }
    for (const [a, b, w] of E) {
      const ex = x[a] - x[b]
      const ey = y[a] - y[b]
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01
      const f = (d / k) * w
      dx[a] -= ex * f
      dy[a] -= ey * f
      dx[b] += ex * f
      dy[b] += ey * f
    }
    for (let i = 0; i < n; i++) {
      dx[i] += (c - x[i]) * 0.04
      dy[i] += (c - y[i]) * 0.04
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i])
      if (d > 0) {
        const m = Math.min(d, temp)
        x[i] += (dx[i] / d) * m
        y[i] += (dy[i] / d) * m
      }
    }
    temp = Math.max(temp * 0.975, size / 500)
  }
  // fitted into the square, keeping the proportions
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x[i])
    maxX = Math.max(maxX, x[i])
    minY = Math.min(minY, y[i])
    maxY = Math.max(maxY, y[i])
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6)
  const s = (size - 2 * margin) / span
  const ox = (size - (maxX - minX) * s) / 2
  const oy = (size - (maxY - minY) * s) / 2
  nodes.forEach((v, i) => out.set(v.id, { x: ox + (x[i] - minX) * s, y: oy + (y[i] - minY) * s }))
  return out
}

/** the whole map: each group laid out alone, the groups packed in rows (the biggest first), fitted to the square */
export function layout(nodes: GNode[], edges: GEdge[], o: { size?: number; iterations?: number; margin?: number } = {}): Map<string, Pos> {
  const size = o.size ?? 1000
  const margin = o.margin ?? size * 0.06
  const out = new Map<string, Pos>()
  if (!nodes.length) return out
  // the groups (connected parts)
  const parent = new Map(nodes.map((v) => [v.id, v.id]))
  const root = (id: string): string => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(id, r)
    return r
  }
  for (const e of edges) if (parent.has(e.s) && parent.has(e.t)) parent.set(root(e.s), root(e.t))
  const groups = new Map<string, GNode[]>()
  for (const v of nodes) {
    const r = root(v.id)
    groups.set(r, [...(groups.get(r) ?? []), v])
  }
  if (groups.size === 1) return layoutOne(nodes, edges, o)
  const list = [...groups.values()].sort((a, b) => b.length - a.length || b.reduce((s, v) => s + v.count, 0) - a.reduce((s, v) => s + v.count, 0) || (a[0].id < b[0].id ? -1 : 1))
  // each group in a square whose area follows its number of points
  const UNIT = 100
  const width = Math.sqrt(nodes.length) * UNIT * 1.25
  const placed: { at: Pos; pos: Map<string, Pos> }[] = []
  let x = 0
  let y = 0
  let row = 0
  let maxX = 0
  for (const g of list) {
    const side = Math.sqrt(g.length) * UNIT
    if (x > 0 && x + side > width) {
      x = 0
      y += row
      row = 0
    }
    const ids = new Set(g.map((v) => v.id))
    const pos = layoutOne(
      g,
      edges.filter((e) => ids.has(e.s) && ids.has(e.t)),
      { size: side, margin: side * (g.length > 1 ? 0.12 : 0.5), iterations: o.iterations },
    )
    placed.push({ at: { x, y }, pos })
    x += side
    row = Math.max(row, side)
    maxX = Math.max(maxX, x)
  }
  const total = { w: maxX, h: y + row }
  const k = (size - 2 * margin) / Math.max(total.w, total.h)
  const ox = (size - total.w * k) / 2
  const oy = (size - total.h * k) / 2
  for (const p of placed) for (const [id, q] of p.pos) out.set(id, { x: ox + (p.at.x + q.x) * k, y: oy + (p.at.y + q.y) * k })
  return out
}

/** the neighbours of a point, the heaviest lines first */
export function neighbours(id: string, edges: GEdge[]): { id: string; w: number }[] {
  return edges
    .filter((e) => e.s === id || e.t === id)
    .map((e) => ({ id: e.s === id ? e.t : e.s, w: e.w }))
    .sort((a, b) => b.w - a.w)
}
