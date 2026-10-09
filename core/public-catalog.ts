import { config } from './config'
import { pool, query, type Connection } from './db'
import type { PaymentModeInfo, ProductPage } from './contracts/common'
import type { PublicCatalog, PublicService } from './contracts/public'
import { serviceByTemplate, type ServiceTemplate } from './service-catalog'
import { serviceNames } from './service-names'
import { sourceSocialDelivery, sourceSocialInputLimit } from './source-posts'
import { publicServiceProjection } from './storefront'

/**
 * Buyer wording per service type: name, one-line promise, shelf on the storefront and three
 * honest points of what the buyer gets. It never promises more than the server recipe delivers.
 * The owner's own product page (`products.page`) wins over these defaults.
 */
export const buyerCopy: Readonly<
  Record<
    ServiceTemplate,
    { name: string; promise: string; shelf: string; youGet: string[]; placeholder: string }
  >
> = Object.freeze({
  description: {
    name: serviceNames.description,
    promise: 'Карточка без воды из ваших характеристик',
    shelf: 'Для магазина',
    youGet: [
      'Название товара',
      'Характеристики аккуратным списком',
      'Только факты из вашего текста',
    ],
    placeholder: 'Кружка, керамика, 300 мл, белая, можно в посудомойку',
  },
  faq: {
    name: serviceNames.faq,
    promise: 'Вопросы и ответы, которые снимут лишние звонки',
    shelf: 'Для сайта',
    youGet: [
      'Вопросы и ответы по вашим условиям',
      'Список того, что стоит уточнить',
      'Без выдуманных обещаний',
    ],
    placeholder: 'Ремонт велосипедов. Диагностика 1 день, только по записи, доставки нет',
  },
  social: {
    name: serviceNames.social,
    promise: 'Один текст, три готовых поста',
    shelf: 'Для соцсетей',
    youGet: ['3 варианта поста', 'Ваши факты без искажений', 'Публикуете сами, когда удобно'],
    placeholder: 'Новость, статья или описание товара, до 3 000 знаков',
  },
  proofreading: {
    name: serviceNames.proofreading,
    promise: 'Без ошибок, смысл не трогаем',
    shelf: 'Тексты и документы',
    youGet: ['Исправленный текст', 'Список правок', 'Факты и смысл на месте'],
    placeholder: 'Вставьте текст, который нужно вычитать',
  },
  translation: {
    name: serviceNames.translation,
    promise: 'Цифры и факты на месте',
    shelf: 'Тексты и документы',
    youGet: ['Перевод всего текста', 'Числа и названия без искажений', 'Язык выбираете вы'],
    placeholder: 'Язык перевода: английский\nДалее ваш текст',
  },
  summary: {
    name: serviceNames.summary,
    promise: 'Главное из длинного текста',
    shelf: 'Тексты и документы',
    youGet: ['Короткий пересказ', 'Ключевые факты списком', 'Ничего сверх вашего текста'],
    placeholder: 'Вставьте статью, отчёт или протокол',
  },
  email: {
    name: serviceNames.email,
    promise: 'Вежливо, по делу, за минуту',
    shelf: 'Для магазина',
    youGet: ['Тема письма', 'Текст ответа', 'Только ваши условия'],
    placeholder: 'Вопрос клиента без имён и ваши условия',
  },
  landing: {
    name: serviceNames.landing,
    promise: 'Заголовок и текст, который продаёт',
    shelf: 'Для сайта',
    youGet: ['Заголовок', 'Блоки страницы', 'Список того, что стоит уточнить'],
    placeholder: 'Что за услуга, что входит, сроки, цена, ограничения',
  },
  proposal: {
    name: serviceNames.proposal,
    promise: 'КП, которое не стыдно отправить',
    shelf: 'Тексты и документы',
    youGet: ['Объём работ', 'Известные условия', 'Вопросы клиенту'],
    placeholder: 'Запрос клиента, состав работ, сроки и условия',
  },
  instruction: {
    name: serviceNames.instruction,
    promise: 'Шаги, которые легко повторить',
    shelf: 'Тексты и документы',
    youGet: ['Шаги по порядку', 'Предупреждения и ограничения', 'Чего не хватило в описании'],
    placeholder: 'Как вы делаете работу сейчас, шаг за шагом',
  },
  lesson: {
    name: serviceNames.lesson,
    promise: 'Короткий урок с вопросом для проверки',
    shelf: 'Тексты и документы',
    youGet: ['Объяснение простыми словами', 'Вопрос для самопроверки', 'Ответ к вопросу'],
    placeholder: 'Учебный материал, на который у вас есть права',
  },
  job_post: {
    name: serviceNames.job_post,
    promise: 'Понятные задачи и условия',
    shelf: 'Для найма',
    youGet: ['Текст вакансии', 'Задачи и требования', 'Условия работы'],
    placeholder: 'Роль, задачи, навыки, график, оплата',
  },
})

/** One line on every public page. Sandbox, Sepolia and local anvil say it differently. */
export function testNotice() {
  const c = config()
  if (c.PAYMENT_MODE !== 'sepolia')
    return 'Тестовый магазин: оплата ненастоящая, деньги не списываются.'
  return c.SEPOLIA_LOCAL_NODE
    ? 'Тестовый магазин: оплата в локальной тестовой сети, настоящие деньги не списываются.'
    : 'Тестовый магазин: оплата в тестовой сети Sepolia, настоящие деньги не списываются.'
}

