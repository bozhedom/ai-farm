import { randomUUID } from 'node:crypto'
import { config } from './config'
import { audit, pool, query, transaction, type Connection } from './db'
import { activityContext, checkWorkerDrain, type CallActivity } from './activity'
import { lockResearchWindow } from './research-window'
import { managerLimits } from './manager/limits'
import { usdToKopecks } from './providers/openai-cost'

export async function budgetSummary(db: Connection = pool) {
  const [s] = await query(
    `SELECT
    COALESCE((SELECT sum(charged_kopecks) FROM tool_calls WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::int AS day_spent,
    COALESCE((SELECT sum(charged_kopecks) FROM tool_calls WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::int AS month_spent,
    COALESCE((SELECT sum(limit_kopecks-spent_kopecks) FROM budget_reservations WHERE status='open'),0)::int AS outstanding,
    COALESCE((SELECT sum(charged_microusd) FROM tool_calls WHERE provider='openai'),0)::bigint AS openai_spent,
    COALESCE((SELECT sum(actual_microusd) FROM tool_calls WHERE provider='openai'),0)::bigint AS openai_actual,
    COALESCE((SELECT sum(charged_microusd) FROM tool_calls WHERE provider='openrouter'),0)::bigint AS openrouter_spent,
    COALESCE((SELECT sum(actual_microusd) FROM tool_calls WHERE provider='openrouter'),0)::bigint AS openrouter_actual`,
    [],
    db,
  )
  return {
    daySpent: s!.day_spent as number,
    monthSpent: s!.month_spent as number,
    outstanding: s!.outstanding as number,
    openaiSpentMicrousd: Number(s!.openai_spent),
    openaiActualMicrousd: Number(s!.openai_actual),
    openrouterSpentMicrousd: Number(s!.openrouter_spent),
    openrouterActualMicrousd: Number(s!.openrouter_actual),
  }
}

export type BudgetCategory =
  'research' | 'order' | 'scout' | 'lead' | 'report' | 'trading_manager' | 'computer_use'
/** Farm work stops with the research window and pauses; accepted orders do not. */
export const farmCategories: readonly BudgetCategory[] = ['research', 'scout', 'lead', 'report']

/** Envelope per task. Free providers reserve nothing, as before. */
export function reserveFor(category: BudgetCategory) {
  const c = config()
  if (category === 'trading_manager')
    return ['yandex', 'openai'].includes(c.MODEL_PROVIDER) ? managerLimits().reserveKopecks : 0
  // One browser task: its dollar cap converted once, so the ledger shows the same envelope.
  if (category === 'computer_use')
    return c.MODEL_PROVIDER === 'openai'
      ? usdToKopecks(c.COMPUTER_USE_TASK_CAP_MICROUSD, c.OPENAI_USD_KOPECKS)
      : 0
  const paid =
    ['yandex', 'openai'].includes(c.MODEL_PROVIDER) ||
    (category !== 'order' && c.SEARCH_PROVIDER === 'yandex')
  if (!paid) return 0
  return {
    order: c.ORDER_RESERVE_KOPECKS,
    research: c.RESEARCH_RESERVE_KOPECKS,
    scout: c.SCOUT_RESERVE_KOPECKS,
    lead: c.LEAD_RESERVE_KOPECKS,
    report: c.REPORT_RESERVE_KOPECKS,
  }[category]
}

export async function reserveBudget(
  key: string,
  category: BudgetCategory,
  db?: Connection,
): Promise<string> {
  if (!db) return transaction((tx) => reserveBudget(key, category, tx))
  await query('SELECT pg_advisory_xact_lock(735093)', [], db)
  const [existing] = await query('SELECT * FROM budget_reservations WHERE dedupe_key=$1', [key], db)
  if (existing) {
    if (existing.status !== 'open') throw new Error('RESERVATION_CLOSED')
    return existing.id
  }
  const c = config()
  const limit = reserveFor(category)
  const s = await budgetSummary(db)
  const protectedOrders =
    category !== 'order' ? Math.min(100000, Math.floor(c.MONTHLY_BUDGET_KOPECKS / 3)) : 0
  if (
    s.daySpent + s.outstanding + limit > c.DAILY_BUDGET_KOPECKS ||
    s.monthSpent + s.outstanding + limit + protectedOrders > c.MONTHLY_BUDGET_KOPECKS
  )
    throw new Error('BUDGET_BLOCKED')
  const id = randomUUID()
  await query(
    'INSERT INTO budget_reservations(id,dedupe_key,category,limit_kopecks) VALUES ($1,$2,$3,$4)',
    [id, key, category, limit],
    db,
  )
  return id
}

