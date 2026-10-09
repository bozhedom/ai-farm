import type {
  Evidence,
  IdeaResearch,
  ProductPageSpec,
  ProductSpec,
  ReportNarrative,
  StrategyParams,
  Template,
} from '../policy'
import { serviceByTemplate, serviceCatalog } from '../service-catalog'
import { defaultPriceKopecks, formatRub, priceIdFor, type PriceId } from '../storefront'
import { taxonomyTopics, type TaxonomyTopic } from '../taxonomy'

const ideasWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? 'идея'
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? 'идеи'
      : 'идей'

const originalNames: Partial<Record<Template, string>> = {
  description: 'Карточка без лишних слов',
  faq: 'Ответы до первого вопроса',
  social: 'Из материала в публикации',
}
export const demoSpecs: Record<Template, ProductSpec> = Object.fromEntries(
  serviceCatalog.map((service) => [
    service.id,
    {
      template: service.id,
      name: originalNames[service.id] ?? service.label,
      audience: service.audience,
      promise: service.delivery,
      inputLabel: service.inputLabel,
    },
  ]),
) as Record<Template, ProductSpec>

/** First line of every demo order text: the text was put together without a model. */
export const demoMarker = 'Демонстрация: текст собран по шаблону, без вызова модели.'

export function demoResult(template: Template, input: string) {
  const raw = input.trim().slice(0, 3500)
  const marker = demoMarker
  if (template === 'description')
    return `${marker}\n\nОписание товара\n- ${raw}\n\nПеред публикацией уточните отсутствующие характеристики. Новые свойства и гарантии не добавлены.`
  if (template === 'faq')
    return `${marker}\n\nЧто известно об услуге?\n${raw}\n\nЧто уточнить перед заказом?\nСроки, итоговый состав услуги и ограничения, если их нет в исходном материале.`
  if (template === 'social')
    return `${marker}\n\nЧерновик 1. Знакомство\n${raw}\n\nЧерновик 2. Основные сведения\n${raw}\n\nЧерновик 3. Перед обращением\nУточните необходимые детали по исходному материалу. Неуказанные свойства не добавлены.`
  if (template === 'proofreading')
    return `${marker}\n\nИсправленный текст:\n${raw}\n\nПравки:\nВ демонстрации сохранён исходный текст; редактура моделью не выполнялась.`
  if (template === 'translation')
    return `${marker}\n\nПеревод моделью не выполнялся. Для проверки показан исходный материал:\n${raw.slice(raw.indexOf('\n') + 1)}`
  if (template === 'summary')
    return `${marker}\n\nКратко:\nВ демонстрации показан исходник без модельного сокращения.\n\nКлючевые факты:\n- ${raw}`
  if (template === 'email')
    return `${marker}\n\nТема:\nОтвет по вашему вопросу\n\nЧерновик ответа:\n${raw}\n\nЭто демонстрационный материал. Отправка письма не выполнялась.`
  if (template === 'landing')
    return `${marker}\n\nЗаголовок:\nОписание услуги\n\nОписание:\n${raw}\n\nЧто уточнить:\nПроверьте недостающие условия по исходному материалу. Страница не публиковалась.`
  if (template === 'proposal')
    return `${marker}\n\nПредложение:\nМатериал для обсуждения\n\nОбъём работ:\n${raw}\n\nУсловия:\nТолько сведения из исходного материала.\n\nЧто уточнить:\nПроверьте отсутствующие условия до согласования. Предложение не отправлялось.`
  if (template === 'instruction')
    return `${marker}\n\nШаги:\n1. ${raw}\n\nЧто уточнить:\nПорядок действий в демонстрации моделью не проверялся.`
  if (template === 'lesson')
    return `${marker}\n\nТема:\nИзучение предоставленного материала\n\nОбъяснение:\n${raw}\n\nСамопроверка:\nКакие сведения приведены в исходном материале?\n\nОтвет:\nСверьтесь с исходным материалом: модельная подготовка урока не выполнялась.`
  if (template === 'job_post')
    return `${marker}\n\nВакансия:\nМатериал работодателя\n\nЗадачи:\n${raw}\n\nТребования:\nТолько указанные в исходном материале.\n\nУсловия:\nНеизвестные сведения требуют уточнения. Вакансия не размещалась.`
  throw new Error('TEMPLATE_UNSUPPORTED')
}

