// The safety net for structured outputs. If the API ever refuses to compile an answer schema
// («The compiled grammar is too large», «Schema is too complex for compilation»), the same request
// is sent once more without `output_config.format`: the schema is then written into the
// instructions, Claude answers with plain JSON, and the app reads it tolerantly (the normalizers
// check every value afterwards). Pure functions: the transport uses them, the tests check them.
import type { AiParams } from './transport'

/** the API's words when it will not compile a schema */
export const GRAMMAR_REFUSED = /compiled grammar is too large|too complex for compilation|schema is too complex/i

/** the same request, with the schema moved from `output_config.format` into the instructions */
export function looseParams(params: AiParams): AiParams {
  const format = params.output_config.format
  if (!format) return params
  const rule =
    'Return ONLY one JSON object: no text before or after it, no code fences. ' +
    'It must follow this JSON schema exactly, with every property present:\n' +
    JSON.stringify(format.schema)
  const system = typeof params.system === 'string' ? `${params.system}\n\n${rule}` : [...params.system, { type: 'text' as const, text: rule }]
  return { ...params, system, output_config: params.output_config.effort ? { effort: params.output_config.effort } : {} }
}

/** JSON from an answer that may carry code fences or a sentence around it */
export function parseLooseJson(text: string): unknown {
  const t = text.trim()
  try {
    return JSON.parse(t)
  } catch {
    /* try harder */
  }
  const unfenced = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(unfenced)
  } catch {
    /* the outermost object */
  }
  const a = unfenced.indexOf('{')
  const b = unfenced.lastIndexOf('}')
  if (a >= 0 && b > a) return JSON.parse(unfenced.slice(a, b + 1))
  throw new SyntaxError('no JSON object in the answer')
}
