import { pool, query, type Connection } from './db'
import { agentLabels, agentName, describeMutation, type StrategyRow } from './agents'
import { formatRub } from './storefront'
import { orderTitle, serviceName } from './service-names'

/**
 * The owner's feed on the main screen: audit events rewritten as short human lines, the way
 * product.md section 7 shows them. No dashes, arrows, codes or internal names.
 */
export type FeedEvent = {
  id?: number | string
  kind: string
  message: string
  data: Record<string, any>
  created_at: Date | string
}
export type FeedItem = { at: string; kind: string; text: string; link: string | null }
export type FeedContext = {
  label: (agentId: string) => string
  orders: Map<
    string,
    {
      name: string
      /** Short order number from orders.number. */
      number?: number | string | null
      priceKopecks: number
      paidAt: string | null
      deliveredAt: string | null
    }
  >
  jobOrders: Map<string, string>
}

/** Russian plural: 1 источник, 2 источника, 5 источников. */
export function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** Model and search text may carry decorations; the feed never shows them. */
export function cleanText(text: unknown, max = 160) {
  const value = String(text ?? '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[→←↗↑↓⇒]/g, ' ')
    .replace(/\s*·\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value
}

/**
 * Instructions the text check gives the model («Допиши мысль до конца»), rewritten as what the
 * owner needs to know: what was wrong. Order matters: whole sentences first.
 */
const buildErrorRewrites: [RegExp, string][] = [
  [/^\s*Сборка не прошла проверку:\s*/iu, ''],
  [/\s*Пиши только по-русски[^.]*\./gu, ''],
  [/\s*Пиши по-русски[^.]*\./gu, ''],
  [/\s*Замени его русским словом[^.]*\./gu, ''],
  [/\s*Пиши обычный текст для человека\./gu, ''],
  [/\s*Сохрани все факты и формат[^.]*\./gu, ''],
  [/\s*Остальные поля ответа оставь как были\./gu, ''],
  [/Не используй длинное тире[^.]*\./gu, 'В тексте длинное тире.'],
  [/(Две точки подряд\.)\s*Поставь одну точку\./gu, '$1'],
  [/(Текст обрывается на середине фразы\.)\s*Допиши мысль до конца\./gu, '$1'],
  [
    /Заголовок должен называть эту услугу \((«[^»]*»)\)[^.]*\./gu,
    'Заголовок страницы не называет услугу $1.',
  ],
  [/отклонён \(REVISE\)/gu, 'вернули на доработку'],
  [/\s*\((?:REVISE|BLOCKED|PASS)\)/gu, ''],
  [/гипотезу/gu, 'продукт'],
]

/** Why a build from an idea failed, as the owner reads it: no model instructions or codes. */
export function buildErrorText(text: unknown) {
  let value = String(text ?? '').trim()
  for (const [pattern, replacement] of buildErrorRewrites)
    value = value.replace(pattern, replacement)
  value = value.replace(/\s+/g, ' ').trim()
  if (!value) return 'Серверная проверка отклонила продукт.'
  return value[0]!.toUpperCase() + value.slice(1)
}

/** «Контрольный пример» -> «контрольный пример» inside a sentence; acronyms stay. */
const lowerFirst = (value: string) =>
  /^\p{Lu}\p{Ll}+(?!\p{L})/u.test(value) ? value[0]!.toLowerCase() + value.slice(1) : value

/** «Заказ №1042» for an order id the context knows; plain «Заказ» otherwise. */
const orderOf = (ctx: FeedContext, id: unknown) => orderTitle(ctx.orders.get(String(id))?.number)
const named = (ctx: FeedContext, id: unknown) => agentName(ctx.label(String(id)))
const genitive = (ctx: FeedContext, id: unknown) => `Разведчика ${ctx.label(String(id))}`
const templateLabel = (template: unknown) => serviceName(template, 'текстовая услуга')
/** Products are named by their service type, the same as on the site. */
const productName = (d: Record<string, any>) => serviceName(d.template, cleanText(d.name))

export function feedItems(event: FeedEvent, ctx: FeedContext): FeedItem[] {
  const d = event.data ?? {}
  const at = new Date(event.created_at).toISOString()
  const item = (text: string, link: string | null = null): FeedItem[] => [
    { at, kind: event.kind, text: cleanText(text, 300), link },
  ]
  switch (event.kind) {
    case 'scouts_assigned':
    case 'idea_research_scheduled':
      return item(
        event.message,
        event.kind === 'scouts_assigned' ? '/office/agents' : '/office/ideas',
      )
    case 'agent_params_assigned':
      return item('Разведчикам назначены отрасли для поиска идей.', '/office/agents')
    case 'idea_found': {
      const n = Number(d.sources) || 0
      return item(
        `${named(ctx, d.agentId)} нашёл идею: ${cleanText(d.title)}. ${n} ${plural(n, 'источник', 'источника', 'источников')}.`,
        `/office/ideas/${d.ideaId}`,
      )
    }
    case 'idea_reviewed': {
      const link = `/office/ideas/${d.ideaId}`
      if (d.verdict === 'PASS')
        return item(`Критик принял идею ${genitive(ctx, d.agentId)}: ${cleanText(d.title)}.`, link)
      if (d.verdict === 'BLOCKED')
        return item(
          `Критик отклонил идею ${genitive(ctx, d.agentId)}: ${cleanText(d.reason)}`,
          link,
        )
      return item(
        `Критик вернул на доработку идею ${genitive(ctx, d.agentId)}: ${cleanText(d.reason)}`,
        link,
      )
    }
    case 'idea_needs_human':
      return item(
        `Идея «${cleanText(d.title)}» требует человека. Оставили в рейтинге с планом запуска.`,
        `/office/ideas/${d.ideaId}`,
      )
    case 'idea_build_failed': {
      const reason = buildErrorText(d.reason)
      return item(
        `Сборка по идее «${cleanText(d.title)}» не прошла проверку: ${lowerFirst(reason)}`,
        `/office/ideas/${d.ideaId}`,
      )
    }
    case 'idea_taken':
      return item(`Вы взяли идею в работу: «${cleanText(d.title)}».`, `/office/ideas/${d.ideaId}`)
    case 'idea_released':
      return item(
        `Идея «${cleanText(d.title)}» больше не в работе у вас.`,
        `/office/ideas/${d.ideaId}`,
      )
    case 'product_published':
      return item(
        `Новый продукт на сайте: «${productName(d)}», ${formatRub(Number(d.priceKopecks) || 0)}. Пример прошёл проверку.`,
        '/office/products',
      )
    case 'product_created':
      // Idea research announces the storefront product separately (product_published).
      if (d.ideaId) return []
      return item(
        `Собран продукт «${templateLabel(d.template)}». На сайте пока скрыт.`,
        '/office/products',
      )
    case 'product_updated':
      if (d.hidden)
        return item(
          `Новая версия продукта «${productName(d)}» готова. На сайте он скрыт по вашему решению.`,
          '/office/products',
        )
      if (d.ideaId) return []
      return item(`Вышла новая версия продукта «${templateLabel(d.template)}».`, '/office/products')
    case 'product_visibility':
      return item(
        `Продукт «${productName(d)}» ${d.visibility === 'public' ? 'показан на сайте' : 'скрыт с сайта'}.`,
        '/office/products',
      )
    case 'lead_draft_ready':
      return item(
        `Найден возможный клиент${d.host ? ` на ${d.host}` : ''}: «${cleanText(d.title, 100)}». Отклик готов.`,
        '/office/leads',
      )
    case 'lead_search_completed': {
      const saved = Number(d.saved) || 0
      if (!saved || saved <= (Number(d.drafted) || 0)) return []
      return item(
        `Найдено ${saved} ${plural(saved, 'новый запрос', 'новых запроса', 'новых запросов')} от возможных клиентов.`,
        '/office/leads',
      )
    }
    case 'test_payment_confirmed': {
      const order = ctx.orders.get(String(d.orderId))
      if (!order) return []
      return item(
        `${orderOf(ctx, d.orderId)} (тест): «${cleanText(order.name)}», ${formatRub(order.priceKopecks)}.`,
        `/office/orders/${d.orderId}`,
      )
    }
    case 'late_payment_received':
      return item(
        `${orderOf(ctx, d.orderId)}: перевод пришёл после срока счёта. Верните его вручную.`,
        `/office/orders/${d.orderId}`,
      )
    case 'payment_hash_replaced':
      return item(
        `${orderOf(ctx, d.orderId)}: неверный номер перевода заменён найденным переводом.`,
        `/office/orders/${d.orderId}`,
      )
    case 'order_delivered': {
      const order = ctx.orders.get(String(d.orderId))
      const minutes =
        order?.paidAt && order.deliveredAt
          ? Math.max(
              1,
              Math.round(
                (new Date(order.deliveredAt).getTime() - new Date(order.paidAt).getTime()) / 60000,
              ),
            )
          : null
      return item(
        `${orderOf(ctx, d.orderId)} готов${minutes ? ` за ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}` : ''}.`,
        `/office/orders/${d.orderId}`,
      )
    }
    case 'job_error': {
      if (!d.terminal) return []
      if (d.kind === 'fulfill') {
        const orderId = ctx.jobOrders.get(String(d.jobId))
        return orderId
          ? item(
              `${orderOf(ctx, orderId)} не прошёл проверку. Посмотрите.`,
              `/office/orders/${orderId}`,
            )
          : []
      }
      if (d.kind === 'scout') return item('Разведка не удалась. Тема вернётся в очередь позже.')
      if (d.kind === 'research')
        return item('Сборка продукта не удалась. Идея осталась в рейтинге.')
      return []
    }
    case 'evolution_rotated': {
      const lines: FeedItem[] = []
      for (const fired of d.archived ?? []) {
        const n = Number(fired.passed) || 0
        lines.push(
          ...item(
            `Отбор поколения ${d.generation}: ${agentName(fired.label ?? '?')} уволен, ${n} ${plural(n, 'принятая идея', 'принятые идеи', 'принятых идей')} из ${fired.ideas}.`,
            '/office/agents',
          ),
        )
      }
      for (const child of d.children ?? [])
        lines.push(
          ...item(
            `${agentName(child.parentLabel ?? '?')} скопирован. Копия ${child.label} ${describeMutation(child.mutation)}.`,
            '/office/agents',
          ),
        )
      return lines
    }
    case 'evolution_hold':
      return item(`Отбор пропущен: ${cleanText(d.reason)}`, '/office/agents')
    case 'evolution_requested':
      return item('Вы попросили проверить отбор.', '/office/agents')
    case 'evaluation':
      return d.decision === 'CLOSED'
        ? item('Сезон закончился без продаж. Можно начать новый.', '/office/settings')
        : item('Отбор по выручке пропущен: продаж пока нет.', '/office/agents')
    case 'simulation':
      return item('Симуляция отбора на учебных данных. Деньги не учитывались.', '/office/agents')
    case 'report_ready':
      return item(
        d.headline
          ? `Руководитель написал отчёт: ${cleanText(d.headline).replace(/^Демо-отч[её]т:\s*/i, '')}`
          : 'Руководитель собрал отчёт по цифрам.',
        '/office/reports',
      )
    case 'farm_daily_budget_wait':
    case 'research_daily_budget_wait':
      return item(
        d.dailyKopecks
          ? `Дневной лимит ${formatRub(Number(d.dailyKopecks))} исчерпан. Работа продолжится завтра.`
          : 'Дневной лимит исчерпан. Работа продолжится завтра.',
        '/office/money',
      )
    case 'control':
      if (d.mode === 'paused')
        return item('Вы поставили ферму на паузу. Начатые заказы доделываем.')
      if (d.mode === 'emergency_stop')
        return item('Вы остановили ферму. Новые задачи не начинаются.')
      return item('Ферма снова работает.')
    case 'settings_changed':
      return item('Вы изменили настройки фермы.', '/office/settings')
    case 'research_restarted':
      return item('Начался новый сезон на 28 дней.', '/office/settings')
    default:
      return []
  }
}

export const feedKinds = [
  'scouts_assigned',
  'idea_research_scheduled',
  'agent_params_assigned',
  'idea_found',
  'idea_reviewed',
  'idea_needs_human',
  'idea_build_failed',
  'idea_taken',
  'idea_released',
  'product_published',
  'product_created',
  'product_updated',
  'product_visibility',
  'lead_draft_ready',
  'lead_search_completed',
  'test_payment_confirmed',
  'late_payment_received',
  'payment_hash_replaced',
  'order_delivered',
  'job_error',
  'evolution_rotated',
  'evolution_hold',
  'evolution_requested',
  'evaluation',
  'simulation',
  'report_ready',
  'farm_daily_budget_wait',
  'research_daily_budget_wait',
  'control',
  'settings_changed',
  'research_restarted',
]

/**
 * Context for feed lines: agent labels, and the orders the events mention (directly or through
 * a fulfilment job) with their short numbers and the shared service name.
 */
export async function feedContext(
  events: FeedEvent[],
  db: Connection = pool,
): Promise<FeedContext> {
  const orderIds = new Set<string>()
  const jobIds = new Set<string>()
  for (const event of events) {
    if (event.data?.orderId) orderIds.add(String(event.data.orderId))
    if (event.kind === 'job_error' && event.data?.kind === 'fulfill' && event.data.jobId)
      jobIds.add(String(event.data.jobId))
  }
  const [strategies, jobs] = await Promise.all([
    query<StrategyRow>('SELECT id,name,parent_id,generation,created_at FROM strategies', [], db),
    jobIds.size
      ? query(
          `SELECT id,payload->>'orderId' AS order_id FROM jobs WHERE id::text=ANY($1)`,
          [[...jobIds]],
          db,
        )
      : Promise.resolve([]),
  ])
  for (const job of jobs) if (job.order_id) orderIds.add(String(job.order_id))
  const orders = orderIds.size
    ? await query(
        `SELECT o.id,o.number,p.template,o.product_snapshot->>'name' AS name,
           COALESCE(NULLIF(o.price_kopecks,0),p.price_kopecks) AS price_kopecks,o.paid_at,o.delivered_at
         FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id::text=ANY($1)`,
        [[...orderIds]],
        db,
      )
    : []
  const labels = agentLabels(strategies)
  return {
    label: (id) => labels.get(id) ?? '?',
    orders: new Map(
      orders.map((o) => [
        o.id as string,
        {
          name: serviceName(o.template, (o.name as string) || 'Заказ'),
          number: o.number as string,
          priceKopecks: o.price_kopecks as number,
          paidAt: o.paid_at ? new Date(o.paid_at).toISOString() : null,
          deliveredAt: o.delivered_at ? new Date(o.delivered_at).toISOString() : null,
        },
      ]),
    ),
    jobOrders: new Map(jobs.map((j) => [j.id as string, j.order_id as string])),
  }
}

/** Latest feed lines, newest first. */
export async function activityFeed(limit = 30, db: Connection = pool): Promise<FeedItem[]> {
  const events = await query<FeedEvent>(
    `SELECT id,kind,message,data,created_at FROM audit_events WHERE kind=ANY($1)
     ORDER BY id DESC LIMIT $2`,
    [feedKinds, Math.min(500, limit * 4)],
    db,
  )
  const ctx = await feedContext(events, db)
  // Repeated identical lines in a row (several lead searches) are shown once.
  return events
    .flatMap((event) => feedItems(event, ctx))
    .filter((item, index, all) => index === 0 || all[index - 1]!.text !== item.text)
    .slice(0, limit)
}