export function paymentModeInfo(): PaymentModeInfo {
  return config().PAYMENT_MODE === 'sepolia'
    ? { mode: 'sepolia', test: true, label: 'Тестовый ETH, сеть Sepolia' }
    : { mode: 'sandbox', test: true, label: 'Тестовая оплата' }
}

type ProductRow = Record<string, any>

const plain = (text: unknown) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
/**
 * The owner's page headline replaces the default promise only when it says something new: a
 * short line that is not the service name or the title of the idea it grew from.
 */
export function ownHeadline(headline: string | undefined, repeats: unknown[]) {
  if (!headline || headline.length >= 60) return null
  const value = plain(headline)
  return repeats.some((item) => {
    const other = plain(item)
    return other && (value === other || value.startsWith(other) || other.startsWith(value))
  })
    ? null
    : headline
}

/** Buyer view of one stored product: catalog projection plus buyer wording and checked sample. */
export function buyerService(row: ProductRow): PublicService | null {
  const template = row.template as ServiceTemplate
  const service = serviceByTemplate[template]
  if (!service) return null
  const base = publicServiceProjection(row as any, service, {
    paymentMode: config().PAYMENT_MODE,
    // Posts laid out from the full source text accept a shorter input.
    ...(template === 'social' && row.spec?.promise === sourceSocialDelivery
      ? { inputLimit: sourceSocialInputLimit }
      : {}),
  })
  const copy = buyerCopy[template]
  const page: ProductPage = { youGet: copy.youGet, ...base.page }
  const checks = row.checks && typeof row.checks === 'object' ? row.checks : {}
  // A checked control example becomes "you sent / we made". Demo output is never shown.
  const sample =
    !row.is_demo &&
    checks.normal === 'PASS' &&
    typeof checks.input === 'string' &&
    typeof checks.sample === 'string' &&
    !/[<>]/.test(checks.input + checks.sample)
      ? { input: checks.input.slice(0, 1200), output: checks.sample.slice(0, 2400) }
      : undefined
  return {
    ...base,
    name: copy.name,
    promise: ownHeadline(base.page.headline, [copy.name, row.idea_title]) || copy.promise,
    category: copy.shelf,
    page,
    placeholder: copy.placeholder,
    ...(sample ? { sample } : {}),
  }
}

const publicColumns =
  'template,slug,version,price_kopecks,page,is_demo,spec,checks,(SELECT i.title FROM ideas i WHERE i.id=products.idea_id) AS idea_title'
/** Demo products reach buyers only on a demo stand, never on a stand with a real model. */
const demoAllowed = () => config().MODEL_PROVIDER === 'demo'

/**
 * Public orders of this UTC day: `open` counts orders created today that are still waiting for
 * payment or got paid (expired ones free their slot), `paid` counts payments confirmed today.
 */
export async function publicDayCounts(db: Connection = pool) {
  const [row] = await query(
    `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start)
     SELECT
       count(*) FILTER (WHERE created_at>=day.start
         AND (paid_at IS NOT NULL OR status='awaiting_payment'))::int AS open,
       count(*) FILTER (WHERE paid_at>=day.start)::int AS paid
     FROM orders, day WHERE source='public' AND (created_at>=day.start OR paid_at>=day.start)`,
    [],
    db,
  )
  return { open: row!.open as number, paid: row!.paid as number }
}

/** Whether a buyer may start an order right now. */
export async function acceptingOrders() {
  const c = config()
  const [state] = await query('SELECT mode FROM system_state WHERE id=true')
  const day = await publicDayCounts()
  return (
    state?.mode === 'running' &&
    day.open < c.PUBLIC_ORDERS_PER_DAY &&
    day.paid < c.PUBLIC_PAID_ORDERS_PER_DAY
  )
}

function seller() {
  const c = config()
  return c.PUBLIC_SELLER && c.PUBLIC_CONTACT
    ? { name: c.PUBLIC_SELLER, contact: c.PUBLIC_CONTACT, termsUrl: c.PUBLIC_TERMS_URL || null }
    : null
}

/** Products the owner published. Private, archived and unknown templates never leave the server. */
export async function publicCatalog(): Promise<PublicCatalog> {
  const rows = await query(
    `SELECT ${publicColumns} FROM products
     WHERE status='sandbox' AND visibility='public' AND (NOT is_demo OR $1)
     ORDER BY published_at,slug`,
    [demoAllowed()],
  )
  return {
    services: rows.map(buyerService).filter((s): s is PublicService => !!s),
    payment: paymentModeInfo(),
    acceptingOrders: await acceptingOrders(),
    notice: testNotice(),
    seller: seller(),
  }
}

/** One published product by slug; anything else is the same 404. */
export async function publicService(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new Error('SERVICE_NOT_FOUND')
  const [row] = await query(
    `SELECT ${publicColumns} FROM products
     WHERE slug=$1 AND status='sandbox' AND visibility='public' AND (NOT is_demo OR $2)`,
    [slug, demoAllowed()],
  )
  const service = row && buyerService(row)
  if (!service) throw new Error('SERVICE_NOT_FOUND')
  return {
    service,
    payment: paymentModeInfo(),
    acceptingOrders: await acceptingOrders(),
    notice: testNotice(),
    seller: seller(),
  }
}
