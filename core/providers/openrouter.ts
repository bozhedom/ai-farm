import { z } from 'zod'
import { config, isFreeOpenrouterModel } from '../config'
import { query } from '../db'
import { reportProgress, reportValidation } from '../activity'
import { schemaRepair } from './local'
import { ProviderHttpError, providerErrorDetail, readErrorBody } from './rejection'

const tokens = z.number().int().nonnegative().max(100000)
const usageSchema = z.object({
  prompt_tokens: tokens,
  completion_tokens: tokens,
  prompt_tokens_details: z
    .object({ cached_tokens: tokens.optional(), cache_write_tokens: tokens.optional() })
    .optional(),
  completion_tokens_details: z.object({ reasoning_tokens: tokens.optional() }).optional(),
  cost: z.union([z.number().nonnegative(), z.string()]),
  is_byok: z.boolean().optional(),
})

/** Convert a provider decimal to integer microdollars without floating-point accounting. */
export function openrouterCost(value: number | string) {
  const decimal = String(value)
  const parts = /^(\d{1,16})(?:\.(\d{1,20}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(decimal)
  if (!parts) throw new Error('OPENROUTER_USAGE_INVALID')
  const fraction = parts[2] || ''
  const digits = BigInt(parts[1]! + fraction)
  const power = 6 + Number(parts[3] || 0) - fraction.length
  const divisor = power < 0 ? 10n ** BigInt(-power) : 1n
  const microusd = power < 0 ? (digits + divisor - 1n) / divisor : digits * 10n ** BigInt(power)
  if (microusd > 2147483647n) throw new Error('OPENROUTER_USAGE_INVALID')
  return Number(microusd)
}

/** Reasoning and answer share this limit; only zero-price models are accepted. */
export const OPENROUTER_OUTPUT_TOKENS = 8000

type OpenrouterArgs<T> = {
  key: string
  system: string
  context: string
  schema: z.ZodType<T>
  maxTokens: number
}
type Usage = { input: number; output: number; cached: number | null; writes: number | null }
const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b)

export async function openrouterModel<T>(
  args: OpenrouterArgs<T>,
  attempt = 0,
  prior?: Usage,
): Promise<{ value: T; microusd: number; cost: number }> {
  const c = config()
  if (!c.OPENROUTER_API_KEY) throw new Error('OPENROUTER_CREDENTIALS_REQUIRED')
  if (!isFreeOpenrouterModel(c.OPENROUTER_MODEL)) throw new Error('OPENROUTER_FREE_MODEL_REQUIRED')
  if (
    !Number.isSafeInteger(args.maxTokens) ||
    args.maxTokens < 16 ||
    args.maxTokens > OPENROUTER_OUTPUT_TOKENS
  )
    throw new Error('OPENROUTER_OUTPUT_LIMIT_INVALID')
  // Explicit free routes and zero price ceilings. Never resend after an error or use a paid model.
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: c.OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.context },
      ],
      max_tokens: args.maxTokens,
      ...(c.OPENROUTER_REASONING_EFFORT
        ? { reasoning: { effort: c.OPENROUTER_REASONING_EFFORT, exclude: true } }
        : {}),
      stream: false,
      // Provider-side strict decoding made free models copy the input verbatim. The schema is in
      // the system prompt, and every answer is still parsed by the project schema below.
      response_format: { type: 'json_object' },
      provider: {
        require_parameters: true,
        allow_fallbacks: false,
        data_collection: 'deny',
        max_price: { prompt: 0, completion: 0, request: 0 },
      },
      plugins: [],
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    // Free calls keep their retry rules; only the provider's explanation is kept for the ledger.
    const body = await readErrorBody(response)
    throw new ProviderHttpError(
      `OPENROUTER_HTTP_${response.status}`,
      response.status,
      providerErrorDetail(body),
    )
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('OPENROUTER_RESPONSE_EMPTY')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 2000000) {
        await reader.cancel()
        throw new Error('PROVIDER_RESPONSE_TOO_LARGE')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  let data
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('OPENROUTER_RESPONSE_INVALID')
  }
  const usage = usageSchema.safeParse(data?.usage)
  // OpenRouter can report an upstream failure inside an HTTP 200 body without usage.
  if (!usage.success && data?.error && data?.usage == null)
    throw new Error('OPENROUTER_RESPONSE_ERROR')
  if (!usage.success) throw new Error('OPENROUTER_USAGE_INVALID')
  const { prompt_tokens: input, completion_tokens: output } = usage.data
  const cached = usage.data.prompt_tokens_details?.cached_tokens ?? null
  const writes = usage.data.prompt_tokens_details?.cache_write_tokens ?? null
  // Some free providers count reasoning outside completion_tokens. Keep that split unknown.
  const reported = usage.data.completion_tokens_details?.reasoning_tokens ?? null
  const reasoning = reported !== null && reported <= output ? reported : null
  if ((cached ?? 0) + (writes ?? 0) > input || output > args.maxTokens)
    throw new Error('OPENROUTER_USAGE_INVALID')
  const microusd = openrouterCost(usage.data.cost)
  // A repair adds its usage to the first answer; the reasoning split is then unknown.
  const total: Usage = prior
    ? {
        input: prior.input + input,
        output: prior.output + output,
        cached: add(prior.cached, cached),
        writes: add(prior.writes, writes),
      }
    : { input, output, cached, writes }
  // Retain usage even when the answer is truncated, refused, invalid or unexpectedly billed.
  await query(
    `UPDATE tool_calls SET input_tokens=$2,output_tokens=$3,cached_tokens=$4,cache_write_tokens=$5,
      reasoning_tokens=$6,actual_microusd=$7,provider_response_id=$8,heartbeat_at=now()
     WHERE call_key=$1 AND status='pending'`,
    [
      args.key,
      total.input,
      total.output,
      total.cached,
      total.writes,
      prior ? null : reasoning,
      microusd,
      typeof data.id === 'string' ? data.id.slice(0, 200) : null,
    ],
  )
  if (microusd !== 0) throw new Error('OPENROUTER_COST_REVIEW_REQUIRED')
  if (usage.data.is_byok) throw new Error('POLICY_OPENROUTER_BYOK_UNSUPPORTED')
  const choice = Array.isArray(data.choices) && data.choices.length === 1 ? data.choices[0] : null
  if (data.error || choice?.error) throw new Error('OPENROUTER_RESPONSE_ERROR')
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter')
    throw new Error('MODEL_REFUSED')
  if (choice?.finish_reason !== 'stop') throw new Error('MODEL_OUTPUT_INCOMPLETE')
  if (choice.message?.tool_calls?.length) throw new Error('POLICY_MODEL_TOOLS_FORBIDDEN')
  const text = choice.message?.content
  if (typeof text !== 'string' || text.length > 60000) throw new Error('MODEL_SCHEMA_INVALID')
  await reportProgress(args.key, text.length)
  try {
    return { value: args.schema.parse(JSON.parse(text)), microusd: 0, cost: 0 }
  } catch (error) {
    const repair = schemaRepair(error, attempt, args.context, text)
    await reportValidation(args.key, repair.issues, repair.retry)
    if (!repair.retry) throw new Error('MODEL_SCHEMA_INVALID')
    // The first answer was delivered at a verified zero price, so one format repair cannot charge.
    return openrouterModel({ ...args, context: repair.context }, 1, total)
  }
}
