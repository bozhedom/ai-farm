import { z } from 'zod'
import { recipes } from './templates'
import { serviceTemplates, type ServiceTemplate } from './service-catalog'

export const POLICY = Object.freeze({
  version: 'v2',
  maxProducts: 12,
  maxStrategies: 4,
  scheduledResearchPerDay: 1,
  maxInputChars: 4000,
  maxOutputChars: 12000,
  maxAttempts: 3,
  chainId: 11155111,
  productionPayments: false,
})
export const templates = serviceTemplates
export type Template = ServiceTemplate
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
const excludedServices =
  /(?:спам|массов.{0,20}рассылк|(?:медицинск|юридическ|инвестиционн).{0,24}(?:консультац|совет|рекомендац)|(?:назначь|назначить).{0,25}(?:лечени|препарат)|(?:поставь|поставить).{0,20}диагноз|unsolicited bulk|medical advice|legal advice|investment advice)/iu
export function validateContent(text: string) {
  if (forbidden.test(text) || excludedServices.test(text)) throw new Error('POLICY_CONTENT_BLOCKED')
  if (injection.test(text)) throw new Error('UNTRUSTED_INSTRUCTION_BLOCKED')
}
export function validateInput(text: string) {
  if (text.trim().length < 30 || text.length > POLICY.maxInputChars) throw new Error('INPUT_LENGTH')
  validateContent(text)
}
export function validateTemplateInput(template: Template, text: string) {
  if (!templateSchema.safeParse(template).success) throw new Error('TEMPLATE_UNSUPPORTED')
  validateInput(text)
  if (template !== 'translation') return
  const newline = text.indexOf('\n')
  const language = text
    .slice(0, newline < 0 ? undefined : newline)
    .trim()
    .match(/^(?:Язык перевода|Целевой язык|Target language):[ \t]*([\p{L}][\p{L} \t-]{1,59})$/iu)
  if (newline < 0 || !language) throw new Error('TRANSLATION_LANGUAGE_REQUIRED')
  validateInput(text.slice(newline + 1))
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
  if (!templateSchema.safeParse(template).success) throw new Error('TEMPLATE_UNSUPPORTED')
  outputSchema.parse({ text })
  validateContent(text)
  validateOutputFormat(template, text)
}

/** Free providers may use their existing single repair to satisfy the delivery format. */
export function outputSchemaForTemplate(template: Template) {
  templateSchema.parse(template)
  return outputSchema.superRefine(({ text }, context) => {
    // Content restrictions remain a hard refusal, never a prompt to disguise the content.
    validateContent(text)
    try {
      validateOutputFormat(template, text)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'OUTPUT_FORMAT_REQUIRED') throw error
      context.addIssue({
        code: 'custom',
        path: ['text'],
        message: `Соблюдай обязательный формат результата, сохрани факты input. ${recipes[template].task}`,
      })
    }
  })
}

function validateOutputFormat(template: Template, text: string) {
  if (template === 'description' && !/^[-*•]\s+\S/mu.test(text))
    throw new Error('OUTPUT_FORMAT_REQUIRED')
  if (structuredSections[template]) validateSections(text, structuredSections[template]!)
  if (template === 'summary' && !/^[-*•]\s+\S/mu.test(text))
    throw new Error('OUTPUT_FORMAT_REQUIRED')
  if (template === 'instruction') {
    const steps = [...text.matchAll(/^(\d+)[.)][ \t]+\S/gmu)]
    if (!steps.length || steps.some((step, i) => Number(step[1]) !== i + 1))
      throw new Error('OUTPUT_FORMAT_REQUIRED')
  }
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

const structuredSections: Partial<Record<Template, string[]>> = {
  proofreading: ['Исправленный текст', 'Правки'],
  summary: ['Кратко', 'Ключевые факты'],
  email: ['Тема', 'Черновик ответа'],
  landing: ['Заголовок', 'Описание', 'Что уточнить'],
  proposal: ['Предложение', 'Объём работ', 'Условия', 'Что уточнить'],
  instruction: ['Шаги', 'Что уточнить'],
  lesson: ['Тема', 'Объяснение', 'Самопроверка', 'Ответ'],
  job_post: ['Вакансия', 'Задачи', 'Требования', 'Условия'],
}

function validateSections(text: string, sections: string[]) {
  const headings = [
    ...text.matchAll(
      new RegExp(`^(?:#{1,3}[ \\t]+)?(?:\\*\\*)?(${sections.join('|')}):(?:\\*\\*)?[ \\t]*`, 'gmu'),
    ),
  ]
  if (
    headings.length !== sections.length ||
    headings.some(
      (heading, i) =>
        heading[1] !== sections[i] ||
        text.slice(heading.index! + heading[0].length, headings[i + 1]?.index).trim().length < 3,
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
