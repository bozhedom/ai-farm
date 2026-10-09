import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { config, usesSourcePosts } from './config'
import { audit, query, transaction } from './db'
import { budgetSummary } from './budget'
import { enqueue } from './queue'
import { activityFeed, cleanText, feedContext, feedItems, type FeedEvent } from './activity-feed'
import { orderTitle, serviceName } from './service-names'
import {
  agentLabels,
  agentMetrics,
  agentName,
  defaultParams,
  founderIndex,
  parseParams,
  type StrategyRow,
} from './agents'
import { currentScores, evolutionStatus, type ScoredAgent } from './evolution'
import { categoryById, taxonomyCategories, topicById } from './taxonomy'
import { sourceSocialDelivery } from './source-posts'
import { publicSlug } from './storefront'
import { beforeDailyHour, nextDailyRun } from './autonomy'
import type {
  BudgetCategory,
  EvolutionRound,
  IdeaStatus,
  OfficeAgent,
  OfficeAgents,
  OfficeIdea,
  OfficeIdeaList,
  OfficeLead,
  OfficeLeadList,
  OfficeMoney,
  OfficeJournal,
  OfficeOrderList,
  OfficeOverview,
  OfficeProduct,
  OfficeProductList,
  OfficeReport,
  OfficeReportList,
  OfficeSettings,
} from './contracts/office'

/**
 * Read models for the owner office (`/api/office/**`). Every route sits behind the owner
 * session in server/middleware/security.ts. Test payments and real revenue stay separate.
 */
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null)
const todayStart = "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
const origin = () => new URL(config().APP_ORIGIN).origin
export const publicUrl = (slug: string) => `${origin()}/services/${publicSlug(slug)}`

async function labelsNow() {
  const rows = await query<StrategyRow>(
    'SELECT id,name,parent_id,generation,created_at FROM strategies',
  )
  const labels = agentLabels(rows)
  return (id: string) => labels.get(id) ?? '?'
}

const farmActivity: Record<string, string> = {
  scout: 'разведчик ищет идею',
  research: 'собирается продукт',
  lead: 'ищем клиентов',
  report: 'руководитель пишет отчёт',
  fulfill: 'пишем текст заказа',
  evolve: 'проходит отбор',
}

export async function officeOverview(now = new Date()): Promise<OfficeOverview> {
  const [states, [today], [totals], budget, feed, running, [review], [drafts], [human], [calls]] =
    await Promise.all([
      query('SELECT * FROM system_state WHERE id=true'),
      query(
        `SELECT
          (SELECT count(*)::int FROM ideas WHERE created_at >= ${todayStart}) AS ideas,
          (SELECT count(*)::int FROM ideas WHERE created_at >= ${todayStart} AND status IN ('accepted','productized')) AS accepted,
          (SELECT count(*)::int FROM products WHERE visibility='public' AND published_at >= ${todayStart}) AS published,
          (SELECT count(*)::int FROM orders WHERE delivered_at >= ${todayStart}) AS delivered,
          (SELECT count(*)::int FROM opportunities WHERE first_seen_at >= ${todayStart}) AS leads`,
      ),
      query(
        `SELECT
          (SELECT count(*)::int FROM ideas) AS ideas,
          (SELECT count(*)::int FROM products WHERE status='sandbox') AS products,
          (SELECT count(*)::int FROM products WHERE status='sandbox' AND visibility='public'
             AND (NOT is_demo OR ${config().MODEL_PROVIDER === 'demo'})) AS public_products,
          (SELECT count(*)::int FROM orders) AS orders,
          (SELECT COALESCE(sum(revenue_kopecks),0)::int FROM orders) AS revenue,
          (SELECT count(*)::int FROM orders WHERE paid_at IS NOT NULL AND is_test_payment) AS test_payments,
          (SELECT count(*)::int FROM orders WHERE status='delivered') AS delivered,
          (SELECT count(*)::int FROM strategies WHERE status='active') AS agents,
          (SELECT count(*)::int FROM opportunities WHERE stage='new') AS new_leads,
          (SELECT COALESCE(sum(COALESCE(NULLIF(o.price_kopecks,0),p.price_kopecks)),0)::int
             FROM orders o JOIN products p ON p.id=o.product_id
             WHERE o.paid_at IS NOT NULL AND o.is_test_payment) AS test_kopecks`,
      ),
      budgetSummary(),
      activityFeed(30),
      query(
        "SELECT id,kind,payload FROM jobs WHERE status='running' ORDER BY started_at DESC NULLS LAST LIMIT 1",
      ),
      query(
        `SELECT count(*) OVER ()::int AS n,id AS first,number FROM orders
         WHERE status='manual_review' ORDER BY created_at,id LIMIT 1`,
      ),
      query(
        "SELECT count(*)::int AS n FROM opportunities WHERE reply_draft IS NOT NULL AND stage='new'",
      ),
      query("SELECT count(*)::int AS n FROM ideas WHERE status='needs_human'"),
      query("SELECT count(*)::int AS n FROM tool_calls WHERE status='uncertain'"),
    ])
  const state = states[0]!
  const alive =
    !!state.worker_heartbeat && now.getTime() - new Date(state.worker_heartbeat).getTime() < 90000
  const scheduled = config().AUTONOMY_ENABLED && state.schedule_enabled
  const [scoutsToday] = await query(
    'SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE $1',
    [`scout:${now.toISOString().slice(0, 10)}:%`],
  )
  let reason: string
  let nextAt: string | null = null
  if (state.mode === 'emergency_stop') reason = 'Остановлено. Новые задачи не начинаются.'
  else if (state.mode === 'paused') reason = 'Пауза. Начатые заказы доделываем.'
  else if (!alive) reason = 'Сервер не отвечает. Задачи ждут в очереди.'
  else if (!state.research_enabled) reason = 'Сезон закрыт. Начните новый в настройках.'
  else if (running[0]) reason = `Работает: ${farmActivity[running[0].kind] ?? 'выполняет задачу'}.`
  else if (!scheduled) reason = 'Работает. Расписание выключено, поиск запускаете вы.'
  else {
    const hour = state.schedule_hour_utc ?? 0
    nextAt = nextDailyRun(now, hour, scoutsToday!.n > 0)
    reason = scoutsToday!.n
      ? 'Работает. Следующий поиск завтра.'
      : beforeDailyHour(now, hour)
        ? 'Работает. Поиск начнётся в назначенный час.'
        : 'Работает. Поиск начнётся в ближайшую минуту.'
  }
  const needsOwner: OfficeOverview['needsOwner'] = []
  if (review?.n)
    needsOwner.push({
      kind: 'orders',
      text:
        review.n === 1
          ? `${orderTitle(review.number)} ждёт вашей проверки.`
          : `Заказов на проверке: ${review.n}.`,
      link: review.n === 1 ? `/office/orders/${review.first}` : '/office/orders',
    })
  if (drafts!.n)
    needsOwner.push({
      kind: 'leads',
      text: `Откликов к отправке: ${drafts!.n}.`,
      link: '/office/leads',
    })
  if (human!.n)
    needsOwner.push({
      kind: 'ideas',
      text: `Идей, где нужен человек: ${human!.n}.`,
      link: '/office/ideas?status=needs_human',
    })
  if (calls!.n)
    needsOwner.push({
      kind: 'calls',
      text: 'Есть вызовы модели с неясным исходом. Посмотрите техжурнал.',
      link: '/office/settings',
    })
  if (!alive && state.mode !== 'emergency_stop')
    needsOwner.push({ kind: 'worker', text: 'Сервер не отвечает.', link: '/office/settings' })
  return {
    mode: state.mode,
    generation: state.generation,
    today: {
      ideas: today!.ideas,
      ideasAccepted: today!.accepted,
      productsPublished: today!.published,
      ordersDelivered: today!.delivered,
      leadsFound: today!.leads,
      spentKopecks: budget.daySpent,
    },
    totals: {
      ideas: totals!.ideas,
      products: totals!.products,
      publicProducts: totals!.public_products,
      orders: totals!.orders,
      realRevenueKopecks: totals!.revenue,
      testPayments: totals!.test_payments,
      ordersDelivered: totals!.delivered,
      testPaymentsKopecks: totals!.test_kopecks,
      activeAgents: totals!.agents,
      newLeads: totals!.new_leads,
    },
    worker: { alive, reason, nextAt },
    feed,
    needsOwner,
    now: running[0] ? await jobNow(running[0] as any) : null,
  }
}