// ---------------------------------------------------------------------------------------------
// Demo answers for the farm roles. They are stored with is_demo=true and cite example domains
// only: no real search, no real demand. Outcomes depend on agent parameters deterministically,
// so a demo selection round has something to compare.

const demoHosts = [
  ['example.com', 'market.example'],
  ['example.org', 'forum.example'],
  ['example.net', 'price.example'],
] as const
function topicOfQuery(queryText: string): { topic: TaxonomyTopic; index: number } {
  for (const topic of taxonomyTopics) {
    const index = topic.queries.indexOf(queryText)
    if (index >= 0) return { topic, index }
  }
  throw new Error('POLICY_SEARCH_QUERY')
}

/** Two synthetic sources per server phrase, on different example domains. */
export function demoScoutEvidence(queryText: string): Evidence[] {
  const { topic, index } = topicOfQuery(queryText)
  const [first, second] = demoHosts[index % demoHosts.length]!
  const observedAt = new Date().toISOString()
  return [
    {
      url: `https://${first}/${topic.id}/demand`,
      title: `Демо-источник: ${topic.label}`,
      snippet: `Синтетический пример запроса аудитории «${topic.audience}». Поиск не выполнялся.`,
      observedAt,
      demo: true,
    },
    {
      url: `https://${second}/${topic.id}/offers`,
      title: `Демо-источник: предложения и цены, ${topic.label.toLowerCase()}`,
      snippet: 'Синтетический пример конкурентов и цен. Реальные продажи не подтверждены.',
      observedAt,
      demo: true,
    },
  ]
}

/** One angle per scouting of the topic; repeated scouting moves to the next angle. */
export function demoIdea(args: {
  topic: TaxonomyTopic
  evidence: Evidence[]
  params: StrategyParams
  previousOnTopic: number
}): IdeaResearch {
  const { topic, params } = args
  // Broad agents start from the second angle, which often needs a person.
  const offset = params.ideaScope === 'broad' ? 1 : 0
  const angle = topic.angles[(args.previousOnTopic + offset) % topic.angles.length]!
  const template = angle.template
  const domains = new Map<string, Evidence>()
  for (const item of args.evidence) {
    const host = new URL(item.url).hostname
    if (!domains.has(host)) domains.set(host, item)
  }
  const signals = [...domains.values()].slice(0, params.evidenceMinimum)
  const service = template ? serviceByTemplate[template] : null
  return {
    title: angle.title,
    audience: topic.audience,
    problem: angle.problem,
    demandSignals: signals.map((item) => ({
      claim: `Пример из демо-данных: ${item.title.replace(/^Демо-источник: /, '')}`.slice(0, 300),
      url: item.url,
    })),
    competitors: ['Исполнители на биржах фриланса', 'Бесплатные шаблоны из поиска'],
    revenueModel: template ? 'service_fee' : 'one_time_sale',
    revenueNote: template
      ? 'Оплата за каждый готовый текст по цене из списка фермы.'
      : 'Оплата за услугу, которую выполняют люди.',
    startupCostRub: template ? 0 : params.riskAppetite === 'medium' ? 60000 : 25000,
    monthlyCostRub: template ? 500 : 15000,
    risks: ['Спрос не подтверждён продажами.', 'Часть задач закрывают бесплатные альтернативы.'],
    quickTest: 'Показать предложение 20 людям из аудитории и посчитать заявки за неделю.',
    farmExecutable: !!template,
    suggestedTemplate: template,
    executionNote: service
      ? `Ферма пишет текст по данным покупателя: тип услуги «${service.label}».`
      : 'Нужны люди, выезд или личный контакт. Ферма готовит только тексты.',
    launchPlanForHuman: template
      ? []
      : [
          'Найти двух исполнителей и договориться о цене.',
          'Разместить объявление в районе и собрать первые заявки.',
          'Через неделю сравнить заявки и расходы.',
        ],
    uncertainties: ['Демо-данные. Спрос, цены и конкуренты не проверены.'],
  }
}

