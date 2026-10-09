import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { config } from './config'
import { audit, query, transaction, type Connection } from './db'
import { enqueue } from './queue'
import {
  agentLabels,
  agentName,
  ensureStrategyParams,
  parseParams,
  type StrategyRow,
} from './agents'
import { maybeScheduleEvolution } from './evolution'
import { POLICY } from './policy'
import { categoryById, isTaxonomyTopic, taxonomyTopics, topicById } from './taxonomy'
import type { budgetSummary } from './budget'
import { operationsStatus } from './operations'
import { enqueueResearchCampaign } from './research-campaign'
import { lockResearchWindow } from './research-window'

export async function setResearchScope(scope: 'rotate' | 'all') {
  if (!['rotate', 'all'].includes(scope)) throw new Error('RESEARCH_SCOPE_INVALID')
  return transaction(async (db) => {
    await query('UPDATE system_state SET research_scope=$1 WHERE id=true', [scope], db)
    await audit(
      'research_scope_changed',
      scope === 'all'
        ? 'Следующий суточный запуск обойдёт все направления последовательно в пределах бюджета.'
        : 'Следующий суточный запуск исследует очередное направление. Начатый обход сохранён.',
      { scope },
      db,
    )
    return { scope }
  })
}

/**
 * When the next daily run may start: right away, later today at the owner's hour, or tomorrow at
 * that hour once today's run exists. The hour is UTC; the office shows it in local time.
 */
export function nextDailyRun(now: Date, hourUtc: number, ranToday: boolean) {
  const at = (dayOffset: number) =>
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hourUtc),
    ).toISOString()
  if (ranToday) return at(1)
  return now.getUTCHours() < hourUtc ? at(0) : now.toISOString()
}

/** The daily run waits for the owner's hour; the day key and limits stay per UTC day. */
export const beforeDailyHour = (now: Date, hourUtc: number) => now.getUTCHours() < (hourUtc || 0)

export async function setSchedule(enabled: boolean) {
  if (enabled && !config().AUTONOMY_ENABLED) throw new Error('SCHEDULE_DISABLED_ON_SERVER')
  return transaction(async (db) => {
    await query('UPDATE system_state SET schedule_enabled=$1 WHERE id=true', [enabled], db)
    await audit(
      'schedule_changed',
      enabled
        ? 'Владелец включил суточное расписание.'
        : 'Владелец выключил суточное расписание. Начатая работа может завершиться.',
      { enabled },
      db,
    )
    return { enabled }
  })
}

type FarmState = Awaited<ReturnType<typeof lockResearchWindow>> & {
  scouts_per_strategy_per_day: number
  leads_per_day: number
  schedule_hour_utc: number
}

/**
 * One UTC day, shared by every worker. The manager (this server code) hands out scouting
 * topics, product lead searches, the daily report and selection checks in one transaction
 * under the research window lock, so several workers never duplicate work. Paused work
 * never accumulates.
 */
export async function scheduleWork(now = new Date()) {
  return transaction(async (db) => {
    const state = (await lockResearchWindow(db)) as FarmState
    await ensureStrategyParams(db)
    const weekNumber = Math.floor(now.getTime() / (7 * 86400000))
    const week = `evaluate:${weekNumber}`
    if (!(await query('SELECT id FROM jobs WHERE dedupe_key=$1', [week], db)).length)
      await enqueue('evaluate', week, {}, db)
    if (
      !config().AUTONOMY_ENABLED ||
      !state?.schedule_enabled ||
      state.mode !== 'running' ||
      !state.research_enabled ||
      beforeDailyHour(now, state.schedule_hour_utc)
    )
      return
    await scheduleResearch(db, state, now)
    await scheduleFarm(db, state, now, weekNumber)
  })
}

async function scheduleResearch(db: Connection, state: FarmState, now: Date) {
  {
    const key = `research:${now.toISOString().slice(0, 10)}`
    if (
      (
        await query(
          "SELECT id FROM jobs WHERE dedupe_key=$1 OR (kind='research' AND status IN ('queued','running')) LIMIT 1",
          [key],
          db,
        )
      ).length
    )
      return
    const job =
      state.research_scope === 'all'
        ? await enqueueResearchCampaign(db, key)
        : await enqueue('research', key, {}, db)
    if ('error' in job) return
    await audit(
      'research_scheduled',
      state.research_scope === 'all'
        ? 'Суточный обход всех направлений поставлен автоматически.'
        : 'Суточное исследование поставлено автоматически.',
      { jobId: job.id, slot: key, scope: state.research_scope },
      db,
    )
  }
}