function ideaView(
  row: Record<string, any>,
  label: (id: string) => string,
  checks: any[],
  products: Record<string, any>[] = [],
): OfficeIdea {
  const product = products.find((p) => p.idea_id === row.id)
  const r = row.research ?? {}
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])
  return {
    id: row.id,
    title: row.title,
    category: categoryById[row.category]?.label ?? row.category,
    topic: topicById[row.topic_id]?.label ?? row.topic_id,
    categoryId: row.category,
    topicId: row.topic_id,
    status: row.status,
    rankScore: row.rank_score,
    farmExecutable: row.farm_executable,
    suggestedTemplate: row.suggested_template,
    agent: { id: row.strategy_id, name: agentName(label(row.strategy_id)) },
    createdAt: iso(row.created_at)!,
    isDemo: row.is_demo,
    duplicateOf: row.duplicate_of,
    research: {
      audience: String(r.audience ?? ''),
      problem: String(r.problem ?? ''),
      demandSignals: Array.isArray(r.demandSignals)
        ? r.demandSignals.map((s: any) => ({ claim: String(s.claim), url: String(s.url) }))
        : [],
      competitors: list(r.competitors),
      revenueModel: String(r.revenueModel ?? ''),
      revenueNote: String(r.revenueNote ?? ''),
      startupCostRub: Number(r.startupCostRub) || 0,
      monthlyCostRub: Number(r.monthlyCostRub) || 0,
      risks: list(r.risks),
      quickTest: String(r.quickTest ?? ''),
      executionNote: String(r.executionNote ?? ''),
      launchPlanForHuman: list(r.launchPlanForHuman),
      uncertainties: list(r.uncertainties),
    },
    critique: { verdict: row.critique?.verdict, reason: String(row.critique?.reason ?? '') },
    checks: checks
      .filter((c) => c.idea_id === row.id)
      .map((c) => ({
        hypothesisId: c.id,
        status: c.status,
        productId: c.product_id ?? null,
        version: c.version ?? null,
        critique: String(c.critique?.reason ?? ''),
      })),
    ownerNote: row.owner_note,
    ownerStatus: row.owner_status === 'taken' ? 'taken' : null,
    ownerTakenAt: iso(row.owner_taken_at),
    product: product
      ? {
          id: product.id,
          name: serviceName(product.template, product.spec?.name ?? product.template),
          publicUrl: publicUrl(product.slug),
          visibility: product.visibility,
          status: product.status,
        }
      : null,
  }
}

/** The newest product built from each idea. */
async function ideaProducts(ids: string[]) {
  if (!ids.length) return []
  return query(
    `SELECT DISTINCT ON (idea_id) id,idea_id,slug,template,spec,visibility,status FROM products
     WHERE idea_id=ANY($1::uuid[]) ORDER BY idea_id,(status='sandbox') DESC,created_at DESC`,
    [ids],
  )
}

