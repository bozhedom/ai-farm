import { config } from './config'
import { audit, query, transaction } from './db'
import { enqueue } from './queue'
import type { budgetSummary } from './budget'
import { operationsStatus } from './operations'

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

/** One UTC slot, shared by every worker. Paused work never accumulates new research. */
export async function scheduleWork(now = new Date()) {
  return transaction(async (db) => {
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    const week = `evaluate:${Math.floor(now.getTime() / (7 * 86400000))}`
    if (!(await query('SELECT id FROM jobs WHERE dedupe_key=$1', [week], db)).length)
      await enqueue('evaluate', week, {}, db)
    if (
      !config().AUTONOMY_ENABLED ||
      !state?.schedule_enabled ||
      state.mode !== 'running' ||
      !state.research_enabled
    )
      return
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
    const job = await enqueue('research', key, {}, db)
    await audit(
      'research_scheduled',
      'Суточное исследование поставлено автоматически.',
      { jobId: job.id, slot: key },
      db,
    )
  })
}

type Run = {
  id: string
  status: string
  error_code: string | null
  created_at: Date
  finished_at: Date | null
}
export type AutonomyState = {
  mode: string
  research_enabled: boolean
  schedule_enabled: boolean
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
      "SELECT id,status,error_code,created_at,finished_at FROM jobs WHERE kind='research' AND dedupe_key ~ '^research:[0-9]{4}-[0-9]{2}-[0-9]{2}$' ORDER BY created_at DESC LIMIT 1",
    ),
    query<Run>(
      "SELECT id,status,error_code,created_at,finished_at FROM jobs WHERE kind='research' AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
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
  else if (active.length)
    reason =
      'Исследование уже в очереди или выполняется. Дополнительный автоматический запуск ждёт его завершения.'
  else if (budgetBlocked)
    reason =
      'Доступного бюджета недостаточно для нового исследования. Резервы и прежние расходы сохранены.'
  else {
    nextAt = today.length
      ? new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
        ).toISOString()
      : now.toISOString()
    reason = today.length
      ? 'Сегодня автоматическое исследование уже запускалось. Ожидаем следующего дня.'
      : 'Исследование будет поставлено в ближайшем цикле обработчика.'
  }
  return {
    operations,
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
