import { z } from 'zod'
import { recipes } from './templates'

export const POLICY = Object.freeze({
  version: 'v1',
  maxProducts: 3,
  maxStrategies: 4,
  scheduledResearchPerDay: 1,
  maxInputChars: 4000,
  maxOutputChars: 12000,
  maxAttempts: 3,
  chainId: 11155111,
  productionPayments: false,
})
export const templates = ['description', 'faq', 'social'] as const
export type Template = (typeof templates)[number]
export const templateSchema = z.enum(templates)
const plain = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !/[<>]/.test(s), 'HTML_FORBIDDEN')
export const productSchema = z
  .object({
    template: templateSchema,
    name: plain(4, 80),
    audience: plain(4, 200),
    promise: plain(15, 400),
    inputLabel: plain(4, 160),
  })
  .strict()
export type ProductSpec = z.infer<typeof productSchema>
export const researchSchema = z
  .object({
    title: plain(4, 120),
    problem: plain(10, 600),
    audience: plain(4, 200),
    hypothesis: plain(10, 700),
    counterargument: plain(10, 700),
    experiment: plain(10, 500),
    estimatedCostRub: z
      .number()
      .min(0)
      .max(1000000)
      .describe(
        'Собственные прямые расходы в рублях на генерацию и проверку одного заказа, по costContext. Не цена продажи и не стоимость копирайтера из источников. Сервер и привлечение клиентов учитываются отдельно в uncertainties. Оценку выше лимита не уменьшай.',
      ),
    sources: z.array(z.url()).max(6),
    uncertainties: z.array(plain(3, 300)).min(1).max(6),
  })
  .strict()
export const reviewSchema = z
  .object({
    verdict: z.enum(['PASS', 'REVISE', 'BLOCKED']),
    reason: plain(5, 700),
  })
  .strict()
export const outputSchema = z.object({ text: plain(30, POLICY.maxOutputChars) }).strict()
export type Evidence = {
  url: string
  title: string
  snippet: string
  observedAt: string
  demo: boolean
}

const forbidden =
  /(?:фишинг|пиратск|накрутк|казино|наркотик|порнограф|обход.{0,15}(?:блокиров|верификац)|гарантированн.{0,15}(?:доход|прибыл)|украденн|купить.{0,10}базу.{0,10}данных|phishing|malware|casino|guaranteed profit)/iu
const injection =
  /(?:ignore.{0,30}(?:previous|instructions)|игнорируй.{0,30}(?:инструкц|правил)|system\s*prompt|системн.{0,10}промпт|seed[- ]phrase|приватн.{0,10}ключ|<script|javascript:)/iu
export function validateContent(text: string) {
  if (forbidden.test(text)) throw new Error('POLICY_CONTENT_BLOCKED')
  if (injection.test(text)) throw new Error('UNTRUSTED_INSTRUCTION_BLOCKED')
}
export function validateInput(text: string) {
  if (text.trim().length < 30 || text.length > POLICY.maxInputChars) throw new Error('INPUT_LENGTH')
  validateContent(text)
}
export function validateProduct(value: unknown, expected: Template): ProductSpec {
  const spec = productSchema.parse(value)
  if (spec.template !== expected) throw new Error('TEMPLATE_MISMATCH')
  validateContent(Object.values(spec).join(' '))
  // The model proposes a niche, but the server defines what the service actually delivers.
  // Its unedited proposal remains in tool_calls; unmeasured sales claims cannot become a contract.
  return { ...spec, promise: recipes[expected].delivery }
}
export function validateOutput(template: Template, text: string) {
  outputSchema.parse({ text })
  validateContent(text)
  if (template === 'description' && !/^[-*•]\s+\S/mu.test(text))
    throw new Error('OUTPUT_FORMAT_REQUIRED')
  if (template !== 'social') return
  const headings = [
    ...text.matchAll(
      /^(?:#{1,3}\s*)?(?:\*\*)?(?:(?:Черновик|Пост|Публикация)\s+)?(\d+)[.)]\s+/gimu,
    ),
  ]
  if (
    headings.length !== 3 ||
    headings.some(
      (heading, i) =>
        Number(heading[1]) !== i + 1 ||
        text.slice(heading.index! + heading[0].length, headings[i + 1]?.index).trim().length < 10,
    )
  )
    throw new Error('OUTPUT_FORMAT_REQUIRED')
}
export function validateEvidence(sources: string[], evidence: Evidence[], demo: boolean) {
  const allowed = new Set(evidence.map((e) => e.url))
  if (sources.some((url) => !allowed.has(url))) throw new Error('FABRICATED_SOURCE')
  const domains = new Set(sources.map((url) => new URL(url).hostname.replace(/^www\./, '')))
  if (!demo && domains.size < 2) throw new Error('INSUFFICIENT_SOURCES')
}

/** Local schema repair may correct source selection, but never invent or replace evidence. */
export function researchSchemaForEvidence(evidence: Evidence[], demo: boolean) {
  return researchSchema
    .extend({
      sources: z
        .array(z.enum(evidence.map((item) => item.url) as [string, ...string[]]))
        .min(2)
        .max(6),
    })
    .superRefine((idea, context) => {
      try {
        validateEvidence(idea.sources, evidence, demo)
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['sources'],
          message:
            'Выбери ссылки из evidence минимум с двух разных доменов. Несколько страниц одного сайта, включая www, считаются одним доменом. Не изменяй URL и не добавляй ссылки вне списка.',
        })
      }
    })
}

export function safeSourceUrl(url: string) {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !/^(localhost|.*\.local|\[.*\]|\d+\.\d+\.\d+\.\d+)$/.test(u.hostname)
    )
  } catch {
    return false
  }
}