async function ideaChecks(ids: string[]) {
  if (!ids.length) return []
  return query(
    `SELECT h.id,h.idea_id,h.status,h.critique,v.product_id,v.version FROM hypotheses h
     LEFT JOIN product_versions v ON v.hypothesis_id=h.id
     WHERE h.idea_id=ANY($1::uuid[]) ORDER BY h.created_at`,
    [ids],
  )
}

export const ideaListSchema = z
  .object({
    status: z.enum(['new', 'accepted', 'needs_human', 'rejected', 'productized']).optional(),
    // An industry id or its Russian name, as shown in OfficeIdea.category.
    category: z
      .string()
      .max(120)
      .transform((value) => taxonomyCategories.find((c) => c.label === value)?.id ?? value)
      .refine((id) => Object.hasOwn(categoryById, id))
      .optional(),
    /** Who launches it: the farm, a person, rejected by the critic, or taken by the owner. */
    view: z.enum(['farm', 'human', 'rejected', 'taken']).optional(),
    offset: z.coerce.number().int().min(0).max(100000000).default(0),
  })
  .strict()

const ideaViews = {
  farm: "farm_executable AND status<>'rejected'",
  human: "NOT farm_executable AND status<>'rejected'",
  rejected: "status='rejected'",
  taken: "owner_status='taken'",
} as const

export async function officeIdeas(filter: unknown = {}): Promise<OfficeIdeaList> {
  const input = ideaListSchema.parse(filter)
  const limit = 30
  const values = [input.status ?? null, input.category ?? null]
  const where = `WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR category=$2)${
    input.view ? ` AND ${ideaViews[input.view]}` : ''
  }`
  const [rows, [count], label, [counts], byCategory] = await Promise.all([
    query(
      `SELECT * FROM ideas ${where} ORDER BY rank_score DESC,created_at DESC,id LIMIT $3 OFFSET $4`,
      [...values, limit, input.offset],
    ),
    query(`SELECT count(*)::int AS n FROM ideas ${where}`, values),
    labelsNow(),
    query(
      `SELECT count(*)::int AS "all",
        ${Object.entries(ideaViews)
          .map(([key, sql]) => `count(*) FILTER (WHERE ${sql})::int AS ${key}`)
          .join(',')}
       FROM ideas WHERE ($1::text IS NULL OR category=$1)`,
      [input.category ?? null],
    ),
    query('SELECT category,count(*)::int AS n FROM ideas GROUP BY category'),
  ])
  const ids = rows.map((row) => row.id)
  const [checks, products] = await Promise.all([ideaChecks(ids), ideaProducts(ids)])
  return {
    items: rows.map((row) => ideaView(row, label, checks, products)),
    total: count!.n,
    offset: input.offset,
    limit,
    hasMore: input.offset + rows.length < count!.n,
    categories: taxonomyCategories.map((c) => ({ id: c.id, label: c.label })),
    counts: {
      all: counts!.all,
      farm: counts!.farm,
      human: counts!.human,
      rejected: counts!.rejected,
      taken: counts!.taken,
      byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.n])),
    },
  }
}

export async function officeIdea(id: string): Promise<OfficeIdea> {
  if (!z.uuid().safeParse(id).success) throw new Error('IDEA_NOT_FOUND')
  const [row] = await query('SELECT * FROM ideas WHERE id=$1', [id])
  if (!row) throw new Error('IDEA_NOT_FOUND')
  return ideaView(row, await labelsNow(), await ideaChecks([id]), await ideaProducts([id]))
}

export const ideaUpdateSchema = z
  .object({
    ownerNote: z
      .string()
      .trim()
      .max(1000)
      .refine((s) => !/[<>]/.test(s), 'HTML_FORBIDDEN')
      .optional(),
    status: z.enum(['needs_human', 'rejected']).optional(),
    /** Take a "needs a person" idea into work (one at a time), or let it go. */
    ownerStatus: z.enum(['taken']).nullable().optional(),
  })
  .strict()

/**
 * Owner note, moving a "needs a person" idea to rejected or back, and taking one such idea into
 * the owner's work. Nothing else: farm statuses stay with the server.
 */
export async function updateIdea(id: string, value: unknown) {
  const input = ideaUpdateSchema.parse(value)
  if (!z.uuid().safeParse(id).success) throw new Error('IDEA_NOT_FOUND')
  await transaction(async (db) => {
    const [idea] = await query('SELECT * FROM ideas WHERE id=$1 FOR UPDATE', [id], db)
    if (!idea) throw new Error('IDEA_NOT_FOUND')
    if (input.status && input.status !== idea.status) {
      const allowed =
        (input.status === 'rejected' && idea.status === 'needs_human') ||
        (input.status === 'needs_human' &&
          idea.status === 'rejected' &&
          idea.critique?.verdict === 'PASS' &&
          !idea.farm_executable)
      if (!allowed) throw new Error('IDEA_STATUS_CHANGE_FORBIDDEN')
      await query('UPDATE ideas SET status=$2 WHERE id=$1', [id, input.status], db)
      // A rejected idea is no longer in the owner's work.
      if (input.status === 'rejected' && idea.owner_status)
        await query('UPDATE ideas SET owner_status=NULL,owner_taken_at=NULL WHERE id=$1', [id], db)
    }
    if (input.ownerStatus !== undefined && input.ownerStatus !== idea.owner_status) {
      if (input.ownerStatus === 'taken') {
        if (idea.farm_executable || (input.status ?? idea.status) !== 'needs_human')
          throw new Error('IDEA_TAKE_FORBIDDEN')
        // Variant 2 of the brief: one hypothesis under the owner's control at a time.
        const [other] = await query(
          "SELECT id FROM ideas WHERE owner_status='taken' AND id<>$1 LIMIT 1",
          [id],
          db,
        )
        if (other) throw new Error('IDEA_ALREADY_TAKEN')
        await query(
          "UPDATE ideas SET owner_status='taken',owner_taken_at=now() WHERE id=$1",
          [id],
          db,
        )
      } else
        await query('UPDATE ideas SET owner_status=NULL,owner_taken_at=NULL WHERE id=$1', [id], db)
      await audit(
        input.ownerStatus === 'taken' ? 'idea_taken' : 'idea_released',
        input.ownerStatus === 'taken'
          ? 'Владелец взял идею в работу.'
          : 'Владелец вернул идею в рейтинг.',
        { ideaId: id, title: idea.title },
        db,
      )
    }
    if (input.ownerNote !== undefined)
      await query('UPDATE ideas SET owner_note=$2 WHERE id=$1', [id, input.ownerNote], db)
    await audit(
      'idea_updated',
      'Владелец обновил идею.',
      { ideaId: id, from: idea.status, to: input.status ?? idea.status },
      db,
    )
  })
  return officeIdea(id)
}

