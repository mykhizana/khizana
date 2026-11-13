// The background worker: documents waiting to be read/understood are processed two at a time,
// resumed when the app opens again, paused on the monthly cap or without internet.
// Only ONE tab works (a browser lock), and each document is claimed in the database first,
// so two tabs or two devices never pay twice for the same document.
import { api } from '@/db/api'
import { AiError, BudgetError, resetBudgetCache } from '@/ai/transport'
import { processDoc } from './process'

export type Job = { id: string; title: string; state: string; detail?: string; ratio?: number }
export type QueueSnapshot = { running: Job[]; pending: number; paused: null | 'budget' | 'network' | 'manual'; message: string | null; lastDone: number; leader: boolean }

const CONCURRENCY = 2
const WORKER = `w-${crypto.randomUUID().slice(0, 8)}`

class Queue {
  private running = new Map<string, Job>()
  private listeners = new Set<() => void>()
  private snap: QueueSnapshot = { running: [], pending: 0, paused: null, message: null, lastDone: 0, leader: false }
  private kicking = false
  private again = false
  private failures = new Map<string, number>()
  private cooldown = new Map<string, number>()
  private leader = typeof navigator === 'undefined' || !('locks' in navigator)
  onDocDone: (id: string) => void = () => {}

  constructor() {
    // the first open tab becomes the worker; another tab takes over when it closes
    if (!this.leader && typeof navigator !== 'undefined') {
      void navigator.locks.request('khizana-worker', () => {
        this.leader = true
        this.emit({ leader: true })
        this.kick()
        return new Promise<void>(() => {}) // held for the life of this tab
      })
    } else this.snap.leader = true
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getSnapshot = () => this.snap

  private emit(patch: Partial<QueueSnapshot> = {}) {
    this.snap = { ...this.snap, ...patch, running: [...this.running.values()] }
    this.listeners.forEach((f) => f())
  }

  pause(reason: QueueSnapshot['paused'], message: string | null = null) {
    this.emit({ paused: reason, message })
  }

  resume() {
    resetBudgetCache()
    this.emit({ paused: null, message: null })
    this.kick()
  }

  kick = () => {
    if (this.kicking) {
      this.again = true
      return
    }
    this.kicking = true
    void this.fill().finally(() => {
      this.kicking = false
      if (this.again) {
        this.again = false
        this.kick()
      }
    })
  }

  private async fill() {
    let pending: Awaited<ReturnType<typeof api.pending>>
    try {
      pending = await api.pending()
    } catch {
      return
    }
    this.emit({ pending: pending.filter((p) => p.state !== 'error').length })
    if (this.snap.paused || !this.leader) return
    const now = Date.now()
    for (const p of pending) {
      if (this.running.size >= CONCURRENCY || this.snap.paused) break
      if (this.running.has(p.id) || p.state === 'error') continue
      if ((this.failures.get(p.id) ?? 0) >= 3) continue
      if ((this.cooldown.get(p.id) ?? 0) > now) continue
      // claim it in the database: another device may already be on it
      const claimed = await api.claim(p.id, WORKER).catch(() => ({ ok: false }))
      if (!claimed.ok) continue
      this.start(p.id, p.title)
    }
    // a document resting after a rate limit is picked up again once its rest is over
    const next = Math.min(...[...this.cooldown.values()].filter((t) => t > now))
    if (Number.isFinite(next)) setTimeout(this.kick, next - now + 50)
  }

  private start(id: string, title: string) {
    this.running.set(id, { id, title, state: 'new' })
    this.emit()
    const report = (state: string, detail?: string, ratio?: number) => {
      this.running.set(id, { id, title, state, detail, ratio })
      this.emit()
    }
    processDoc(id, report)
      .then(() => {
        this.failures.delete(id)
        this.cooldown.delete(id)
        this.emit({ lastDone: Date.now() })
      })
      .catch(async (e: unknown) => {
        if (e instanceof BudgetError) {
          await api.setState(id, 'waiting', 'budget').catch(() => undefined)
          this.pause('budget', e.message)
        } else if (e instanceof AiError && (e.kind === 'network' || e.kind === 'rate')) {
          await api.setState(id, 'waiting', e.kind).catch(() => undefined)
          if (e.kind === 'network') this.pause('network', 'لا اتصال بالإنترنت — تستأنف المعالجة عند عودته')
          else this.cooldown.set(id, Date.now() + 30_000)
        } else if (e instanceof AiError && e.kind === 'credit') {
          await api.setState(id, 'waiting', 'credit').catch(() => undefined)
          this.pause('budget', e.message)
        } else if (e instanceof AiError && e.kind === 'files') {
          // its page images are still on the other device (not in Drive yet): later
          await api.setState(id, 'waiting', 'files').catch(() => undefined)
          this.cooldown.set(id, Date.now() + 5 * 60_000)
        } else if (e instanceof AiError && e.kind === 'auth') {
          await api.setState(id, 'waiting', 'auth').catch(() => undefined)
          this.pause('manual', e.message)
        } else {
          const n = (this.failures.get(id) ?? 0) + 1
          this.failures.set(id, n)
          await api.setState(id, n >= 3 ? 'error' : 'new', String((e as Error)?.message ?? e).slice(0, 300)).catch(() => undefined)
        }
      })
      .finally(() => {
        this.running.delete(id)
        this.emit()
        this.onDocDone(id)
        this.kick()
      })
  }

  /** put documents back in line (after an error, a new key, or «read again») */
  async retry(ids: string[]) {
    for (const id of ids) {
      this.failures.delete(id)
      this.cooldown.delete(id)
      await api.setState(id, 'new', null)
    }
    this.resume()
  }
}

export const queue = new Queue()

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (queue.getSnapshot().paused === 'network') queue.resume()
  })
}