export async function closeReservation(id: string, db: Connection = pool) {
  await query("UPDATE budget_reservations SET status='closed' WHERE id=$1", [id], db)
}

/** Providers that never charge: the zero price is enforced per call (OpenRouter) or local. */
export const freeProviders: readonly string[] = ['openrouter', 'ollama']
/** Failures that need a person even at a zero price: billing, policy and refusals. */
const reviewOnly = /COST|POLICY|BYOK|FREE_MODEL|REFUSED|CONTENT|BUDGET/
/** A pending call without a heartbeat this long belongs to a worker that is gone (job lease). */
export const abandonedCallMs = 2 * 60 * 1000

/**
 * An interrupted call of a free provider may be sent again: nothing was or can be charged, so
 * repeating it only spends time. Paid providers keep UNCERTAIN_CALL_REQUIRES_REVIEW: a second
 * request could charge twice.
 */
export function freeRetryAllowed(
  old: Record<string, any>,
  provider: string | undefined,
  maximum: number,
  maximumUsd: number,
  now = Date.now(),
) {
  if (!provider || !freeProviders.includes(provider) || old.provider !== provider) return false
  if (maximum !== 0 || maximumUsd !== 0) return false
  if (
    Number(old.charged_kopecks ?? 0) !== 0 ||
    Number(old.charged_microusd ?? 0) !== 0 ||
    Number(old.actual_microusd ?? 0) !== 0
  )
    return false
  if (old.error_code && reviewOnly.test(old.error_code)) return false
  if (old.status === 'uncertain') return 'retry'
  if (old.status !== 'pending') return false
  return now - new Date(old.heartbeat_at ?? old.created_at).getTime() > abandonedCallMs
    ? 'retry'
    : 'wait'
}