function roundView(row: Record<string, any>, label: (id: string) => string): EvolutionRound {
  const children = Array.isArray(row.children) ? row.children : []
  return {
    id: row.id,
    generation: row.generation,
    decision: row.decision,
    reason: row.reason,
    trigger: row.trigger,
    isDemo: row.is_demo,
    at: iso(row.created_at)!,
    scores: (Array.isArray(row.scores) ? row.scores : []).map((s: any) => ({
      agentId: s.strategyId,
      name: agentName(label(s.strategyId)),
      score: s.score,
      samples: typeof s.samples === 'number' ? s.samples : undefined,
    })),
    archived: row.archived ?? [],
    children: children.map((c: any) => ({ id: c.id, parentId: c.parentId, mutation: c.mutation })),
  }
}

export async function officeAgents(): Promise<OfficeAgents> {
  const [[state], strategies, rounds, evolution, scored, [totals]] = await Promise.all([
    query('SELECT generation FROM system_state WHERE id=true'),
    query('SELECT * FROM strategies ORDER BY status,created_at,id'),
    query('SELECT * FROM evolution_rounds ORDER BY created_at DESC LIMIT 20'),
    evolutionStatus(),
    currentScores(),
    query(
      `SELECT count(*)::int AS ideas,
        count(*) FILTER (WHERE critique->>'verdict'='PASS')::int AS passed FROM ideas`,
    ),
  ])
  const labels = agentLabels(strategies as StrategyRow[])
  const label = (id: string) => labels.get(id) ?? '?'
  const retiredRounds = await query(
    `SELECT id,generation,scores FROM evolution_rounds WHERE id=ANY($1::uuid[])`,
    [strategies.map((s) => s.retired_round_id).filter(Boolean)],
  )
  const byGeneration = new Map<number, string[]>()
  for (const s of strategies) {
    const generation =
      s.status === 'active'
        ? state!.generation
        : (retiredRounds.find((r) => r.id === s.retired_round_id)?.generation ?? s.generation)
    byGeneration.set(generation, [...(byGeneration.get(generation) ?? []), s.id])
  }
  const metrics = (
    await Promise.all(
      [...byGeneration.entries()].map(([generation, ids]) => agentMetrics(generation, ids)),
    )
  ).flat()
  const agents: OfficeAgent[] = strategies.map((s) => {
    const m = metrics.find((x) => x.strategyId === s.id)
    const params = parseParams(s.params) ?? defaultParams(founderIndex(label(s.id)))
    const live: ScoredAgent | undefined =
      s.status === 'active' ? scored.find((x) => x.strategyId === s.id) : undefined
    const stored = retiredRounds
      .find((r) => r.id === s.retired_round_id)
      ?.scores?.find((x: any) => x.strategyId === s.id)
    return {
      id: s.id,
      name: agentName(label(s.id)),
      label: label(s.id),
      status: s.status,
      generation: s.generation,
      parentId: s.parent_id,
      params,
      focusLabels: params.focusCategories.map((id) => categoryById[id]?.label ?? id),
      mutation: s.mutation ?? null,
      metrics: {
        ideas: m?.ideas ?? 0,
        passed: m?.passed ?? 0,
        duplicates: m?.duplicates ?? 0,
        builtPassed: m?.builtPassed ?? 0,
        delivered: m?.delivered ?? 0,
        review: m?.review ?? 0,
        costKopecks: m?.costKopecks ?? 0,
      },
      score: live
        ? {
            total: live.total,
            components: live.components,
            lowData: (m?.ideas ?? 0) < evolution.minIdeas,
          }
        : stored
          ? { total: stored.score, components: stored.components }
          : null,
      retired:
        s.status === 'archived' && s.archived_at
          ? {
              at: iso(s.archived_at)!,
              reason: s.retired_reason ?? 'Архивирован симуляцией или до внутреннего отбора.',
              roundId: s.retired_round_id ?? '',
            }
          : null,
    }
  })
  return {
    generation: state!.generation,
    agents,
    totals: { ideas: totals!.ideas, passed: totals!.passed },
    evolution,
    rounds: rounds.map((row) => roundView(row, label)),
  }
}

export const pageSchema = z
  .object({ offset: z.coerce.number().int().min(0).max(100000000).default(0) })
  .strict()

