// Supabase Edge Function «kh-ai» — the only place that holds the Claude key in cloud mode.
// The signed-in OWNER sends the request prepared by the app; this function checks who is calling,
// applies the monthly cap, calls Claude Opus 5.5, writes the usage row (cost) and returns the answer.
// Secrets (Dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY      the Claude key
//   KH_OWNER_EMAILS        who may use it, e.g. "me@example.com" (comma-separated). Nobody else — even a
//                          signed-up account — can spend the key. Without it the function refuses everyone.
//   KH_MAX_MONTHLY_USD     optional hard ceiling for the monthly cap (default 100)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const MODEL = 'claude-opus-5-5'
// the app may ask for Sonnet 5.5 (half the price) for a big import; nothing else
const MODELS = new Set([MODEL, 'claude-sonnet-5-5'])
const OPS = new Set(['transcribe', 'understand', 'split', 'judge', 'query', 'ask', 'plan', 'bib', 'test'])
const MAX_TOKENS: Record<string, number> = { transcribe: 32000, understand: 16000, split: 8000, judge: 6000, query: 3000, ask: 8000, plan: 12000, bib: 4000, test: 2000 }

// $ per million tokens; cache writes (5 min) = 1.25 × input
const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
}
function cost(model: string, u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(k + '-')) ?? MODEL
  const p = PRICES[key]
  return ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.in * 1.25) / 1e6
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  // who is calling (the gateway already verified the JWT)
  const auth = req.headers.get('Authorization') ?? ''
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData.user) return json({ error: 'سجّل الدخول' }, 401)
  const uid = userData.user.id
  const owners = (Deno.env.get('KH_OWNER_EMAILS') ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  if (!owners.length) return json({ error: 'أضف KH_OWNER_EMAILS في أسرار الدالة' }, 403)
  if (!owners.includes((userData.user.email ?? '').toLowerCase())) return json({ error: 'هذا الحساب غير مخوّل' }, 403)

  let body: { op?: string; document_id?: string; params?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad json' }, 400)
  }
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (body.op === 'status') return json({ configured: !!key, model: MODEL })
  if (!key) return json({ error: 'مفتاح Claude غير مضاف في أسرار الدالة' }, 503)
  const op = String(body.op ?? '')
  if (!OPS.has(op) || !body.params) return json({ error: 'unknown operation' }, 400)

  // the monthly cap, read with the owner's own rights
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const [{ data: rows }, { data: capRow }] = await Promise.all([
    admin.from('kh_ai_usage').select('cost_usd').eq('owner_id', uid).gte('at', monthStart.toISOString()),
    admin.from('kh_settings').select('value').eq('owner_id', uid).eq('key', 'monthly_cap_usd').maybeSingle(),
  ])
  const spent = (rows ?? []).reduce((s, r: { cost_usd: number | string }) => s + Math.max(0, Number(r.cost_usd) || 0), 0)
  // the owner's cap, never above the server ceiling; 0, negative or nonsense means «the ceiling»
  const ceiling = Math.max(1, Number(Deno.env.get('KH_MAX_MONTHLY_USD') ?? 100) || 100)
  const asked = Number(capRow?.value)
  const cap = Number.isFinite(asked) && asked > 0 ? Math.min(asked, ceiling) : ceiling
  if (spent >= cap) return json({ error: 'بلغت السقف الشهري', spent, cap }, 402)

  // only what the app is allowed to ask: our models, our token ceilings, no tools
  const p = body.params as Record<string, unknown>
  const model = MODELS.has(String(body.model)) ? String(body.model) : MODEL
  const params = {
    model,
    system: p.system,
    messages: p.messages,
    max_tokens: Math.min(Number(p.max_tokens) || 4000, MAX_TOKENS[op]),
    output_config: p.output_config,
    // «اسأل خزانتك»: the app's own tools (search and read run in the browser, not here)
    ...((op === 'ask' || op === 'plan') && Array.isArray(p.tools) ? { tools: p.tools, ...(p.tool_choice ? { tool_choice: p.tool_choice } : {}) } : {}),
    // Opus: a declined request is retried on the server's default fallback; a Sonnet refusal goes back to the app, which asks Opus
    ...(model.startsWith('claude-opus') ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  }

  const client = new Anthropic({ apiKey: key, maxRetries: 4, timeout: 9 * 60 * 1000 })
  let message
  try {
    // streaming avoids timeouts on long transcriptions; we only need the final message
    message = await client.beta.messages.stream(params as Parameters<typeof client.beta.messages.stream>[0]).finalMessage()
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'rate limited' }, 429)
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'مفتاح Claude غير صالح' }, 502)
    if (e instanceof Anthropic.APIError) return json({ error: e.message }, 502)
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }

  const usd = cost(message.model, message.usage)
  await admin.from('kh_ai_usage').insert({
    owner_id: uid,
    op,
    model: message.model,
    document_id: /^[0-9a-f-]{36}$/i.test(String(body.document_id ?? '')) ? body.document_id : null,
    input_tokens: message.usage.input_tokens ?? 0,
    output_tokens: message.usage.output_tokens ?? 0,
    cache_read_tokens: message.usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: message.usage.cache_creation_input_tokens ?? 0,
    cost_usd: usd,
  })
  return json({ message, cost_usd: usd })
})