/**
 * Demo critic: better parameters pass more often. With founder parameters, Разведчик А passes
 * every idea and Г one in four, so a demo selection round has a real gap to measure.
 */
export function demoIdeaCritique(args: {
  params: StrategyParams
  previousByAgent: number
  duplicate: boolean
}): { verdict: 'PASS' | 'REVISE' | 'BLOCKED'; reason: string } {
  if (args.duplicate)
    return { verdict: 'REVISE', reason: 'Почти такая идея уже есть. Нужен другой угол.' }
  const p = args.params
  const slots =
    1 +
    (p.evidenceMinimum === 3 ? 1 : 0) +
    (p.riskAppetite === 'low' ? 1 : 0) +
    (p.ideaScope === 'narrow' ? 1 : 0)
  const position = args.previousByAgent % 4
  if (position >= 4 - slots)
    return { verdict: 'PASS', reason: 'Понятная аудитория и простой способ проверить спрос.' }
  if (position === 0 && p.riskAppetite === 'medium')
    return { verdict: 'BLOCKED', reason: 'Слишком дорогой старт для проверки, спрос не виден.' }
  return { verdict: 'REVISE', reason: 'Слабые признаки спроса, нужен более узкий сегмент.' }
}

export function demoProductOffer(
  template: Template,
  idea?: { title: string; audience: string } | null,
): ProductSpec & { priceId?: PriceId; page: ProductPageSpec } {
  const service = serviceByTemplate[template]
  return {
    ...demoSpecs[template],
    priceId: priceIdFor(defaultPriceKopecks[template]) ?? undefined,
    page: {
      headline: idea?.title ?? service.label,
      forWhom: [idea?.audience ?? service.audience],
      youGet: [service.delivery, 'Готовый текст за несколько минут.', 'Файл .txt для скачивания.'],
      limits: ['Пишем только по вашим фактам, без выдумок.'],
    },
  }
}

export function demoReport(
  metrics: Record<string, number>,
  ranking: { ideaId: string; title: string; status: string }[],
): ReportNarrative {
  const top = ranking.slice(0, 3)
  const ideas = metrics.ideas ?? 0
  return {
    headline: `${ideas} ${ideasWord(ideas)}, ${metrics.accepted ?? 0} в работу`,
    summary: `Демо-отчёт собран по цифрам, без вызова модели. Разведчики принесли ${metrics.ideas ?? 0} идей, критик принял ${metrics.passed ?? 0}. Ферма может сделать сама ${metrics.accepted ?? 0}, ещё ${metrics.needsHuman ?? 0} требуют человека.`,
    ideaComments: top.map((item) => ({
      ideaId: item.ideaId,
      comment:
        item.status === 'accepted' || item.status === 'productized'
          ? 'Ферма может сделать сама, проверим на сайте.'
          : item.status === 'needs_human'
            ? 'Нужен человек: оставляем в рейтинге с планом.'
            : 'Ждёт решения критика.',
    })),
    nextActions: ['Собрать продукт по лучшей идее.', 'Найти запросы клиентов по продуктам.'],
    needsOwner: (metrics.needsHuman ?? 0) > 0 ? ['Посмотреть идеи с меткой «Нужен человек».'] : [],
  }
}

export function demoReplyDraft(product: {
  name: string
  promise: string
  priceKopecks: number
  publicUrl: string
}) {
  return (
    `Здравствуйте! Увидел ваш запрос. Мы делаем такую работу: ${product.name.toLowerCase()}. ` +
    `${product.promise} Цена ${formatRub(product.priceKopecks)}, текст готов за несколько минут. ` +
    `Пример и заказ здесь: ${product.publicUrl}. Пришлите вводные, и я подготовлю первый вариант.`
  )
}