export async function officeProducts(filter: unknown = {}): Promise<OfficeProductList> {
  const input = pageSchema.parse(filter)
  const limit = 50
  const [rows, [count]] = await Promise.all([
    query(
      `SELECT p.*,
        (SELECT count(*)::int FROM orders o WHERE o.product_id=p.id) AS orders,
        (SELECT count(*)::int FROM orders o WHERE o.product_id=p.id AND o.status='delivered') AS delivered,
        (SELECT count(*)::int FROM opportunities l WHERE l.product_id=p.id) AS leads,
        (SELECT i.title FROM ideas i WHERE i.id=p.idea_id) AS idea_title
       FROM products p ORDER BY p.status,(p.visibility='public') DESC,p.published_at DESC NULLS LAST,p.created_at,p.id
       LIMIT $1 OFFSET $2`,
      [limit, input.offset],
    ),
    query('SELECT count(*)::int AS n FROM products'),
  ])
  const provider = config().MODEL_PROVIDER
  const items = rows.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: serviceName(p.template, p.spec?.name ?? p.template),
    template: p.template,
    version: p.version,
    visibility: p.visibility,
    publishedAt: iso(p.published_at),
    priceKopecks: p.price_kopecks,
    ideaId: p.idea_id,
    ideaTitle: p.idea_title ?? null,
    isDemo: p.is_demo,
    needsRefresh:
      p.template === 'social' &&
      usesSourcePosts(provider) &&
      p.spec?.promise !== sourceSocialDelivery,
    publicUrl: publicUrl(p.slug),
    stats: { orders: p.orders, delivered: p.delivered, leads: p.leads },
    status: p.status,
  }))
  return {
    items,
    total: count!.n,
    offset: input.offset,
    limit,
    hasMore: input.offset + rows.length < count!.n,
  }
}

async function productById(id: string): Promise<OfficeProduct> {
  for (let offset = 0; ; offset += 50) {
    const page = await officeProducts({ offset })
    const found = page.items.find((p) => p.id === id)
    if (found) return found
    if (!page.hasMore) throw new Error('PRODUCT_NOT_FOUND')
  }
}

export const visibilitySchema = z.object({ visibility: z.enum(['private', 'public']) }).strict()

/** Owner shows or hides a product on the storefront. Archived products cannot go public. */
export async function setProductVisibility(id: string, value: unknown) {
  const input = visibilitySchema.parse(value)
  if (!z.uuid().safeParse(id).success) throw new Error('PRODUCT_NOT_FOUND')
  await transaction(async (db) => {
    const [product] = await query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [id], db)
    if (!product) throw new Error('PRODUCT_NOT_FOUND')
    if (input.visibility === 'public' && product.status !== 'sandbox')
      throw new Error('PRODUCT_ARCHIVED')
    // Demo output never goes on a storefront that runs a real model.
    if (input.visibility === 'public' && product.is_demo && config().MODEL_PROVIDER !== 'demo')
      throw new Error('PRODUCT_DEMO_ONLY')
    if (product.visibility === input.visibility) return
    await query(
      `UPDATE products SET visibility=$2,
       published_at=CASE WHEN $2='public' THEN COALESCE(published_at,now()) ELSE published_at END
       WHERE id=$1`,
      [id, input.visibility],
      db,
    )
    await audit(
      'product_visibility',
      input.visibility === 'public'
        ? 'Владелец показал продукт на сайте.'
        : 'Владелец скрыл продукт.',
      {
        productId: id,
        name: product.spec?.name,
        template: product.template,
        visibility: input.visibility,
      },
      db,
    )
  })
  return productById(id)
}

export const orderListSchema = z
  .object({
    offset: z.coerce.number().int().min(0).max(100000000).default(0),
    attention: z.enum(['true', 'false']).optional(),
  })
  .strict()

export async function officeOrders(filter: unknown = {}): Promise<OfficeOrderList> {
  const input = orderListSchema.parse(filter)
  const limit = 30
  const where = input.attention === 'true' ? "WHERE o.status='manual_review'" : ''
  const [rows, [count], label] = await Promise.all([
    query(
      `SELECT o.id,o.number,o.status,o.source,o.payment_mode,o.is_test_payment,o.revenue_kopecks,o.created_at,
        COALESCE(NULLIF(o.price_kopecks,0),p.price_kopecks) AS price,o.product_snapshot,p.slug,p.template,o.strategy_id
       FROM orders o JOIN products p ON p.id=o.product_id ${where}
       ORDER BY (o.status='manual_review') DESC,o.created_at DESC,o.id LIMIT $1 OFFSET $2`,
      [limit, input.offset],
    ),
    query(`SELECT count(*)::int AS n FROM orders o ${where}`),
    labelsNow(),
  ])
  return {
    items: rows.map((o) => ({
      id: o.id,
      number: Number(o.number),
      status: o.status,
      source: o.source,
      paymentMode: o.payment_mode,
      isTestPayment: o.is_test_payment,
      priceKopecks: o.price,
      revenueKopecks: o.revenue_kopecks,
      product: {
        name: serviceName(o.template, o.product_snapshot?.name),
        slug: o.slug,
        version: o.product_snapshot?.version,
      },
      createdAt: iso(o.created_at)!,
      attention: o.status === 'manual_review',
      agentName: agentName(label(o.strategy_id)),
    })),
    total: count!.n,
    offset: input.offset,
    limit,
    hasMore: input.offset + rows.length < count!.n,
  }
}

