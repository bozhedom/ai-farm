import { z } from 'zod'
import { config } from '../config'
import { reportProgress, reportUsage, reportValidation } from '../activity'
import { safeSourceUrl, type Evidence } from '../policy'

export function parseSearxResults(data: unknown): Evidence[] {
  const parsed = z
    .object({
      results: z.array(
        z.object({
          url: z.string(),
          title: z.string().default(''),
          content: z.string().default(''),
        }),
      ),
    })
    .parse(data)
  const unique = new Set<string>()
  return parsed.results
    .filter((item) => {
      if (!safeSourceUrl(item.url) || unique.has(item.url)) return false
      unique.add(item.url)
      return true
    })
    .slice(0, 6)
    .map((item) => ({
      url: item.url,
      title: item.title.replace(/<[^>]*>/g, '').slice(0, 200),
      snippet: item.content.replace(/<[^>]*>/g, '').slice(0, 700),
      observedAt: new Date().toISOString(),
      demo: false,
    }))
}

export async function localSearch(queryText: string) {
  const url = new URL('/search', config().SEARXNG_URL)
  url.search = new URLSearchParams({
    q: queryText,
    format: 'json',
    language: 'ru-RU',
    safesearch: '2',
    categories: 'general',
  }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'error' })
  if (!response.ok) throw new Error(`SEARCH_HTTP_${response.status}`)
  const raw = await response.text()
  if (raw.length > 2_000_000) throw new Error('SEARCH_RESPONSE_TOO_LARGE')
  const value = parseSearxResults(JSON.parse(raw))
  if (new Set(value.map((e) => new URL(e.url).hostname.replace(/^www\./, ''))).size < 2)
    throw new Error('SEARCH_INSUFFICIENT_SOURCES')
  return value
}

/** Stream only counters to the dashboard. Parse and validate the complete answer before use. */
type LocalModelArgs<T> = {
  key: string
  system: string
  context: string
  schema: z.ZodType<T>
  maxTokens: number
}

export async function localModel<T>(args: LocalModelArgs<T>): Promise<T> {
  return generate(args, 0)
}

async function generate<T>(args: LocalModelArgs<T>, attempt: number): Promise<T> {
  const c = config()
  const response = await fetch(new URL('/api/chat', c.OLLAMA_URL), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(c.OLLAMA_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.OLLAMA_MODEL,
      stream: true,
      think: false,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.context },
      ],
      format: z.toJSONSchema(args.schema),
      keep_alive: '5m',
      options: { temperature: 0.1, num_ctx: 12288, num_predict: args.maxTokens, num_thread: 4 },
    }),
  })
  if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`)
  if (!response.body) throw new Error('MODEL_EMPTY_BODY')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '',
    output = '',
    done = false,
    lastUpdate = 0,
    size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 2_000_000) throw new Error('MODEL_RESPONSE_TOO_LARGE')
      buffer += decoder.decode(part.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const item = JSON.parse(line)
        if (item.error) throw new Error('MODEL_STREAM_ERROR')
        output += typeof item.message?.content === 'string' ? item.message.content : ''
        if (output.length > 60000) throw new Error('MODEL_RESPONSE_TOO_LARGE')
        if (item.done) {
          if (done) throw new Error('MODEL_STREAM_ERROR')
          await reportUsage(args.key, item.prompt_eval_count, item.eval_count)
          if (item.done_reason === 'length') throw new Error('MODEL_OUTPUT_INCOMPLETE')
          done = true
        }
      }
      if (Date.now() - lastUpdate > 1000) {
        await reportProgress(args.key, output.length)
        lastUpdate = Date.now()
      }
    }
    if (!done) throw new Error('MODEL_OUTPUT_INCOMPLETE')
    await reportProgress(args.key, output.length)
    try {
      return args.schema.parse(JSON.parse(output))
    } catch (error) {
      const issues =
        error instanceof z.ZodError
          ? error.issues.slice(0, 12).map((issue) => ({
              path: issue.path.map(String).join('.'),
              code: issue.code,
              message: issue.message,
            }))
          : [
              {
                path: '',
                code: 'invalid_json',
                message: 'Верни корректный JSON без пояснений вокруг объекта.',
              },
            ]
      const retry = attempt === 0 && !issues.some((issue) => issue.path === 'estimatedCostRub')
      await reportValidation(args.key, issues, retry)
      if (!retry) throw new Error('MODEL_SCHEMA_INVALID')
      const repairSources = issues.some(
        (issue) => issue.path === 'sources' || issue.path.startsWith('sources.'),
      )
      // This bounded repair is local-only and has no API charge. No candidate is published before validation.
      return generate(
        {
          ...args,
          context: JSON.stringify({
            task: repairSources
              ? 'Исправь указанные ошибки в candidate и верни полный JSON по схеме из system. Состав sources можно изменить: выбери только URL из evidence в original_context, минимум с двух разных доменов. Ссылки должны подходить к фактам гипотезы. Нельзя переписывать URL, добавлять новые ссылки или менять факты и оценку расходов. В строках нельзя HTML и символы < или >. Соблюдай длину полей и диапазоны чисел.'
              : 'Исправь только указанные ошибки формата в candidate. Верни полный JSON по схеме из system. Не меняй факты и ссылки. В строках нельзя HTML и символы < или >. Соблюдай длину полей и диапазоны чисел.',
            original_context: repairSources ? args.context : undefined,
            candidate: output,
            validation_errors: issues,
          }),
        },
        1,
      )
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
