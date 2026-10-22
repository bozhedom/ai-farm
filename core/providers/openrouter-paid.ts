import { z } from 'zod'
import { config, paidModelId } from '../config'
import { query } from '../db'
import { reportProgress } from '../activity'
import { modelJsonSchema } from './json-schema'
import { openaiCost, usdToKopecks } from './openai-cost'
import { openrouterCost } from './openrouter'
import { providerHttpError, readErrorBody } from './rejection'

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

/** The fixed part of every paid OpenRouter request: one route at the published tariff. */
export function paidRequestEnvelope(maxTokens: number) {
  return {
    model: paidModelId(config()),
    max_tokens: maxTokens,
    reasoning: { effort: 'low', exclude: true },
    stream: false,
    provider: {
      require_parameters: true,
      allow_fallbacks: false,
      data_collection: 'deny',
      // Dollars per million tokens, the short-context tariff in openai-cost.ts.
      max_price: { prompt: 10, completion: 50, request: 0 },
    },
    plugins: [],
  }
}

/**
 * Sends one paid request, records billed usage on the pending tool call and returns the single
 * choice. No retries, redirects or fallbacks; an HTTP error leaves no usage recorded. Only the
 * rejections in `notStartedStatuses` count as not billed; other HTTP errors stay uncertain.
 * Callers decide what a valid answer is.
 */
export async function openrouterPaidRequest(args: {
  key: string
  body: Record<string, unknown>
  maxTokens: number
}) {
  const c = config()
  if (!c.OPENROUTER_API_KEY) throw new Error('OPENROUTER_CREDENTIALS_REQUIRED')
  if (!Number.isSafeInteger(args.maxTokens) || args.maxTokens < 16 || args.maxTokens > 2800)
    throw new Error('OPENAI_OUTPUT_LIMIT_INVALID')
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...paidRequestEnvelope(args.maxTokens), ...args.body }),
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    // 400/401/403/404/422 reject the request before generation (ProviderRejectedError). The
    // provider's short explanation goes to the ledger so the cause is visible.
    throw providerHttpError('OPENROUTER', response.status, await readErrorBody(response))
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
  if (!usage.success && data?.error && data?.usage == null)
    throw new Error('OPENROUTER_RESPONSE_ERROR')
  if (!usage.success) throw new Error('OPENROUTER_USAGE_INVALID')
  const { prompt_tokens: input, completion_tokens: output } = usage.data
  const cached = usage.data.prompt_tokens_details?.cached_tokens ?? 0
  const writes = usage.data.prompt_tokens_details?.cache_write_tokens ?? 0
  const reported = usage.data.completion_tokens_details?.reasoning_tokens ?? null
  const reasoning = reported !== null && reported <= output ? reported : null
  if (cached + writes > input || output > args.maxTokens)
    throw new Error('OPENROUTER_USAGE_INVALID')
  const microusd = Math.max(
    openaiCost(input, output, cached, writes),
    openrouterCost(usage.data.cost),
  )
  // Record billed usage even when the answer is incomplete, refused or invalid.
  await query(
    `UPDATE tool_calls SET input_tokens=$2,output_tokens=$3,cached_tokens=$4,cache_write_tokens=$5,
      reasoning_tokens=$6,actual_microusd=$7,provider_response_id=$8,heartbeat_at=now()
     WHERE call_key=$1 AND status='pending'`,
    [
      args.key,
      input,
      output,
      cached,
      writes,
      reasoning,
      microusd,
      typeof data.id === 'string' ? data.id.slice(0, 200) : null,
    ],
  )
  // A key with the owner's own provider account is billed outside this ledger.
  if (usage.data.is_byok) throw new Error('POLICY_OPENROUTER_BYOK_UNSUPPORTED')
  const choice = Array.isArray(data.choices) && data.choices.length === 1 ? data.choices[0] : null
  if (data.error || choice?.error) throw new Error('OPENROUTER_RESPONSE_ERROR')
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter')
    throw new Error('MODEL_REFUSED')
  return { choice, microusd, cost: usdToKopecks(microusd, c.OPENAI_USD_KOPECKS) }
}

/**
 * GPT-6 Astra through OpenRouter. The caller reserves the same dollar maximum as for the direct
 * OpenAI API; the charge is the larger of the OpenRouter bill and the project's own tariff.
 */
export async function openrouterPaidModel<T>(args: {
  key: string
  system: string
  context: string
  schema: z.ZodType<T>
  maxTokens: number
}) {
  const schema = modelJsonSchema(args.schema)
  // One upstream route at the published tariff: no fallbacks, tools, plugins or retries.
  const { choice, microusd, cost } = await openrouterPaidRequest({
    key: args.key,
    maxTokens: args.maxTokens,
    body: {
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.context },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'farm_result', strict: true, schema },
      },
    },
  })
  if (choice?.finish_reason !== 'stop') throw new Error('MODEL_OUTPUT_INCOMPLETE')
  if (choice.message?.tool_calls?.length) throw new Error('POLICY_MODEL_TOOLS_FORBIDDEN')
  const text = choice.message?.content
  if (typeof text !== 'string' || text.length > 60000) throw new Error('MODEL_SCHEMA_INVALID')
  await reportProgress(args.key, text.length)
  let value: T
  try {
    value = args.schema.parse(JSON.parse(text))
  } catch {
    throw new Error('MODEL_SCHEMA_INVALID')
  }
  return { value, microusd, cost }
}