export async function officeMoney(): Promise<OfficeMoney> {
  const c = config()
  const [budget, categories, [payments]] = await Promise.all([
    budgetSummary(),
    query(
      `SELECT r.category,COALESCE(sum(t.charged_kopecks),0)::int AS spent
       FROM tool_calls t JOIN budget_reservations r ON r.id=t.reservation_id
       WHERE t.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       GROUP BY r.category`,
    ),
    query(
      `SELECT count(*)::int AS n,COALESCE(sum(COALESCE(NULLIF(o.price_kopecks,0),p.price_kopecks)),0)::int AS kopecks,
        (SELECT COALESCE(sum(revenue_kopecks),0)::int FROM orders) AS revenue
       FROM orders o JOIN products p ON p.id=o.product_id WHERE o.paid_at IS NOT NULL AND o.is_test_payment`,
    ),
  ])
  const byCategory: Record<BudgetCategory, number> = {
    research: 0,
    order: 0,
    scout: 0,
    lead: 0,
    report: 0,
  }
  for (const row of categories)
    if (Object.hasOwn(byCategory, row.category))
      byCategory[row.category as BudgetCategory] = row.spent
  return {
    daySpentKopecks: budget.daySpent,
    monthSpentKopecks: budget.monthSpent,
    outstandingKopecks: budget.outstanding,
    limits: { dailyKopecks: c.DAILY_BUDGET_KOPECKS, monthlyKopecks: c.MONTHLY_BUDGET_KOPECKS },
    byCategory,
    testPayments: { count: payments!.n, kopecks: payments!.kopecks },
    realRevenueKopecks: payments!.revenue,
    openai:
      c.MODEL_PROVIDER === 'openai'
        ? {
            spentMicrousd: budget.openaiSpentMicrousd,
            limitMicrousd: c.OPENAI_TOTAL_BUDGET_MICROUSD,
          }
        : null,
  }
}

export async function officeReports(filter: unknown = {}): Promise<OfficeReportList> {
  const input = pageSchema.parse(filter)
  const limit = 20
  const [rows, [count]] = await Promise.all([
    query('SELECT * FROM manager_reports ORDER BY created_at DESC,id LIMIT $1 OFFSET $2', [
      limit,
      input.offset,
    ]),
    query('SELECT count(*)::int AS n FROM manager_reports'),
  ])
  const items: OfficeReport[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    periodStart: iso(r.period_start)!,
    periodEnd: iso(r.period_end)!,
    generation: r.generation,
    metrics: r.metrics,
    ranking: (Array.isArray(r.ranking) ? r.ranking : []).map((x: any) => ({
      ideaId: x.ideaId,
      title: x.title,
      rankScore: x.rankScore,
      status: x.status,
    })),
    narrative: r.narrative,
    isDemo: r.is_demo,
    createdAt: iso(r.created_at)!,
  }))
  return {
    items,
    total: count!.n,
    offset: input.offset,
    limit,
    hasMore: input.offset + rows.length < count!.n,
  }
}

const modelLabels: Record<string, string> = {
  demo: 'Демо (модель не подключена)',
  ollama: 'Локальная модель (Ollama)',
  openai: 'OpenAI, платная модель',
  openrouter: 'OpenRouter, бесплатная модель',
  yandex: 'YandexGPT',
}
const modelIds: Record<string, (c: ReturnType<typeof config>) => string> = {
  ollama: (c) => c.OLLAMA_MODEL,
  openai: (c) => c.OPENAI_MODEL,
  openrouter: (c) => c.OPENROUTER_MODEL,
  yandex: (c) => c.YANDEX_MODEL,
}

const searchLabels: Record<string, string> = {
  demo: 'Демо (поиск не подключён)',
  searxng: 'SearXNG',
  yandex: 'Яндекс Поиск',
}

export async function officeSettings(): Promise<OfficeSettings> {
  const c = config()
  const [state] = await query('SELECT * FROM system_state WHERE id=true')
  return {
    mode: state!.mode,
    scheduleEnabled: c.AUTONOMY_ENABLED && state!.schedule_enabled,
    researchScope: state!.research_scope,
    evolutionEnabled: state!.evolution_enabled,
    evolutionMinIdeas: state!.evolution_min_ideas,
    evolutionRoundsPerDay: state!.evolution_rounds_per_day,
    scoutsPerStrategyPerDay: state!.scouts_per_strategy_per_day,
    leadsPerDay: state!.leads_per_day,
    scheduleHourUtc: state!.schedule_hour_utc ?? 0,
    providers: {
      model: modelLabels[c.MODEL_PROVIDER] ?? 'Модель',
      search: searchLabels[c.SEARCH_PROVIDER] ?? c.SEARCH_PROVIDER,
      payment:
        c.PAYMENT_MODE === 'sepolia'
          ? c.SEPOLIA_LOCAL_NODE
            ? 'Тестовый ETH (локальная сеть)'
            : 'Тестовый ETH (Sepolia)'
          : 'Тестовая кнопка',
    },
    limits: { dailyKopecks: c.DAILY_BUDGET_KOPECKS, monthlyKopecks: c.MONTHLY_BUDGET_KOPECKS },
    researchEnabled: state!.research_enabled,
    modelId: modelIds[c.MODEL_PROVIDER]?.(c) ?? null,
  }
}

export const leadListSchema = z
  .object({
    stage: z.enum(['new', 'saved', 'contacted', 'won', 'dismissed']).optional(),
    offset: z.coerce.number().int().min(0).max(100000000).default(0),
  })
  .strict()

