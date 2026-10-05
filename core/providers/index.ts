import { readFileSync } from 'node:fs'
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'
import { config } from '../config'
import { meteredCall } from '../budget'
import { POLICY, safeSourceUrl, type Evidence, type Template } from '../policy'
import { localModel, localSearch } from './local'
import { reportUsage } from '../activity'
import { openaiModel } from './openai'
import { openrouterModel } from './openrouter'
import { openaiMaximum, usdToKopecks } from './openai-cost'

const master = () => readFileSync('prompts/master.md', 'utf8')
const searchQueries: Record<Template, string> = {
  description: 'описания карточек товаров услуги цена характеристики малого бизнеса',
  faq: 'создание FAQ для сайта компании вопросы клиентов услуга',
  social: 'написание коротких постов по материалам компании стоимость',
}
async function requestJson(url: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`)
  const raw = await response.text()
  if (raw.length > 2_000_000) throw new Error('PROVIDER_RESPONSE_TOO_LARGE')
  return JSON.parse(raw)
}

export async function search(
  template: Template,
  key: string,
  reservationId: string,
): Promise<Evidence[]> {
  const c = config()
  const demo = c.SEARCH_PROVIDER === 'demo'
  return meteredCall({
    key,
    reservationId,
    role: 'search',
    maximum: c.SEARCH_PROVIDER === 'yandex' ? c.SEARCH_COST_KOPECKS : 0,
    demo,
    activity: { template, provider: c.SEARCH_PROVIDER, taskLabel: searchQueries[template] },
    invoke: async () => {
      if (demo)
        return {
          cost: 0,
          value: [
            {
              url: 'https://example.com/demo-demand',
              title: 'Демонстрация: предполагаемая потребность',
              snippet: 'Синтетический пример. Спрос не проверен, веб-поиск не выполнялся.',
              observedAt: new Date().toISOString(),
              demo: true,
            },
            {
              url: 'https://example.org/demo-alternative',
              title: 'Демонстрация: бесплатная альтернатива',
              snippet: 'Встроенные редакторы и самостоятельная работа могут заменить услугу.',
              observedAt: new Date().toISOString(),
              demo: true,
            },
          ],
        }
      if (c.SEARCH_PROVIDER === 'searxng')
        return { value: await localSearch(searchQueries[template]), cost: 0 }
      const data = await requestJson(
        'https://searchapi.api.cloud.yandex.net/v2/web/search',
        {
          query: {
            searchType: 'SEARCH_TYPE_RU',
            queryText: searchQueries[template],
            familyMode: 'FAMILY_MODE_STRICT',
          },
          folderId: c.YANDEX_FOLDER_ID,
          responseFormat: 'FORMAT_XML',
          groupSpec: { groupMode: 'GROUP_MODE_DEEP', groupsOnPage: 6, docsInGroup: 1 },
        },
        { Authorization: `Api-Key ${c.YANDEX_API_KEY}` },
      )
      const value = parseSearchXml(
        Buffer.from(z.string().parse(data.rawData), 'base64').toString('utf8'),
      )
      if (!value.length) throw new Error('SEARCH_EMPTY')
      return { value, cost: c.SEARCH_COST_KOPECKS }
    },
  })
}

export function parseSearchXml(xml: string): Evidence[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML_ENTITIES_FORBIDDEN')
  const parsed = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    processEntities: false,
  }).parse(xml)
  const result: Evidence[] = []
  const text = (value: unknown): string =>
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map(text).join(' ')
        : value && typeof value === 'object'
          ? Object.values(value).map(text).join(' ')
          : ''
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object' || result.length >= 6) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const n = node as Record<string, unknown>
    if (typeof n.url === 'string' && safeSourceUrl(n.url))
      result.push({
        url: n.url,
        title: text(n.title).slice(0, 200),
        snippet: text(n.passages ?? n.headline).slice(0, 700),
        observedAt: new Date().toISOString(),
        demo: false,
      })
    else Object.values(n).forEach(walk)
  }
  walk(parsed)
  return result
}

export async function model<T>(args: {
  role: string
  key: string
  reservationId: string
  context: Record<string, unknown>
  schema: z.ZodType<T>
  demoValue: T
  maxOutputTokens?: number
}): Promise<T> {
  const c = config()
  const system =
    master() +
    `\nТекущая роль: ${args.role}. Верни только JSON по схеме:\n` +
    JSON.stringify(z.toJSONSchema(args.schema))
  const context = JSON.stringify({
    policy_version: POLICY.version,
    task_id: args.key,
    ...args.context,
  })
  // UTF-8 bytes plus fixed overhead safely overestimate input token count for this small text context.
  const maxTokens = args.maxOutputTokens ?? (args.role === 'Исследователь' ? 2800 : 2000)
  // Cloud JSON-schema providers also receive the schema separately from the system instructions.
  const upperInput =
    Buffer.byteLength(
      system +
        context +
        (['openai', 'openrouter'].includes(c.MODEL_PROVIDER)
          ? JSON.stringify(z.toJSONSchema(args.schema))
          : ''),
      'utf8',
    ) + 2048
  if (upperInput > 100000) throw new Error('CONTEXT_TOO_LARGE')
  const demo = c.MODEL_PROVIDER === 'demo'
  const maximumMicrousd = c.MODEL_PROVIDER === 'openai' ? openaiMaximum(upperInput, maxTokens) : 0
  const maximum =
    c.MODEL_PROVIDER === 'openai'
      ? usdToKopecks(maximumMicrousd, c.OPENAI_USD_KOPECKS)
      : c.MODEL_PROVIDER !== 'yandex'
        ? 0
        : Math.ceil(
            (upperInput * c.MODEL_INPUT_KOPECKS_PER_1K) / 1000 +
              (maxTokens * c.MODEL_OUTPUT_KOPECKS_PER_1K) / 1000,
          )
  return meteredCall({
    key: args.key,
    reservationId: args.reservationId,
    role: args.role,
    maximum,
    maximumMicrousd,
    demo,
    activity: {
      provider: c.MODEL_PROVIDER,
      model:
        c.MODEL_PROVIDER === 'ollama'
          ? c.OLLAMA_MODEL
          : c.MODEL_PROVIDER === 'openai'
            ? c.OPENAI_MODEL
            : c.MODEL_PROVIDER === 'openrouter'
              ? c.OPENROUTER_MODEL
              : c.MODEL_PROVIDER === 'yandex'
                ? c.YANDEX_MODEL
                : undefined,
      template: String(
        args.context.template ||
          (args.context.product as Record<string, unknown> | undefined)?.template ||
          '',
      ),
      taskLabel:
        (
          {
            Исследователь: 'Изучает источники и формулирует проверяемую гипотезу',
            Критик: 'Ищет слабые места, бесплатные альтернативы и причины отказа',
            Архитектор: 'Проектирует текстовый сервис по принятой гипотезе',
            Исполнитель: 'Готовит текст по исходным данным',
            Проверяющий: 'Сверяет результат с исходными фактами и правилами',
          } as Record<string, string>
        )[args.role] || args.role,
    },
    invoke: async () => {
      if (demo) return { value: args.schema.parse(args.demoValue), cost: 0 }
      if (c.MODEL_PROVIDER === 'openai')
        return openaiModel({ key: args.key, system, context, schema: args.schema, maxTokens })
      if (c.MODEL_PROVIDER === 'openrouter')
        return openrouterModel({ key: args.key, system, context, schema: args.schema, maxTokens })
      if (c.MODEL_PROVIDER === 'ollama')
        return {
          value: await localModel({
            key: args.key,
            system,
            context,
            schema: args.schema,
            maxTokens,
          }),
          cost: 0,
        }
      const response = await requestJson(
        'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
        {
          modelUri: `gpt://${c.YANDEX_FOLDER_ID}/${c.YANDEX_MODEL}`,
          completionOptions: {
            stream: false,
            temperature: 0.2,
            maxTokens: String(maxTokens),
            reasoningOptions: { mode: 'DISABLED' },
          },
          messages: [
            { role: 'system', text: system },
            { role: 'user', text: context },
          ],
          jsonObject: true,
        },
        {
          Authorization: `Api-Key ${c.YANDEX_API_KEY}`,
          'x-folder-id': c.YANDEX_FOLDER_ID,
          'x-data-logging-enabled': 'false',
        },
      )
      const result = response.result ?? response
      const input = z.coerce.number().int().nonnegative().parse(result.usage?.inputTextTokens)
      const output = z.coerce.number().int().nonnegative().parse(result.usage?.completionTokens)
      await reportUsage(args.key, input, output)
      const alternative = result.alternatives?.[0]
      if (alternative?.status !== 'ALTERNATIVE_STATUS_FINAL')
        throw new Error('MODEL_OUTPUT_INCOMPLETE')
      const value = args.schema.parse(JSON.parse(z.string().parse(alternative.message?.text)))
      return {
        value,
        cost: Math.ceil(
          (input * c.MODEL_INPUT_KOPECKS_PER_1K) / 1000 +
            (output * c.MODEL_OUTPUT_KOPECKS_PER_1K) / 1000,
        ),
      }
    },
  })
}
