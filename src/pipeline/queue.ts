// The background worker: documents waiting to be read/understood are processed two at a time,
// resumed when the app opens again, paused on the monthly cap or without internet.
// Which Claude reads each one (src/ai/models.ts): Opus 5.5, or Sonnet 5.5 at half the price for a big
// import (setting «reading_mode»: auto / opus / sonnet). A document the owner asks to read again: Opus.
// Only ONE tab works (a browser lock), and each document is claimed in the database first,
// so two tabs or two devices never pay twice for the same document.
import { api } from '@/db/api'
import { economyWave, pickModel, readingMode, type ReadingMode } from '@/ai/models'
import { AiError, BudgetError, resetBudgetCache } from '@/ai/transport'
import { textHash } from '@/lib/hash'
import type { Doc } from '@/lib/types'
import { processDoc } from './process'

export type Job = { id: string; title: string; state: string; detail?: string; ratio?: number; model?: string }
export type QueueSnapshot = {
  running: Job[]
  pending: number
  paused: null | 'budget' | 'network' | 'manual'
  message: string | null
  lastDone: number
  leader: boolean
  /** new documents are read by Sonnet 5.5 (a big import in «auto», or the «Sonnet» setting) */
  economy: boolean
  /** documents that failed three times (their reason is on their page) */
  failed: string[]
  /** waiting documents another device added: that device reads them (unless the owner says «here») */
  foreign: string[]
}

const CONCURRENCY = 2
const WORKER = `w-${crypto.randomUUID().slice(0, 8)}`

class Queue {
  private running = new Map<string, Job>()
  private listeners = new Set<() => void>()
  private snap: QueueSnapshot = { running: [], pending: 0, paused: null, message: null, lastDone: 0, leader: false, economy: false, failed: [], foreign: [] }
  private kicking = false
  private again = false
  private failures = new Map<string, number>()
  private cooldown = new Map<string, number>()
  private leader = typeof navigator === 'undefined' || !('locks' in navigator)
  private mode: ReadingMode = 'auto'
  private modeAt = 0
  /** «auto»: the current import is big, Sonnet reads it until the line is empty */
  private wave = false
  /** documents the owner asked to read again: Opus, whatever the setting */
  private opusFor = new Set<string>()
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
    // another device's documents are read there (sync may lag for hours): never taken over silently
    const mine = pending.filter((p) => !p.foreign)
    const waiting = mine.filter((p) => p.state !== 'error').length
    if (Date.now() - this.modeAt > 15_000) {
      try {
        this.mode = readingMode((await api.settings())?.reading_mode)
        this.modeAt = Date.now()
      } catch {
        /* keep the last one */
      }
    }
    this.wave = economyWave({ mode: this.mode, wave: this.wave, busy: waiting + this.running.size })
    this.emit({
      pending: waiting,
      economy: this.mode === 'sonnet' || this.wave,
      failed: pending.filter((p) => p.state === 'error').map((p) => p.id),
      foreign: pending.filter((p) => p.foreign && p.state !== 'error').map((p) => p.id),
    })
    if (this.snap.paused || !this.leader) return
    const now = Date.now()
    for (const p of mine) {
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
    const model = pickModel({ mode: this.mode, wave: this.wave, opus: this.opusFor.has(id) })
    this.running.set(id, { id, title, state: 'new', model })
    this.emit()
    const report = (state: string, detail?: string, ratio?: number) => {
      this.running.set(id, { id, title, state, detail, ratio, model })
      this.emit()
    }
    processDoc(id, report, model)
      .then(() => {
        this.opusFor.delete(id)
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

  /** put documents back in line (after an error, a new key, or «read again»); `opus`: the owner asked for this one */
  async retry(ids: string[], opts: { opus?: boolean } = {}) {
    for (const id of ids) {
      this.failures.delete(id)
      this.cooldown.delete(id)
      if (opts.opus) this.opusFor.add(id)
      await api.setState(id, 'new', null)
    }
    this.modeAt = 0
    this.resume()
  }

  /** «اقرأها هنا»: documents another device added are read by this one (a local change makes them its own) */
  async readHere(ids: string[]) {
    const mark = `هنا · ${Date.now()}`
    for (const id of ids) {
      this.failures.delete(id)
      this.cooldown.delete(id)
      await api.setState(id, 'new', mark)
    }
    this.resume()
  }

  /**
   * «Read the pages again with Opus»: the pages Claude read from images are read once more (their
   * present text stays, and stays searchable, until the new reading replaces it), then the document is
   * understood again. The owner's corrections are kept.
   */
  async rereadWithOpus(d: Doc) {
    const pages = []
    for (const p of d.pages.filter((x) => x.text_source === 'ocr'))
      pages.push({ page_no: p.page_no, text: p.text, text_source: 'reocr', text_hash: await textHash(p.text), legibility: p.legibility ?? undefined, blank: p.blank })
    if (pages.length) await api.setText({ id: d.id, pages, text_hash: null, text_chars: d.text_chars, minhash: null, lsh: null, needs_ocr: true })
    await this.retry([d.id], { opus: true })
  }
}

export const queue = new Queue()

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (queue.getSnapshot().paused === 'network') queue.resume()
  })
}