export async function officeLeads(filter: unknown = {}): Promise<OfficeLeadList> {
  const input = leadListSchema.parse(filter)
  const limit = 50
  const where = 'WHERE ($1::text IS NULL OR o.stage=$1)'
  const [rows, [count]] = await Promise.all([
    query(
      `SELECT o.*,p.id AS p_id,p.spec->>'name' AS p_name,p.slug AS p_slug FROM opportunities o
       LEFT JOIN products p ON p.id=o.product_id ${where}
       ORDER BY CASE o.stage WHEN 'new' THEN 0 WHEN 'saved' THEN 1 WHEN 'contacted' THEN 2 WHEN 'won' THEN 3 ELSE 4 END,
         (o.reply_draft IS NOT NULL) DESC,o.last_seen_at DESC,o.id LIMIT $2 OFFSET $3`,
      [input.stage ?? null, limit, input.offset],
    ),
    query(`SELECT count(*)::int AS n FROM opportunities o ${where}`, [input.stage ?? null]),
  ])
  const items: OfficeLead[] = rows.map((o) => ({
    id: o.id,
    product: o.p_id ? { id: o.p_id, name: o.p_name, slug: o.p_slug } : null,
    template: o.template,
    url: o.url,
    title: o.title,
    snippet: o.snippet,
    stage: o.stage,
    note: o.note,
    replyDraft: o.reply_draft,
    replyDraftedAt: iso(o.reply_drafted_at),
    replyError: o.reply_error,
    isDemo: o.is_demo,
    firstSeenAt: iso(o.first_seen_at)!,
    lastSeenAt: iso(o.last_seen_at)!,
  }))
  return {
    items,
    total: count!.n,
    offset: input.offset,
    limit,
    hasMore: input.offset + rows.length < count!.n,
  }
}

/**
 * Owner button "Поискать ещё": lead searches for public products, the ones searched longest ago
 * first. Manual and scheduled searches share the daily `leads_per_day` limit (one UTC day);
 * queued searches are reused instead of adding more.
 */
export async function requestLeadSearch(now = new Date()) {
  return transaction(async (db) => {
    const [state] = await query(
      'SELECT mode,leads_per_day FROM system_state WHERE id=true FOR UPDATE',
      [],
      db,
    )
    if (state?.mode !== 'running') throw new Error('RESEARCH_PAUSED')
    const day = now.toISOString().slice(0, 10)
    const queued = await query(
      "SELECT id,status FROM jobs WHERE kind='lead' AND dedupe_key LIKE $1 AND status IN ('queued','running')",
      [`lead:${day}:%`],
      db,
    )
    if (queued.length)
      return {
        jobs: queued.map((j) => ({ id: j.id as string, status: j.status as string })),
        reused: true,
      }
    const [used] = await query(
      'SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE $1',
      [`lead:${day}:%`],
      db,
    )
    const room = Math.max(0, (state.leads_per_day as number) - (used!.n as number))
    const products = await query(
      `SELECT p.id,
         (SELECT count(*)::int FROM jobs j WHERE j.dedupe_key LIKE 'lead:'||$1||':'||p.id::text||'%') AS today
       FROM products p WHERE p.status='sandbox' AND p.visibility='public'
       AND (NOT p.is_demo OR $2)
       ORDER BY (SELECT max(j.created_at) FROM jobs j WHERE j.kind='lead' AND j.payload->>'productId'=p.id::text) NULLS FIRST,
         p.published_at,p.id`,
      [day, config().MODEL_PROVIDER === 'demo'],
      db,
    )
    if (!products.length) throw new Error('PRODUCT_NOT_PUBLIC')
    if (!room) throw new Error('LEAD_SEARCH_LIMIT')
    const jobs: { id: string; status: string }[] = []
    for (const product of products.slice(0, room)) {
      const job = await enqueue(
        'lead',
        `lead:${day}:${product.id}:owner:${(product.today as number) + 1}`,
        { productId: product.id, manual: 'true' },
        db,
      )
      jobs.push({ id: job.id as string, status: job.status as string })
    }
    await audit(
      'lead_search_requested',
      'Владелец попросил поискать клиентов.',
      { products: jobs.length },
      db,
    )
    return { jobs, reused: false }
  })
}

/** Owner asks for a new reply draft: at most three per lead, one queued at a time. */
export async function requestLeadDraft(id: string) {
  if (!z.uuid().safeParse(id).success) throw new Error('OPPORTUNITY_NOT_FOUND')
  return transaction(async (db) => {
    const [lead] = await query(
      'SELECT id,product_id,template FROM opportunities WHERE id=$1 FOR UPDATE',
      [id],
      db,
    )
    if (!lead) throw new Error('OPPORTUNITY_NOT_FOUND')
    // A reply links to the product page, so the product must be on the storefront.
    const [product] = await query(
      `SELECT id FROM products WHERE status='sandbox' AND visibility='public'
       AND (id=$1 OR ($1::uuid IS NULL AND template=$2)) LIMIT 1`,
      [lead.product_id, lead.template],
      db,
    )
    if (!product) throw new Error('PRODUCT_NOT_PUBLIC')
    const jobs = await query(
      'SELECT id,status FROM jobs WHERE dedupe_key LIKE $1 ORDER BY created_at',
      [`lead-draft:${id}:%`],
      db,
    )
    const active = jobs.find((job) => job.status === 'queued' || job.status === 'running')
    if (active) return { id: active.id as string, status: active.status as string, reused: true }
    if (jobs.length >= 3) throw new Error('LEAD_DRAFT_LIMIT')
    const job = await enqueue(
      'lead',
      `lead-draft:${id}:${jobs.length + 1}`,
      { opportunityId: id, request: randomUUID() },
      db,
    )
    await audit(
      'lead_draft_requested',
      'Владелец попросил новый отклик.',
      { opportunityId: id },
      db,
    )
    return { id: job.id as string, status: job.status as string, reused: false }
  })
}

