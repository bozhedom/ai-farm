import { randomUUID } from 'node:crypto'
import { config } from './config'
import { audit, pool, query, transaction, type Connection } from './db'

export async function budgetSummary(db: Connection = pool) {
  const [s] = await query(
    `SELECT
    COALESCE((SELECT sum(charged_kopecks) FROM tool_calls WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::int AS day_spent,
    COALESCE((SELECT sum(charged_kopecks) FROM tool_calls WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::int AS month_spent,
    COALESCE((SELECT sum(limit_kopecks-spent_kopecks) FROM budget_reservations WHERE status='open'),0)::int AS outstanding`,
    [],
    db,
  )
  return {
    daySpent: s!.day_spent as number,
    monthSpent: s!.month_spent as number,
    outstanding: s!.outstanding as number,
  }
}

export async function reserveBudget(
  key: string,
  category: 'research' | 'order',
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
  const limit =
    c.MODEL_PROVIDER === 'demo'
      ? 0
      : category === 'order'
        ? c.ORDER_RESERVE_KOPECKS
        : c.RESEARCH_RESERVE_KOPECKS
  const s = await budgetSummary(db)
  const protectedOrders =
    category === 'research' ? Math.min(100000, Math.floor(c.MONTHLY_BUDGET_KOPECKS / 3)) : 0
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

/** A call is charged pessimistically before sending. Ambiguous failures retain that charge. */
export async function meteredCall<T>(args: {
  key: string
  reservationId: string
  role: string
  maximum: number
  demo: boolean
  invoke: () => Promise<{ value: T; cost: number }>
}): Promise<T> {
  const claim = await transaction(async (db) => {
    await query('SELECT pg_advisory_xact_lock(735093)', [], db)
    const [old] = await query('SELECT * FROM tool_calls WHERE call_key=$1', [args.key], db)
    if (old?.status === 'done') return { cached: true as const, value: old.output as T }
    if (old) throw new Error('UNCERTAIN_CALL_REQUIRES_REVIEW')
    const [state] = await query(
      'SELECT mode,research_enabled FROM system_state WHERE id=true',
      [],
      db,
    )
    if (state?.mode === 'emergency_stop') throw new Error('STOPPED')
    const [reservation] = await query(
      'SELECT * FROM budget_reservations WHERE id=$1 FOR UPDATE',
      [args.reservationId],
      db,
    )
    if (!reservation || reservation.status !== 'open') throw new Error('RESERVATION_CLOSED')
    if (state?.mode === 'paused' && reservation.category === 'research') throw new Error('PAUSED')
    if (!state?.research_enabled && reservation.category === 'research')
      throw new Error('RESEARCH_WINDOW_CLOSED')
    if (
      !Number.isSafeInteger(args.maximum) ||
      args.maximum < 0 ||
      reservation.spent_kopecks + args.maximum > reservation.limit_kopecks
    )
      throw new Error('BUDGET_BLOCKED')
    // Includes old outstanding reservations: crossing midnight cannot create a fresh hidden budget.
    const totals = await budgetSummary(db)
    if (
      totals.daySpent + args.maximum > config().DAILY_BUDGET_KOPECKS ||
      totals.monthSpent + args.maximum > config().MONTHLY_BUDGET_KOPECKS
    )
      throw new Error('BUDGET_BLOCKED')
    const id = randomUUID()
    await query(
      "INSERT INTO tool_calls(id,call_key,reservation_id,role,status,reserved_kopecks,charged_kopecks,is_demo) VALUES($1,$2,$3,$4,'pending',$5,$5,$6)",
      [id, args.key, args.reservationId, args.role, args.maximum, args.demo],
      db,
    )
    await query(
      'UPDATE budget_reservations SET spent_kopecks=spent_kopecks+$2 WHERE id=$1',
      [args.reservationId, args.maximum],
      db,
    )
    return { cached: false as const, id }
  })
  if (claim.cached) return claim.value
  try {
    const result = await args.invoke()
    if (!Number.isSafeInteger(result.cost) || result.cost < 0 || result.cost > args.maximum)
      throw new Error('PROVIDER_COST_EXCEEDS_RESERVE')
    await transaction(async (db) => {
      await query('SELECT pg_advisory_xact_lock(735093)', [], db)
      await query(
        "UPDATE tool_calls SET status='done', output=$2, charged_kopecks=$3 WHERE id=$1",
        [claim.id, JSON.stringify(result.value), result.cost],
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
    await query("UPDATE tool_calls SET status='uncertain' WHERE id=$1", [claim.id])
    await audit(
      'tool_uncertain',
      'Исход API-вызова неясен. Верхняя оценка расхода сохранена; автоматическое повторное списание запрещено.',
      { role: args.role, callId: claim.id },
    )
    throw error
  }
}
