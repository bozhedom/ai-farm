import { z } from 'zod'
import { config } from '../config'
import { query } from '../db'
import { reportProgress } from '../activity'
import { openaiCost, usdToKopecks } from './openai-cost'
import { openrouterPaidModel } from './openrouter-paid'

const tokens = z.number().int().nonnegative().max(100000)
const usageSchema = z.object({
  input_tokens: tokens,
  output_tokens: tokens,
  input_tokens_details: z.object({ cached_tokens: tokens, cache_write_tokens: tokens.default(0) }),
  output_tokens_details: z.object({ reasoning_tokens: tokens }),
})

export async function openaiModel<T>(args: {
  key: string
  system: string
  context: string
  schema: z.ZodType<T>
  maxTokens: number
}) {
  const c = config()
  if (c.OPENAI_TRANSPORT === 'openrouter') return openrouterPaidModel(args)
  if (!c.OPENAI_API_KEY) throw new Error('OPENAI_CREDENTIALS_REQUIRED')
  if (!Number.isSafeInteger(args.maxTokens) || args.maxTokens < 16 || args.maxTokens > 2800)
    throw new Error('OPENAI_OUTPUT_LIMIT_INVALID')
  const schema = z.toJSONSchema(args.schema)
  delete schema.$schema
  // No SDK retries, remote tools, redirects, stored conversations or premium service tier.
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.OPENAI_MODEL,
      instructions: args.system,
      input: args.context,
      reasoning: { effort: 'low' },
      max_output_tokens: args.maxTokens,
      text: { format: { type: 'json_schema', name: 'farm_result', strict: true, schema } },
      store: false,
      service_tier: 'default',
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`OPENAI_HTTP_${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('OPENAI_RESPONSE_EMPTY')
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
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const usage = usageSchema.safeParse(data.usage)
  if (!usage.success) throw new Error('OPENAI_USAGE_INVALID')
  const { input_tokens: input, output_tokens: output } = usage.data
  const { cached_tokens: cached, cache_write_tokens: writes } = usage.data.input_tokens_details
  const reasoning = usage.data.output_tokens_details.reasoning_tokens
  if (reasoning > output || output > args.maxTokens) throw new Error('OPENAI_USAGE_INVALID')
  const microusd = openaiCost(input, output, cached, writes)
  // Record billed reasoning/cache usage even when output is incomplete, refused or invalid.
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
  if (data.service_tier && data.service_tier !== 'default')
    throw new Error('OPENAI_UNEXPECTED_SERVICE_TIER')
  if (data.status !== 'completed') throw new Error('MODEL_OUTPUT_INCOMPLETE')
  const content = (Array.isArray(data.output) ? data.output : [])
    .filter((item: { type?: string }) => item.type === 'message')
    .flatMap((item: { content?: unknown[] }) => item.content || [])
  if (content.some((item: { type?: string }) => item.type === 'refusal'))
    throw new Error('MODEL_REFUSED')
  const text = content
    .filter((item: { type?: string }) => item.type === 'output_text')
    .map((item: { text?: string }) => item.text || '')
    .join('')
  await reportProgress(args.key, text.length)
  let value: T
  try {
    value = args.schema.parse(JSON.parse(text))
  } catch {
    throw new Error('MODEL_SCHEMA_INVALID')
  }
  return { value, microusd, cost: usdToKopecks(microusd, c.OPENAI_USD_KOPECKS) }
}