const steps: Record<string, number> = {
  scout: 4,
  report: 1,
  research: 7,
  lead: 3,
  fulfill: 2,
  evolve: 1,
  evaluate: 1,
}
const templateName = (template: unknown) => serviceName(template, 'текстовая услуга')
function firstTemplate(payload: Record<string, string>) {
  try {
    return (JSON.parse(payload.templates ?? '[]') as string[])[0]
  } catch {
    return undefined
  }
}

/** One job in office words: what it is about, without codes or internal names. */
async function jobTitle(job: { kind: string; payload: Record<string, string> }) {
  const p = job.payload ?? {}
  if (job.kind === 'scout') {
    const label = await labelsNow()
    return {
      title: 'Разведка',
      detail: `${agentName(label(p.strategyId ?? ''))} ищет идею: ${topicById[p.topicId ?? '']?.label ?? 'тема'}.`,
    }
  }
  if (job.kind === 'research') {
    const template = templateName(firstTemplate(p))
    return {
      title: 'Сборка продукта',
      detail: p.ideaId
        ? `Собираем продукт по идее: «${template}».`
        : `Проверяем тип услуги «${template}».`,
    }
  }
  if (job.kind === 'lead')
    return p.opportunityId
      ? { title: 'Новый отклик', detail: 'Готовим новый текст отклика.' }
      : { title: 'Поиск клиентов', detail: 'Ищем публичные запросы и готовим отклики.' }
  if (job.kind === 'report')
    return { title: 'Отчёт руководителя', detail: 'Руководитель пишет отчёт по цифрам.' }
  if (job.kind === 'fulfill') {
    const [order] = z.uuid().safeParse(p.orderId).success
      ? await query('SELECT number FROM orders WHERE id=$1', [p.orderId])
      : []
    const number = order ? ` №${order.number}` : ''
    return { title: 'Заказ', detail: `Пишем и проверяем текст заказа${number}.` }
  }
  if (job.kind === 'evolve')
    return { title: 'Отбор агентов', detail: 'Сравниваем разведчиков по качеству идей.' }
  return { title: 'Денежный отбор', detail: 'Проверяем продажи за неделю.' }
}

async function jobNow(job: { id: string; kind: string; payload: Record<string, string> }) {
  const [done] = await query(
    "SELECT count(*)::int AS n FROM tool_calls WHERE job_id=$1 AND status='done'",
    [job.id],
  )
  const total = Math.max(steps[job.kind] ?? 1, (done!.n as number) + 1)
  return { ...(await jobTitle(job)), step: Math.min(total, (done!.n as number) + 1), steps: total }
}

const errorTexts: [RegExp, string][] = [
  [/^LEASE_(EXPIRED|LOST)$/, 'Сервер перезапустился, задача вернулась в очередь.'],
  [/^WORKER_DRAINING$/, 'Сервер остановлен штатно, задача продолжится.'],
  [/DAILY_BUDGET_WAIT$/, 'Ждёт следующего дня: дневной лимит исчерпан.'],
  [/SLOT_EXPIRED$/, 'Пропущена: день уже прошёл.'],
  [/^SEARCH_INSUFFICIENT_SOURCES$/, 'Поиск вернул мало источников.'],
  [/^SEARCH_/, 'Поиск не ответил.'],
  [/^MODEL_SCHEMA_INVALID$/, 'Модель ответила не по формату.'],
  [/^MODEL_OUTPUT_INCOMPLETE$/, 'Модель не дописала ответ.'],
  [/^MODEL_REFUSED$/, 'Модель отказалась отвечать.'],
  [/_HTTP_429$/, 'Модель перегружена, повторим позже.'],
  [/_HTTP_\d+$/, 'Модель недоступна.'],
  [/^UNCERTAIN_CALL_REQUIRES_REVIEW$/, 'Исход вызова модели неясен, нужна проверка.'],
  [/^RESEARCH_WINDOW_CLOSED$/, 'Сезон закрыт.'],
  [/^(STOPPED|PAUSED)$/, 'Ферма была на паузе или остановлена.'],
  [/BUDGET/, 'Не хватило бюджета.'],
  [/POLICY|UNTRUSTED/, 'Остановлено правилами безопасности.'],
  [/OUTPUT_REVIEW_REQUIRED|REVIEW/, 'Текст не прошёл проверку.'],
]
export function journalError(code: string | null) {
  if (!code) return null
  const text = errorTexts.find(([pattern]) => pattern.test(code))?.[1] ?? 'Задача остановлена.'
  return `${text} Код: ${code}.`
}

/** Technical log for the settings screen: recent events and jobs in plain words. */
export async function officeJournal(): Promise<OfficeJournal> {
  const [events, jobs] = await Promise.all([
    query<FeedEvent & { id: string }>(
      'SELECT id,kind,message,data,created_at FROM audit_events ORDER BY id DESC LIMIT 60',
    ),
    query(
      `SELECT id,kind,status,error_code,attempts,payload,created_at,started_at,finished_at
       FROM jobs ORDER BY (status='running') DESC,created_at DESC,id LIMIT 40`,
    ),
  ])
  const ctx = await feedContext(events)
  return {
    events: events.map((event) => ({
      id: String(event.id),
      at: iso(event.created_at)!,
      kind: event.kind,
      text: feedItems(event, ctx)[0]?.text ?? cleanText(event.message, 300),
    })),
    jobs: await Promise.all(
      jobs.map(async (job) => ({
        id: job.id,
        kind: job.kind,
        title: (await jobTitle(job as any)).detail,
        status: job.status,
        error: journalError(job.error_code),
        attempts: job.attempts,
        createdAt: iso(job.created_at)!,
        startedAt: iso(job.started_at),
        finishedAt: iso(job.finished_at),
      })),
    ),
  }
}
