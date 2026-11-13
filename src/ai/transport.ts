// How a request reaches Claude:
//  • device mode: straight from this browser with the owner's own API key (kept only on this device);
//  • cloud mode: through the «kh-ai» Supabase function, which holds the key and writes the usage.
// Both apply the monthly cap before spending anything.
import { api } from '@/db/api'
import { idb } from '@/db/idb'
import { MODE, MODEL, SUPABASE_URL } from '@/lib/config'
import { costOf, type Usage } from '@/lib/cost'

export class BudgetError extends Error {
  spent: number
  cap: number
  constructor(spent: number, cap: number) {
    super(`بلغت تكلفة هذا الشهر ${spent.toFixed(2)}$ من سقف ${cap}$`)
    this.spent = spent
    this.cap = cap
  }
}

export type AiErrorKind = 'refusal' | 'truncated' | 'network' | 'auth' | 'rate' | 'server' | 'parse' | 'credit' | 'files' | 'other'
export class AiError extends Error {
  kind: AiErrorKind
  constructor(message: string, kind: AiErrorKind) {
    super(message)
    this.kind = kind
  }
}

export type AiParams = {
  system: string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
  messages: { role: 'user' | 'assistant'; content: unknown }[]
  max_tokens: number
  output_config: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; format?: { type: 'json_schema'; schema: unknown } }
}

export type SendResult<T> = { data: T; model: string; usage: Usage; costUsd: number }

// ------------------------------------------------------------------ the owner's key (device mode)
const KEY = 'anthropic_key'
export const getLocalKey = async () => (await idb.get<string>('kv', KEY).catch(() => undefined)) ?? null
export async function setLocalKey(k: string | null) {
  if (k) await idb.set('kv', KEY, k.trim())
  else await idb.del('kv', KEY)
  statusCache = null
}

// ------------------------------------------------------------------ is real AI available?
let statusCache: { at: number; mode: 'claude' | 'demo' } | null = null
export async function aiMode(): Promise<'claude' | 'demo'> {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.mode
  let mode: 'claude' | 'demo' = 'demo'
  if (MODE === 'local') mode = (await getLocalKey()) ? 'claude' : 'demo'
  else {
    try {
      const r = await invoke<{ configured: boolean }>({ op: 'status' })
      mode = r.configured ? 'claude' : 'demo'
    } catch {
      mode = 'demo'
    }
  }
  statusCache = { at: Date.now(), mode }
  return mode
}
export const resetAiStatus = () => {
  statusCache = null
}

// ------------------------------------------------------------------ the monthly cap
let spend: { at: number; cost: number; cap: number } | null = null
async function checkBudget(estimate: number) {
  if (!spend || Date.now() - spend.at > 30_000) {
    const u = await api.usage()
    spend = { at: Date.now(), cost: Number(u.month_cost) || 0, cap: Number(u.cap) || 0 }
  }
  if (spend.cap > 0 && spend.cost + estimate > spend.cap) throw new BudgetError(spend.cost, spend.cap)
}
export const resetBudgetCache = () => {
  spend = null
}

// ------------------------------------------------------------------ cloud function call
async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { supabase } = await import('@/db/cloud')
  const { data: s } = await supabase().auth.getSession()
  const token = s.session?.access_token
  if (!token) throw new AiError('سجّل الدخول أولاً', 'auth')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kh-ai`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', apikey: (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 402) throw new BudgetError(Number(json.spent) || 0, Number(json.cap) || 0)
    throw new AiError(json.error || `خطأ في خدمة الذكاء الاصطناعي (${res.status})`, res.status === 401 ? 'auth' : res.status === 429 ? 'rate' : 'server')
  }
  return json as T
}

// ------------------------------------------------------------------ one request
type Msg = { content: { type: string; text?: string }[]; model: string; usage: Usage; stop_reason: string | null; stop_details?: { explanation?: string | null } | null }

export async function send<T>(op: string, params: AiParams, opts: { documentId?: string; estimate: number }): Promise<SendResult<T>> {
  await checkBudget(opts.estimate)
  let msg: Msg
  if (MODE === 'cloud') {
    const r = await invoke<{ message: Msg; cost_usd: number }>({ op, document_id: opts.documentId, params })
    msg = r.message
  } else {
    const key = await getLocalKey()
    if (!key) throw new AiError('لم يُضف مفتاح Claude بعد', 'auth')
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 4, timeout: 10 * 60 * 1000 })
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        ...(params as object),
        // a policy decline is retried automatically on the server's default fallback model
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as Parameters<typeof client.beta.messages.stream>[0])
      msg = (await stream.finalMessage()) as unknown as Msg
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new AiError('مفتاح Claude غير صالح', 'auth')
      if (e instanceof Anthropic.PermissionDeniedError) throw new AiError('المفتاح لا يملك صلاحية هذا النموذج', 'auth')
      if (e instanceof Anthropic.RateLimitError) throw new AiError('ضغط مؤقت على الخدمة، سيُعاد المحاولة', 'rate')
      if (e instanceof Anthropic.APIConnectionError) throw new AiError('لا اتصال بالإنترنت', 'network')
      // the API credit ran out (the monthly credit of the owner's plan, or the balance)
      if (e instanceof Anthropic.APIError && /credit balance|billing|purchase credits/i.test(e.message))
        throw new AiError('نفد رصيد Claude API في حسابك: تتوقف المعالجة حتى يتجدد الرصيد أو تضيف رصيداً في console.anthropic.com', 'credit')
      if (e instanceof Anthropic.BadRequestError) throw new AiError(`طلب مرفوض: ${e.message.slice(0, 160)}`, 'other')
      if (e instanceof Anthropic.APIError) throw new AiError(`خطأ في الخدمة: ${e.message.slice(0, 160)}`, 'server')
      throw e
    }
    const cost = costOf(msg.model, msg.usage)
    await api
      .usageAdd({
        op,
        model: msg.model,
        document_id: opts.documentId,
        input_tokens: msg.usage.input_tokens ?? 0,
        output_tokens: msg.usage.output_tokens ?? 0,
        cache_read_tokens: msg.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: msg.usage.cache_creation_input_tokens ?? 0,
        cost_usd: cost,
      })
      .catch(() => undefined)
  }
  const costUsd = costOf(msg.model, msg.usage)
  if (spend) spend.cost += costUsd
  if (msg.stop_reason === 'refusal') throw new AiError(msg.stop_details?.explanation || 'رفض النموذج معالجة هذه الوثيقة', 'refusal')
  if (msg.stop_reason === 'max_tokens') throw new AiError('الجواب أطول من المسموح', 'truncated')
  const text = msg.content.find((b) => b.type === 'text')?.text ?? ''
  let data: T
  try {
    data = JSON.parse(text) as T
  } catch {
    throw new AiError('جواب غير مفهوم من النموذج', 'parse')
  }
  return { data, model: msg.model, usage: msg.usage, costUsd }
}

/** a tiny request to check the key / the function (costs a fraction of a cent) */
export async function testAi(): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    const r = await send<{ ok: boolean }>(
      'test',
      {
        system: 'Reply with the JSON {"ok": true}.',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 2000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } } },
      },
      { estimate: 0.01 },
    )
    resetAiStatus()
    return { ok: r.data.ok === true, model: r.model }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