/** A call is charged pessimistically before sending. Ambiguous failures retain that charge. */
export async function meteredCall<T>(args: {
  key: string
  reservationId: string
  role: string
  maximum: number
  maximumMicrousd?: number
  demo: boolean
  activity?: CallActivity
  invoke: () => Promise<{ value: T; cost: number; microusd?: number }>
}): Promise<T> {
  const maximumUsd = args.maximumMicrousd ?? 0
  if (
    !Number.isSafeInteger(maximumUsd) ||
    maximumUsd < 0 ||
    (args.activity?.provider === 'openai' && maximumUsd === 0)
  )
    throw new Error('INVALID_DOLLAR_RESERVE')
  if (args.activity?.provider === 'openrouter' && (maximumUsd !== 0 || args.maximum !== 0))
    throw new Error('OPENROUTER_FREE_MODEL_REQUIRED')
  const claim = await transaction(async (db) => {
    // Window transitions and all budget admissions use the same lock order.
    await query('SELECT id FROM system_state WHERE id=true FOR UPDATE', [], db)
    await query('SELECT pg_advisory_xact_lock(735093)', [], db)
    const [old] = await query('SELECT * FROM tool_calls WHERE call_key=$1', [args.key], db)
    if (old?.status === 'done') {
      if (
        old.is_demo !== args.demo ||
        (old.provider && args.activity?.provider && old.provider !== args.activity.provider) ||
        (old.model && args.activity?.model && old.model !== args.activity.model)
      )
        throw new Error('PROVIDER_CHANGED_DURING_JOB')
      return { cached: true as const, value: old.output as T }
    }
    if (old) {
      const retry = freeRetryAllowed(old, args.activity?.provider, args.maximum, maximumUsd)
      if (!retry) throw new Error('UNCERTAIN_CALL_REQUIRES_REVIEW')
      // A free call that may still be answering: the job comes back after a short pause.
      if (retry === 'wait') throw new Error('FREE_CALL_STILL_RUNNING')
      // The record of the interrupted call stays, under a retired key; the retry takes the key.
      await query(
        `UPDATE tool_calls SET call_key=call_key||':retired:'||id::text WHERE id=$1`,
        [old.id],
        db,
      )
      await audit(
        'tool_call_retried',
        'Вызов бесплатной модели прервался без ответа. Повторяем его: деньги не тратятся.',
        { role: args.role, callId: old.id, provider: old.provider, errorCode: old.error_code },
        db,
      )
    }
    checkWorkerDrain()
    const state = await lockResearchWindow(db)
    const [reservation] = await query(
      'SELECT * FROM budget_reservations WHERE id=$1 FOR UPDATE',
      [args.reservationId],
      db,
    )
    const farm = farmCategories.includes(reservation?.category)
    if (!state.research_enabled && farm) return { error: new Error('RESEARCH_WINDOW_CLOSED') }
    if (state.mode === 'emergency_stop') throw new Error('STOPPED')
    if (!reservation || reservation.status !== 'open') throw new Error('RESERVATION_CLOSED')
    if (
      state.mode === 'paused' &&
      (farm || ['trading_manager', 'computer_use'].includes(reservation.category))
    )
      throw new Error('PAUSED')
    if (reservation.category === 'computer_use') {
      const [owner] = await query('SELECT enabled FROM computer_use WHERE id=true', [], db)
      if (!owner?.enabled) throw new Error('COMPUTER_USE_PAUSED')
      const [spent] = await query(
        `SELECT coalesce(sum(t.charged_microusd),0)::bigint AS amount FROM tool_calls t
         JOIN budget_reservations r ON r.id=t.reservation_id WHERE r.category='computer_use'
         AND t.created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [],
        db,
      )
      if (Number(spent!.amount) + maximumUsd > config().COMPUTER_USE_DAILY_CAP_MICROUSD)
        throw new Error('COMPUTER_USE_DAILY_LIMIT')
    }
    if (reservation.category === 'trading_manager') {
      const [manager] = await query('SELECT enabled FROM trading_manager WHERE id=true', [], db)
      if (!manager?.enabled) throw new Error('MANAGER_PAUSED')
      const [spent] = await query(
        `SELECT coalesce(sum(t.charged_kopecks),0)::int AS amount FROM tool_calls t
         JOIN budget_reservations r ON r.id=t.reservation_id WHERE r.category='trading_manager'
         AND t.created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [],
        db,
      )
      if (spent!.amount + args.maximum > managerLimits().dailyKopecks)
        throw new Error('MANAGER_BUDGET_LIMIT')
    }
    if (
      !Number.isSafeInteger(args.maximum) ||
      args.maximum < 0 ||
      reservation.spent_kopecks + args.maximum > reservation.limit_kopecks
    )
      throw new Error('BUDGET_BLOCKED')
    // Includes old outstanding reservations: crossing midnight cannot create a fresh hidden budget.
    const totals = await budgetSummary(db)
    if (args.activity?.provider === 'openrouter' && totals.openrouterActualMicrousd > 0)
      throw new Error('OPENROUTER_COST_REVIEW_REQUIRED')
    if (
      maximumUsd > 0 &&
      totals.openaiSpentMicrousd + maximumUsd > config().OPENAI_TOTAL_BUDGET_MICROUSD
    )
      throw new Error('OPENAI_BUDGET_BLOCKED')
    if (
      totals.daySpent + args.maximum > config().DAILY_BUDGET_KOPECKS ||
      totals.monthSpent + args.maximum > config().MONTHLY_BUDGET_KOPECKS
    )
      throw new Error('BUDGET_BLOCKED')
    checkWorkerDrain()
    const id = randomUUID()
    await query(
      `INSERT INTO tool_calls(id,call_key,reservation_id,role,status,reserved_kopecks,charged_kopecks,is_demo,
        job_id,template,task_label,provider,model,heartbeat_at,reserved_microusd,charged_microusd)
       VALUES($1,$2,$3,$4,'pending',$5,$5,$6,$7,$8,$9,$10,$11,now(),$12,$12)`,
      [
        id,
        args.key,
        args.reservationId,
        args.role,
        args.maximum,
        args.demo,
        activityContext.getStore()?.jobId,
        args.activity?.template,
        args.activity?.taskLabel,
        args.activity?.provider,
        args.activity?.model,
        maximumUsd,
      ],
      db,
    )
    await query(
      'UPDATE budget_reservations SET spent_kopecks=spent_kopecks+$2 WHERE id=$1',
      [args.reservationId, args.maximum],
      db,
    )
    // Roll back an unsent call if shutdown arrived while the accounting claim was prepared.
    checkWorkerDrain()
    return { cached: false as const, id }
  })
  if ('error' in claim) throw claim.error
  if (claim.cached) return claim.value
  try {
    const result = await args.invoke()
    const costUsd = result.microusd ?? 0
    if (
      !Number.isSafeInteger(costUsd) ||
      costUsd < 0 ||
      costUsd > maximumUsd ||
      (['openai', 'openrouter'].includes(args.activity?.provider || '') &&
        result.microusd === undefined)
    )
      throw new Error('PROVIDER_COST_EXCEEDS_RESERVE')
    if (!Number.isSafeInteger(result.cost) || result.cost < 0 || result.cost > args.maximum)
      throw new Error('PROVIDER_COST_EXCEEDS_RESERVE')
    await transaction(async (db) => {
      await query('SELECT pg_advisory_xact_lock(735093)', [], db)
      await query(
        "UPDATE tool_calls SET status='done', output=$2, charged_kopecks=$3,charged_microusd=$4,finished_at=now(),heartbeat_at=now() WHERE id=$1",
        [claim.id, JSON.stringify(result.value), result.cost, costUsd],
        db,
      )
      await query(
        'UPDATE budget_reservations SET spent_kopecks=spent_kopecks-$2 WHERE id=$1',
        [args.reservationId, args.maximum - result.cost],
        db,
      )
    })
    return result.value
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
        ? error.message
        : 'PROVIDER_CALL_FAILED'
    await query(
      "UPDATE tool_calls SET status='uncertain',error_code=$2,finished_at=now() WHERE id=$1",
      [claim.id, code],
    )
    await audit(
      'tool_uncertain',
      'Исход API-вызова неясен. Верхняя оценка расхода сохранена; автоматическое повторное списание запрещено.',
      { role: args.role, callId: claim.id },
    )
    throw error
  }
}

