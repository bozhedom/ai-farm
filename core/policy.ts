import { z } from 'zod'
import { recipes } from './templates'
import { serviceTemplates, type ServiceTemplate } from './service-catalog'
import { priceIds, priceKopecksFor } from './storefront'
import { categoryById, isTaxonomyTopic, taxonomyCategories, taxonomyCategoryIds } from './taxonomy'

export const POLICY = Object.freeze({
  version: 'v3',
  maxProducts: 12,
  maxStrategies: 4,
  scheduledResearchPerDay: 1,
  researchWindowDays: 28,
  maxInputChars: 4000,
  maxOutputChars: 12000,
  maxAttempts: 3,
  chainId: 11155111,
  productionPayments: false,
  // Quality selection: the worst half is archived, the best half is copied with one mutation.
  evolution: Object.freeze({ archiveShare: 0.5, minGapMilli: 50, defaultMinIdeas: 6 }),
  maxIdeasPerDay: 24,
  maxLeadDraftsPerDay: 12,
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

// ---------------------------------------------------------------------------------------------
// Policy v3: ideas on any legal topic, agent parameters, manager reports and reply drafts.
// Models return data by these schemas; only the server acts on it.

const plainList = (min: number, max: number, itemMax = 300) =>
  z.array(plain(3, itemMax)).min(min).max(max)

export const revenueModels = [
  'service_fee',
  'subscription',
  'one_time_sale',
  'commission',
  'advertising',
  'other',
] as const
export const ideaSchema = z
  .object({
    title: plain(4, 120),
    audience: plain(4, 200),
    problem: plain(10, 600),
    demandSignals: z
      .array(z.object({ claim: plain(5, 300), url: z.url() }).strict())
      .min(1)
      .max(6),
    competitors: z.array(plain(2, 200)).max(6),
    revenueModel: z.enum(revenueModels),
    revenueNote: plain(5, 400),
    startupCostRub: z.number().int().min(0).max(10000000),
    monthlyCostRub: z.number().int().min(0).max(10000000),
    risks: plainList(1, 6),
    quickTest: plain(10, 500),
    farmExecutable: z.boolean(),
    suggestedTemplate: templateSchema.nullable(),
    executionNote: plain(5, 500),
    launchPlanForHuman: plainList(0, 8),
    uncertainties: plainList(1, 6),
  })
  .strict()
export type IdeaResearch = z.infer<typeof ideaSchema>

function ideaDomains(idea: Pick<IdeaResearch, 'demandSignals'>) {
  return new Set(idea.demandSignals.map((s) => new URL(s.url).hostname.replace(/^www\./, '')))
}
export function ideaSourceDomains(idea: Pick<IdeaResearch, 'demandSignals'>) {
  return ideaDomains(idea).size
}

/** Demand signals may cite only the server's search results, from at least two domains. */
export function ideaSchemaForEvidence(evidence: Evidence[], demo: boolean) {
  if (!evidence.length) throw new Error('SOURCE_EVIDENCE_EMPTY')
  const urls = evidence.map((item) => item.url) as [string, ...string[]]
  return ideaSchema
    .extend({
      demandSignals: z
        .array(z.object({ claim: plain(5, 300), url: z.enum(urls) }).strict())
        .min(1)
        .max(6),
    })
    .superRefine((idea, context) => {
      if (!demo && ideaDomains(idea).size < 2)
        context.addIssue({
          code: 'custom',
          path: ['demandSignals'],
          message:
            'Приведи признаки спроса минимум с двух разных доменов из evidence. Не изменяй URL и не добавляй ссылки вне списка.',
        })
      if (idea.farmExecutable && !idea.suggestedTemplate)
        context.addIssue({
          code: 'custom',
          path: ['suggestedTemplate'],
          message: 'Если ферма может исполнить идею, выбери один шаблон из списка, иначе null.',
        })
    })
}

/** Server checks after the schema: sources, topic from the taxonomy, banned content. */
export function validateIdea(
  value: unknown,
  evidence: Evidence[],
  demo: boolean,
  topicId: string,
): IdeaResearch {
  if (!isTaxonomyTopic(topicId)) throw new Error('POLICY_TOPIC_UNKNOWN')
  const idea = ideaSchemaForEvidence(evidence, demo).parse(value) as IdeaResearch
  validateEvidence(
    idea.demandSignals.map((s) => s.url),
    evidence,
    demo,
  )
  validateContent(
    [
      idea.title,
      idea.audience,
      idea.problem,
      idea.revenueNote,
      idea.quickTest,
      idea.executionNote,
      ...idea.demandSignals.map((s) => s.claim),
      ...idea.competitors,
      ...idea.risks,
      ...idea.launchPlanForHuman,
      ...idea.uncertainties,
    ].join('\n'),
  )
  validateIdeaTopic(
    [idea.title, idea.audience, idea.problem, idea.revenueNote, idea.executionNote].join('\n'),
  )
  // A template without a farm decision is only a hint; keep the stored decision consistent.
  return idea.farmExecutable ? idea : { ...idea, suggestedTemplate: null }
}

/**
 * Areas the master prompt excludes from the pilot, as a hard server rule for ideas. The critic
 * also refuses them, but a model decision alone is not a limit.
 */
const excludedIdeaTopics = [
  /(?<![\p{L}])(?:казино|букмекер|беттинг|тотализатор|азартн|ставк[аиу]\s+на\s+спорт|ставок\s+на\s+спорт|прогноз[ыа]?\s+на\s+(?:спорт|матч|ставк))/iu,
  /(?<![\p{L}])(?:эротик|эротическ|порно|интим|вебкам|18\s*\+|для\s+взрослых|секс)/iu,
  /(?<![\p{L}])(?:агитац|предвыборн|избирательн|политическ|кандидат(?:а|ов|ам)?\s+в\s+депутат|выбор(?:ы|ов)\s+(?:депутат|мэр|президент|губернатор))/iu,
  /(?:курсов(?:ая|ые|ых|ую)\s+работ|дипломн(?:ая|ые|ых|ую)\s+работ|контрольн(?:ая|ые|ых|ую)\s+работ|(?<![\p{L}])реферат|помощь\s+студент|студенческ[а-я]*\s+работ|решени[ея]\s+(?:тестов|экзамен))/iu,
  /(?:отзыв[а-я]*\s+на\s+заказ|заказн[а-я]*\s+отзыв|фейков[а-я]*\s+отзыв|купить\s+отзыв|накрут|лайк[а-я]*\s+за\s+деньги|подписчик[а-я]*\s+за\s+деньги)/iu,
  /(?:(?:продаж|перепродаж|аренд|покупк)[а-я]*\s+(?:готовых\s+)?аккаунт|аккаунт[а-я]*\s+на\s+продажу|(?:база|базы|баз)\s+(?:данных\s+)?(?:клиентов|контактов|номеров)|парсинг\s+(?:контакт|номер|почт))/iu,
  /(?:(?:медицинск|юридическ|инвестиционн|финансов)[а-я]*\s+(?:услуг|консультац|помощ|совет)|сигнал[а-я]*\s+для\s+трейд|трейдинг|криптовалютн[а-я]*\s+(?:инвест|сигнал)|микрозайм)/iu,
  /(?:обход[а-я]*\s+(?:блокиров|верификац|капч|captcha)|vpn\s+для\s+обход|рассылк|холодн[а-я]*\s+(?:звонк|письм|обзвон))/iu,
]
export function validateIdeaTopic(text: string) {
  if (excludedIdeaTopics.some((pattern) => pattern.test(text)))
    throw new Error('POLICY_IDEA_TOPIC_BLOCKED')
}

export const reportSchema = z
  .object({
    headline: plain(4, 120),
    summary: plain(20, 1200),
    ideaComments: z
      .array(z.object({ ideaId: z.string(), comment: plain(5, 400) }).strict())
      .max(10),
    nextActions: plainList(0, 5),
    needsOwner: plainList(0, 5),
  })
  .strict()
export type ReportNarrative = z.infer<typeof reportSchema>

/** Comments may refer only to ideas the server ranked. The model ranks nothing itself. */
export function reportSchemaFor(ideaIds: string[]) {
  const ideaComments = ideaIds.length
    ? z
        .array(
          z
            .object({ ideaId: z.enum(ideaIds as [string, ...string[]]), comment: plain(5, 400) })
            .strict(),
        )
        .max(10)
    : z.array(z.object({ ideaId: z.string(), comment: plain(5, 400) }).strict()).max(0)
  return reportSchema.extend({ ideaComments })
}
export function validateReport(value: ReportNarrative) {
  validateContent(
    [
      value.headline,
      value.summary,
      ...value.ideaComments.map((c) => c.comment),
      ...value.nextActions,
      ...value.needsOwner,
    ].join('\n'),
  )
  return value
}

export const replyDraftSchema = z.object({ draft: plain(80, 700) }).strict()
export type ReplyDraft = z.infer<typeof replyDraftSchema>

/**
 * A reply draft is sent by a person, never by the farm. No contacts, mentions, foreign links or
 * promises that the product page does not make.
 */
/** Phone-like runs: at least nine digits with spaces, dots, dashes or brackets in between. */
export function hasPhoneNumber(text: string) {
  for (const match of text.matchAll(/\+?\d[\d\s().\-]{6,}\d/g))
    if (match[0].replace(/\D/g, '').length >= 9) return true
  return false
}
const messengers =
  /(?<![\p{L}])(?:телеграм|телеграмм|telegram|тг|tg|whats\s?app|ватсап|вотсап|вацап|viber|вайбер|skype|скайп|вконтакте|вк|vk|instagram|инстаграм|инста|директ|личк[аеуи]|в\s+лс|max\s+мессенджер|signal|discord|дискорд)(?![\p{L}])/iu
const obfuscated =
  /\((?:at|dot|собака|точка)\)|\[(?:at|dot|собака|точка)\]|\s(?:at|собака)\s.*\s(?:dot|точка)\s|(?:точка|dot)\s*(?:ру|ru|ком|com|рф|net|org)(?![\p{L}])/iu
/** Any domain-like token, including short links and unusual zones. */
const domainLike = /[\p{L}\d-]+\.(?:[a-z]{2,24}|рф|рус|орг|онлайн|сайт)(?![\p{L}\d])/iu
const schemeLike = /(?<![\p{L}])[a-z][a-z0-9+.-]{1,20}:(?:\/\/|[^\s]*\?)/iu

/**
 * A reply draft is sent by a person, never by the farm. The only link is the public product
 * page. No contacts, messengers, other domains or schemes, disguised addresses or promises
 * that the product page does not make.
 */
export function validateReplyDraft(text: string, allowedUrl: string, productText = '') {
  replyDraftSchema.parse({ draft: text })
  validateContent(text)
  if (/@|＠/.test(text) || hasPhoneNumber(text) || obfuscated.test(text) || messengers.test(text))
    throw new Error('POLICY_REPLY_CONTACT')
  const urls = [...text.matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s]+/giu)].map((m) =>
    m[0].replace(/[.,;:!?)»"']+$/u, ''),
  )
  if (urls.some((url) => url !== allowedUrl)) throw new Error('POLICY_REPLY_URL')
  const rest = text.split(allowedUrl).join(' ')
  if (domainLike.test(rest) || schemeLike.test(rest)) throw new Error('POLICY_REPLY_URL')
  const allowed = productText.toLowerCase()
  for (const word of ['гарант', 'скидк', 'бесплатн'])
    if (text.toLowerCase().includes(word) && !allowed.includes(word))
      throw new Error('POLICY_REPLY_PROMISE')
  return text.trim()
}

export const productPageSchema = z
  .object({
    headline: plain(4, 160),
    forWhom: plainList(1, 5),
    youGet: plainList(1, 5),
    limits: plainList(0, 5),
  })
  .strict()
export type ProductPageSpec = z.infer<typeof productPageSchema>

/** Architect answer for a public product: price only from the server list, page as plain text. */
export const productOfferSchema = productSchema.extend({
  priceId: z.enum(priceIds).optional(),
  page: productPageSchema.optional(),
})
/** For a product built from an idea: price and page are required. */
export const productOfferRequiredSchema = productSchema.extend({
  priceId: z.enum(priceIds),
  page: productPageSchema,
})
export function validateProductOffer(value: unknown, expected: Template, required = false) {
  const offer = (required ? productOfferRequiredSchema : productOfferSchema).parse(value)
  const { priceId, page, ...base } = offer
  const spec = validateProduct(base, expected)
  if (page)
    validateContent([page.headline, ...page.forWhom, ...page.youGet, ...page.limits].join('\n'))
  return { spec, priceKopecks: priceId ? priceKopecksFor(priceId) : null, page: page ?? null }
}

export const agentTones = ['plain', 'expert', 'friendly'] as const
export const strategyParamsSchema = z
  .object({
    focusCategories: z
      .array(z.string().refine((id) => Object.hasOwn(categoryById, id), 'CATEGORY_UNKNOWN'))
      .min(1)
      .max(3)
      .refine((ids) => new Set(ids).size === ids.length, 'CATEGORY_DUPLICATE'),
    evidenceMinimum: z.union([z.literal(2), z.literal(3)]),
    tone: z.enum(agentTones),
    ideaScope: z.enum(['narrow', 'broad']),
    riskAppetite: z.enum(['low', 'medium']),
  })
  .strict()
export type StrategyParams = z.infer<typeof strategyParamsSchema>
export const mutableParams = [
  'focusCategories',
  'evidenceMinimum',
  'tone',
  'ideaScope',
  'riskAppetite',
] as const
export type MutableParam = (typeof mutableParams)[number]
export type Mutation = { param: MutableParam; from: unknown; to: unknown }
export type TaxonomyState = { categoryScouts: Record<string, number> }

/** Deterministic seed from the parent id and the generation, as in the architecture. */
export function mutationIndex(parentId: string, generation: number) {
  let sum = 0
  for (const char of parentId) sum += char.charCodeAt(0)
  return (sum + generation) % mutableParams.length
}

/**
 * Exactly one allowed change. If the selected parameter cannot change, or the parent's last
 * mutation touched it, the next one in the list is used. Free text is never mutated.
 */
export function applyMutation(
  params: StrategyParams,
  index: number,
  state: TaxonomyState,
  avoid: string | null = null,
): { params: StrategyParams; mutation: Mutation } {
  const current = strategyParamsSchema.parse(params)
  for (let step = 0; step < mutableParams.length; step++) {
    const param = mutableParams[(index + step) % mutableParams.length]!
    if (param === avoid) continue
    if (param === 'focusCategories') {
      const outside = taxonomyCategoryIds
        .filter((id) => !current.focusCategories.includes(id))
        .sort(
          (a, b) =>
            (state.categoryScouts[a] ?? 0) - (state.categoryScouts[b] ?? 0) ||
            taxonomyCategoryIds.indexOf(a) - taxonomyCategoryIds.indexOf(b),
        )
      if (!outside.length) continue
      const position = index % current.focusCategories.length
      const to = [...current.focusCategories]
      to[position] = outside[0]!
      return {
        params: { ...current, focusCategories: to },
        mutation: { param, from: current.focusCategories, to },
      }
    }
    if (param === 'evidenceMinimum') {
      const to = current.evidenceMinimum === 2 ? 3 : 2
      return {
        params: { ...current, evidenceMinimum: to },
        mutation: { param, from: current.evidenceMinimum, to },
      }
    }
    if (param === 'tone') {
      const to = agentTones[(agentTones.indexOf(current.tone) + 1) % agentTones.length]!
      return { params: { ...current, tone: to }, mutation: { param, from: current.tone, to } }
    }
    if (param === 'ideaScope') {
      const to = current.ideaScope === 'narrow' ? 'broad' : 'narrow'
      return {
        params: { ...current, ideaScope: to },
        mutation: { param, from: current.ideaScope, to },
      }
    }
    const to = current.riskAppetite === 'low' ? 'medium' : 'low'
    return {
      params: { ...current, riskAppetite: to },
      mutation: { param, from: current.riskAppetite, to },
    }
  }
  throw new Error('MUTATION_UNAVAILABLE')
}

/** Human labels for categories in parameters. */
export const categoryLabels: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(taxonomyCategories.map((c) => [c.id, c.label])),
)