const dayStartOf = (day: string) => new Date(`${day}T00:00:00.000Z`)

/** Scouting jobs queued today, scheduled and manual: each can bring one idea. */
async function scoutsToday(db: Connection) {
  const [row] = await query(
    `SELECT count(*)::int AS n FROM jobs WHERE kind='scout'
     AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [],
    db,
  )
  return row!.n as number
}

/** Topic rows exist for every taxonomy topic; scouting history is never deleted. */
async function ensureTopics(db: Connection) {
  await query(
    `INSERT INTO topic_scouting(topic_id,category)
     SELECT * FROM unnest($1::text[],$2::text[]) ON CONFLICT(topic_id) DO NOTHING`,
    [taxonomyTopics.map((t) => t.id), taxonomyTopics.map((t) => t.category)],
    db,
  )
}

type TopicRow = {
  topic_id: string
  category: string
  scout_count: number
  last_scouted_at: Date | null
}
/**
 * Pick a topic for an agent: its focus industries first, the least recently scouted topic
 * first, and a different topic and industry from other agents today when possible. The
 * choice is recorded at once, so four agents get four topics.
 */
export function chooseTopic(rows: TopicRow[], focus: string[], dayStart: Date): TopicRow {
  const known = rows.filter((row) => isTaxonomyTopic(row.topic_id))
  const today = known.filter(
    (row) => row.last_scouted_at && new Date(row.last_scouted_at) >= dayStart,
  )
  const takenTopics = new Set(today.map((row) => row.topic_id))
  const takenCategories = new Set(today.map((row) => row.category))
  const fresh = (row: TopicRow) => !takenTopics.has(row.topic_id)
  const newCategory = (row: TopicRow) => !takenCategories.has(row.category)
  const inFocus = (row: TopicRow) => focus.includes(row.category)
  const order = (a: TopicRow, b: TopicRow) =>
    (a.last_scouted_at ? new Date(a.last_scouted_at).getTime() : -1) -
      (b.last_scouted_at ? new Date(b.last_scouted_at).getTime() : -1) ||
    a.scout_count - b.scout_count ||
    a.topic_id.localeCompare(b.topic_id)
  const tiers = [
    known.filter((r) => inFocus(r) && fresh(r) && newCategory(r)),
    known.filter((r) => fresh(r) && newCategory(r)),
    known.filter((r) => inFocus(r) && fresh(r)),
    known.filter(fresh),
    known,
  ]
  const tier = tiers.find((rows) => rows.length)
  if (!tier) throw new Error('TAXONOMY_EMPTY')
  return [...tier].sort(order)[0]!
}

async function assignTopic(db: Connection, strategyId: string, focus: string[], day: string) {
  await ensureTopics(db)
  const rows = await query<TopicRow>(
    'SELECT topic_id,category,scout_count,last_scouted_at FROM topic_scouting WHERE enabled FOR UPDATE',
    [],
    db,
  )
  const topic = chooseTopic(rows, focus, dayStartOf(day))
  await query(
    `UPDATE topic_scouting SET scout_count=scout_count+1,last_scouted_at=now(),last_strategy_id=$2
     WHERE topic_id=$1`,
    [topic.topic_id, strategyId],
    db,
  )
  return topic
}

async function recordAssignments(
  db: Connection,
  assignments: { agentId: string; topicId: string; category: string }[],
  manual: boolean,
) {
  if (!assignments.length) return
  const rows = await query<StrategyRow>(
    'SELECT id,name,parent_id,generation,created_at FROM strategies',
    [],
    db,
  )
  const labels = agentLabels(rows)
  const parts = assignments.map(
    (a, i) =>
      `${i === 0 ? agentName(labels.get(a.agentId) ?? '?') : labels.get(a.agentId)} ищет ${categoryById[a.category]?.where ?? a.category}`,
  )
  await audit(
    'scouts_assigned',
    `${manual ? 'Вы запустили поиск' : 'Руководитель раздал задания'}: ${parts.join(', ')}.`,
    { assignments, manual },
    db,
  )
}

async function scheduleFarm(db: Connection, state: FarmState, now: Date, weekNumber: number) {
  const day = now.toISOString().slice(0, 10)
  // Scouting: one topic per active agent and slot, recorded at once.
  const active = await query(
    "SELECT id,params FROM strategies WHERE status='active' ORDER BY created_at,id",
    [],
    db,
  )
  const assignments: { agentId: string; topicId: string; category: string }[] = []
  let scoutRoom = POLICY.maxIdeasPerDay - (await scoutsToday(db))
  for (let n = 1; n <= state.scouts_per_strategy_per_day; n++)
    for (const strategy of active) {
      const key = `scout:${day}:${strategy.id}:${n}`
      if ((await query('SELECT id FROM jobs WHERE dedupe_key=$1', [key], db)).length) continue
      if (scoutRoom <= 0) continue
      scoutRoom--
      const focus = parseParams(strategy.params)?.focusCategories ?? []
      const topic = await assignTopic(db, strategy.id, focus, day)
      await enqueue(
        'scout',
        key,
        {
          strategyId: strategy.id,
          topicId: topic.topic_id,
          generation: String(state.generation),
          scheduled: 'true',
        },
        db,
      )
      assignments.push({ agentId: strategy.id, topicId: topic.topic_id, category: topic.category })
    }
  await recordAssignments(db, assignments, false)

  // Leads: public products that waited longest, within the daily limit.
  const [leadCount] = await query(
    'SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE $1',
    [`lead:${day}:%`],
    db,
  )
  const room = Math.max(0, state.leads_per_day - (leadCount!.n as number))
  if (room) {
    const products = await query(
      `SELECT p.id FROM products p WHERE p.status='sandbox' AND p.visibility='public'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key='lead:'||$1||':'||p.id::text)
       ORDER BY (SELECT max(j.created_at) FROM jobs j WHERE j.kind='lead' AND j.payload->>'productId'=p.id::text) NULLS FIRST,
         p.published_at,p.id LIMIT $2`,
      [day, room],
      db,
    )
    for (const product of products)
      await enqueue(
        'lead',
        `lead:${day}:${product.id}`,
        { productId: product.id, scheduled: 'true' },
        db,
      )
  }

  // Daily report once every scout of the day has finished.
  const scouts = await query(
    'SELECT status FROM jobs WHERE dedupe_key LIKE $1',
    [`scout:${day}:%`],
    db,
  )
  const dailyKey = `report:daily:${day}`
  if (
    scouts.length &&
    scouts.every((job) => job.status === 'done' || job.status === 'failed') &&
    !(await query('SELECT id FROM jobs WHERE dedupe_key=$1', [dailyKey], db)).length
  )
    await enqueue('report', dailyKey, { kind: 'daily', reportKey: dailyKey, scheduled: 'true' }, db)

  // Weekly report next to the weekly money check, once earlier days have ideas to compare.
  const weeklyKey = `report:weekly:${weekNumber}`
  if (
    !(await query('SELECT id FROM jobs WHERE dedupe_key=$1', [weeklyKey], db)).length &&
    (
      await query(
        "SELECT id FROM ideas WHERE created_at > now() - interval '7 days' AND created_at < $1 LIMIT 1",
        [dayStartOf(day)],
        db,
      )
    ).length
  )
    await enqueue(
      'report',
      weeklyKey,
      { kind: 'weekly', reportKey: weeklyKey, scheduled: 'true' },
      db,
    )

  await maybeScheduleEvolution(db, day)
}

/**
 * Owner button "Найти идеи сейчас": one scout per active agent on different topics, or one
 * scout on the chosen topic. Parallel clicks reuse queued manual scouts.
 */
export async function requestScout(topicId?: string) {
  if (topicId !== undefined && !isTaxonomyTopic(topicId)) throw new Error('TOPIC_NOT_FOUND')
  return transaction(async (db) => {
    const state = (await lockResearchWindow(db)) as FarmState
    if (!state.research_enabled) throw new Error('RESEARCH_WINDOW_CLOSED')
    if (state.mode !== 'running') throw new Error('RESEARCH_PAUSED')
    await ensureStrategyParams(db)
    const queued = await query(
      "SELECT id,status FROM jobs WHERE kind='scout' AND dedupe_key LIKE 'scout-manual:%' AND status IN ('queued','running') ORDER BY created_at,id",
      [],
      db,
    )
    if (queued.length)
      return {
        jobs: queued.map((job) => ({ id: job.id as string, status: job.status as string })),
        reused: true,
      }
    const active = await query(
      `SELECT s.id,s.params,(SELECT count(*) FROM ideas i WHERE i.strategy_id=s.id AND i.generation=$1)::int AS ideas
       FROM strategies s WHERE s.status='active' ORDER BY s.created_at,s.id`,
      [state.generation],
      db,
    )
    if (!active.length) throw new Error('INVALID_POPULATION')
    const day = new Date().toISOString().slice(0, 10)
    const room = POLICY.maxIdeasPerDay - (await scoutsToday(db))
    if (room <= 0) throw new Error('IDEAS_DAILY_LIMIT')
    const chosen = (topicId ? [[...active].sort((a, b) => a.ideas - b.ideas)[0]!] : active).slice(
      0,
      room,
    )
    const jobs = []
    const assignments: { agentId: string; topicId: string; category: string }[] = []
    for (const strategy of chosen) {
      const topic = topicId
        ? { topic_id: topicId, category: topicById[topicId]!.category }
        : await assignTopic(
            db,
            strategy.id,
            parseParams(strategy.params)?.focusCategories ?? [],
            day,
          )
      if (topicId)
        await query(
          `UPDATE topic_scouting SET scout_count=scout_count+1,last_scouted_at=now(),last_strategy_id=$2 WHERE topic_id=$1`,
          [topicId, strategy.id],
          db,
        )
      const job = await enqueue(
        'scout',
        `scout-manual:${randomUUID()}`,
        { strategyId: strategy.id, topicId: topic.topic_id, generation: String(state.generation) },
        db,
      )
      jobs.push({ id: job.id as string, status: job.status as string })
      assignments.push({ agentId: strategy.id, topicId: topic.topic_id, category: topic.category })
    }
    await recordAssignments(db, assignments, true)
    return { jobs, reused: false }
  })
}

export const farmSettingsSchema = z
  .object({
    evolutionEnabled: z.boolean().optional(),
    evolutionMinIdeas: z.number().int().min(1).max(100).optional(),
    evolutionRoundsPerDay: z.number().int().min(0).max(24).optional(),
    scoutsPerStrategyPerDay: z.number().int().min(0).max(6).optional(),
    leadsPerDay: z.number().int().min(0).max(12).optional(),
    scheduleHourUtc: z.number().int().min(0).max(20).optional(),
  })
  .strict()

/** Owner settings of the farm cycle. Money limits stay in the server environment. */
export async function updateFarmSettings(value: unknown) {
  const input = farmSettingsSchema.parse(value)
  const columns: [keyof typeof input, string][] = [
    ['evolutionEnabled', 'evolution_enabled'],
    ['evolutionMinIdeas', 'evolution_min_ideas'],
    ['evolutionRoundsPerDay', 'evolution_rounds_per_day'],
    ['scoutsPerStrategyPerDay', 'scouts_per_strategy_per_day'],
    ['leadsPerDay', 'leads_per_day'],
    ['scheduleHourUtc', 'schedule_hour_utc'],
  ]
  const changes = columns.filter(([key]) => input[key] !== undefined)
  if (!changes.length) return input
  return transaction(async (db) => {
    await query(
      `UPDATE system_state SET ${changes.map(([, column], i) => `${column}=$${i + 1}`).join(',')} WHERE id=true`,
      changes.map(([key]) => input[key]),
      db,
    )
    await audit('settings_changed', 'Владелец изменил настройки фермы.', { ...input }, db)
    return input
  })
}

type Run = {
  id: string
  status: string
  error_code: string | null
  created_at: Date
  finished_at: Date | null
  run_after: Date
}
export type AutonomyState = {
  mode: string
  research_enabled: boolean
  schedule_enabled: boolean
  schedule_hour_utc?: number
  research_scope: 'rotate' | 'all'
  worker_heartbeat: Date | null
  provider_readiness: { model: boolean; search: boolean; checkedAt: string } | null
}

export async function autonomyStatus(
  state: AutonomyState,
  budget: Awaited<ReturnType<typeof budgetSummary>>,
  now = new Date(),
) {
  const [scheduled, active, today, obligations, operations] = await Promise.all([
    query<Run>(
      "SELECT id,status,error_code,created_at,finished_at,run_after FROM jobs WHERE kind='research' AND dedupe_key ~ '^research:[0-9]{4}-[0-9]{2}-[0-9]{2}$' ORDER BY created_at DESC LIMIT 1",
    ),
    query<Run>(
      "SELECT id,status,error_code,created_at,finished_at,run_after FROM jobs WHERE kind='research' AND status IN ('queued','running') ORDER BY (status='running') DESC,created_at,payload->>'campaignPosition',id LIMIT 1",
    ),
    query('SELECT id FROM jobs WHERE dedupe_key=$1', [
      `research:${now.toISOString().slice(0, 10)}`,
    ]),
    query(
      "SELECT count(*) FILTER(WHERE status IN ('paid','running'))::int AS pending,count(*) FILTER(WHERE status='manual_review')::int AS review FROM orders",
    ),
    operationsStatus(now),
  ])
  const c = config()
  const alive =
    !!state.worker_heartbeat && now.getTime() - new Date(state.worker_heartbeat).getTime() < 90000
  const readiness = state.provider_readiness
  const fresh =
    alive && !!readiness && now.getTime() - new Date(readiness.checkedAt).getTime() < 90000
  const enabled = c.AUTONOMY_ENABLED && state.schedule_enabled
  const researchReserve =
    ['openai', 'yandex'].includes(c.MODEL_PROVIDER) || c.SEARCH_PROVIDER === 'yandex'
      ? c.RESEARCH_RESERVE_KOPECKS
      : 0
  const openrouterCostBlocked =
    c.MODEL_PROVIDER === 'openrouter' && budget.openrouterActualMicrousd > 0
  const budgetBlocked =
    budget.daySpent + budget.outstanding + researchReserve > c.DAILY_BUDGET_KOPECKS ||
    budget.monthSpent +
      budget.outstanding +
      researchReserve +
      Math.min(100000, Math.floor(c.MONTHLY_BUDGET_KOPECKS / 3)) >
      c.MONTHLY_BUDGET_KOPECKS ||
    (c.MODEL_PROVIDER === 'openai' &&
      budget.openaiSpentMicrousd >= c.OPENAI_TOTAL_BUDGET_MICROUSD) ||
    openrouterCostBlocked
  let reason: string
  let nextAt: string | null = null
  if (!enabled)
    reason =
      state.mode === 'running' && state.research_enabled
        ? 'Автозапуск исследований выключен. Ручные исследования доступны в пределах бюджета.'
        : 'Автозапуск исследований выключен. Для ручного запуска нужны режим «В работе» и открытое окно исследований.'
  else if (state.mode !== 'running')
    reason =
      state.mode === 'paused'
        ? 'Исследования на паузе. Принятые заказы продолжают выполняться.'
        : 'Аварийный стоп: новые вызовы модели запрещены.'
  else if (!state.research_enabled)
    reason = '28-дневное окно закрыто. Требуется пересмотр гипотезы и новое окно.'
  else if (!alive)
    reason = 'Нет свежего сигнала от обработчика. Автоматический запуск не подтверждён.'
  else if (!fresh) reason = 'Обработчик ещё не сообщил о готовности служб.'
  else if (!readiness!.model || !readiness!.search)
    reason =
      [
        !readiness!.model && `Локальная модель «${c.OLLAMA_MODEL}» недоступна или ещё не скачана.`,
        !readiness!.search && 'Поиск недоступен.',
      ]
        .filter(Boolean)
        .join(' ') + ' Попытки заданий не расходуются.'
  else if (openrouterCostBlocked)
    reason =
      'OpenRouter сообщил плату за бесплатный запрос. Новые вызовы остановлены; проверьте расходы в кабинете OpenRouter.'
  else if (active.length) {
    const waiting = active[0]!.error_code === 'RESEARCH_DAILY_BUDGET_WAIT'
    if (waiting) nextAt = new Date(active[0]!.run_after).toISOString()
    reason = waiting
      ? 'Обход ждёт следующего суточного бюджета. Принятые заказы сохраняют приоритет.'
      : 'Исследование уже в очереди или выполняется. Дополнительный автоматический запуск ждёт его завершения.'
  } else if (budgetBlocked)
    reason =
      'Доступного бюджета недостаточно для нового исследования. Резервы и прежние расходы сохранены.'
  else {
    nextAt = nextDailyRun(now, state.schedule_hour_utc ?? 0, today.length > 0)
    reason = today.length
      ? 'Сегодня автоматическое исследование уже запускалось. Ожидаем следующего дня.'
      : beforeDailyHour(now, state.schedule_hour_utc ?? 0)
        ? 'Исследование начнётся в назначенный час запуска.'
        : 'Исследование будет поставлено в ближайшем цикле обработчика.'
  }
  return {
    operations,
    researchScope: state.research_scope,
    enabled,
    allowed: c.AUTONOMY_ENABLED,
    reason,
    nextAt,
    workerAlive: alive,
    lastScheduledRun: scheduled[0] || null,
    activeRun: active[0] || null,
    pendingOrders: obligations[0]!.pending,
    reviewOrders: obligations[0]!.review,
    ordersReason:
      state.mode === 'emergency_stop'
        ? 'Исполнение остановлено; подтверждения платежей сохраняются.'
        : !alive
          ? 'Нет свежего сигнала обработчика; очередь сохранена.'
          : !fresh || !readiness!.model
            ? 'Принятые заказы ждут готовности модели.'
            : 'Оплаченные заказы исполняются автоматически, в том числе при паузе исследований.',
  }
}