/**
 * An order reservation that holds no budget yet: a public order before payment. It keeps the
 * order's accounting row in place, but blocks every model call until `fundOrderReservation`.
 */
export async function openUnfundedReservation(key: string, db: Connection) {
  const id = randomUUID()
  await query(
    "INSERT INTO budget_reservations(id,dedupe_key,category,limit_kopecks) VALUES ($1,$2,'order',0)",
    [id, key],
    db,
  )
  return id
}

/**
 * Funds an unfunded order reservation at payment time with the same limits as `reserveBudget`.
 * Throws BUDGET_BLOCKED without changing anything when the day or month has no room.
 */
export async function fundOrderReservation(id: string, db: Connection) {
  await query('SELECT pg_advisory_xact_lock(735093)', [], db)
  const [reservation] = await query(
    'SELECT * FROM budget_reservations WHERE id=$1 FOR UPDATE',
    [id],
    db,
  )
  if (!reservation || reservation.status !== 'open' || reservation.category !== 'order')
    throw new Error('RESERVATION_CLOSED')
  const c = config()
  const limit = ['yandex', 'openai'].includes(c.MODEL_PROVIDER) ? c.ORDER_RESERVE_KOPECKS : 0
  if (reservation.limit_kopecks >= limit) return
  const s = await budgetSummary(db)
  const extra = limit - reservation.limit_kopecks
  if (
    s.daySpent + s.outstanding + extra > c.DAILY_BUDGET_KOPECKS ||
    s.monthSpent + s.outstanding + extra > c.MONTHLY_BUDGET_KOPECKS
  )
    throw new Error('BUDGET_BLOCKED')
  await query('UPDATE budget_reservations SET limit_kopecks=$2 WHERE id=$1', [id, limit], db)
}

/** Whether an order reservation could be funded right now. Reserves nothing. */
export async function orderBudgetAvailable(db: Connection) {
  const c = config()
  const limit = ['yandex', 'openai'].includes(c.MODEL_PROVIDER) ? c.ORDER_RESERVE_KOPECKS : 0
  const s = await budgetSummary(db)
  return (
    s.daySpent + s.outstanding + limit <= c.DAILY_BUDGET_KOPECKS &&
    s.monthSpent + s.outstanding + limit <= c.MONTHLY_BUDGET_KOPECKS
  )
}
