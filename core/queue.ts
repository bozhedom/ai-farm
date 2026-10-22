import { randomUUID } from 'node:crypto'
import { audit, pool, query, transaction, type Connection } from './db'
import { templateSchema, type Template } from './policy'
import { config } from './config'
import {
  budgetSummary,
  freeProviders,
  reserveBudget,
  reserveFor,
  type BudgetCategory,
} from './budget'
import { WorkerDraining } from './activity'
import { lockResearchWindow } from './research-window'
import {
  expectedCostWindowDays,
  expectedTaskCost,
  managerFloor,
  pacingDecision,
  pacingShares,
} from './pacing'
import { managerLimits } from './manager/limits'

export type JobKind = 'research' | 'fulfill' | 'evaluate' | 'scout' | 'lead' | 'report' | 'evolve'
/** Model-using farm work: one at a time across workers, stopped by pause and the closed window. */
export const farmModelKinds = ['research', 'scout', 'lead', 'report'] as const
export type Job = {
  id: string
  kind: JobKind
  payload: Record<string, string>
  attempts: number
  max_attempts: number
  lease_token: string
}
export async function enqueue(
  kind: Job['kind'],
  key: string,
  payload: Record<string, string> = {},
  db: Connection = pool,
) {
  const [row] = await query(
    'INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id,status',
    [randomUUID(), kind, key, payload],
    db,
  )
  return row!
}
export async function claimJob(kinds: Job['kind'][]): Promise<Job | undefined> {
  return transaction(async (db) => {
    // Serialize farm claims across workers, including a manual run racing the scheduler.
    if (kinds.some((kind) => (farmModelKinds as readonly string[]).includes(kind)))
      await lockResearchWindow(db)
    // Priority: orders, then selection and reports, then research, scouting and leads.
    // Scheduled jobs (daily slots and payload.scheduled) wait for the schedule switch.
    const [row] = await query<Job>(
      `SELECT j.* FROM jobs j CROSS JOIN system_state s
      WHERE j.kind=ANY($1) AND j.status='queued' AND j.run_after<=now() AND j.attempts<j.max_attempts
      AND (j.kind='evaluate'
        OR (j.kind=ANY($3) AND s.mode='running' AND s.research_enabled)
        OR (j.kind IN ('fulfill','evolve') AND s.mode<>'emergency_stop'))
      AND (NOT j.kind=ANY($3) OR NOT EXISTS (SELECT 1 FROM jobs active WHERE active.kind=ANY($3) AND active.status='running'))
      AND ((j.dedupe_key !~ '^research:[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND NOT (j.payload ? 'scheduleSlot')
            AND COALESCE(j.payload->>'scheduled','')<>'true')
        OR ($2 AND s.schedule_enabled))
      ORDER BY CASE j.kind WHEN 'fulfill' THEN 0 WHEN 'evolve' THEN 1 WHEN 'evaluate' THEN 1
        WHEN 'report' THEN 2 WHEN 'research' THEN 3 WHEN 'scout' THEN 4 WHEN 'lead' THEN 5 ELSE 6 END,
        j.created_at,j.payload->>'campaignPosition',j.id
      FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      [kinds, config().AUTONOMY_ENABLED, farmModelKinds],
      db,
    )
    if (!row) return
    if (
      ((row.kind === 'research' && row.payload.campaignId) ||
        ['scout', 'lead', 'report'].includes(row.kind)) &&
      (await deferForDailyBudget(row, db))
    )
      return
    const [claimed] = await query<Job>(
      `UPDATE jobs SET status='running', attempts=attempts+1,started_at=COALESCE(started_at,now()),
      error_code=CASE WHEN error_code IN ('RESEARCH_DAILY_BUDGET_WAIT','FARM_DAILY_BUDGET_WAIT','FARM_PACING_WAIT','WORKER_DRAINING') THEN null ELSE error_code END,
      locked_until=now()+interval '2 minutes', lease_token=$2 WHERE id=$1 RETURNING *`,
      [row.id, randomUUID()],
      db,
    )
    return claimed
  })
}

/**
 * A depleted day can recover at midnight; exhausted task or lifetime limits cannot. Covers
 * research campaign steps and the farm jobs (scout, lead, report).
 */
async function deferForDailyBudget(job: Job, db: Connection) {
  const c = config()
  const category = job.kind as BudgetCategory
  const reserve = reserveFor(category)
  if (reserve === 0 || reserve > c.DAILY_BUDGET_KOPECKS) return false
  await query('SELECT pg_advisory_xact_lock(735093)', [], db)
  // Existing reservations already own their envelope. Only meteredCall knows the next
  // exact maximum: do not mask an insufficient remainder or uncertain call with a delay.
  if (
    (
      await query(
        'SELECT id FROM budget_reservations WHERE dedupe_key=$1',
        [`${category}:${job.id}`],
        db,
      )
    ).length
  )
    return false
  const budget = await budgetSummary(db)
  const outstanding = budget.outstanding + reserve
  const protectedOrders = Math.min(100000, Math.floor(c.MONTHLY_BUDGET_KOPECKS / 3))
  if (
    outstanding > c.DAILY_BUDGET_KOPECKS ||
    budget.monthSpent + outstanding + protectedOrders > c.MONTHLY_BUDGET_KOPECKS ||
    (c.MODEL_PROVIDER === 'openai' &&
      budget.openaiSpentMicrousd >= c.OPENAI_TOTAL_BUDGET_MICROUSD) ||
    (c.MODEL_PROVIDER === 'openrouter' && budget.openrouterActualMicrousd > 0)
  )
    return false
  if (budget.daySpent + outstanding <= c.DAILY_BUDGET_KOPECKS) {
    if (c.PACING_ENABLED) {
      const numbers = await pacingNumbers(db)
      const pace = pacingDecision({
        ...numbers,
        category,
        limit: reserve,
        expectedKopecks: numbers.expectedByCategory[category] ?? reserve,
        dailyKopecks: c.DAILY_BUDGET_KOPECKS,
        now: new Date(),
      })
      if (!pace.allowed) {
        const [previous] = await query('SELECT error_code FROM jobs WHERE id=$1', [job.id], db)
        await query(
          "UPDATE jobs SET error_code='FARM_PACING_WAIT',run_after=$2 WHERE id=$1",
          [job.id, pace.retryAt],
          db,
        )
        if (previous?.error_code !== 'FARM_PACING_WAIT')
          await audit(
            'farm_pacing_wait',
            'Задача ждёт своего часа: бюджет модели распределяется равномерно по суткам.',
            {
              jobId: job.id,
              kind: job.kind,
              nextAt: pace.retryAt,
              allowanceKopecks: pace.allowanceKopecks,
              reserveKopecks: reserve,
              expectedKopecks: numbers.expectedByCategory[category] ?? reserve,
            },
            db,
          )
        return true
      }
    }
    // Allocate under the same budget lock: a simultaneous order cannot consume the
    // checked room between this preflight and the worker's first reservation request.
    await reserveBudget(`${category}:${job.id}`, category, db)
    return false
  }
  const research = job.kind === 'research'
  const [postponed] = await query(
    `UPDATE jobs SET error_code=$2,
     run_after=(date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day 5 seconds') AT TIME ZONE 'UTC'
     WHERE id=$1 RETURNING run_after`,
    [job.id, research ? 'RESEARCH_DAILY_BUDGET_WAIT' : 'FARM_DAILY_BUDGET_WAIT'],
    db,
  )
  await audit(
    research ? 'research_daily_budget_wait' : 'farm_daily_budget_wait',
    research
      ? 'Направление ждёт следующего суточного бюджета. Попытки, расходы и обязательства сохранены.'
      : budget.daySpent < c.DAILY_BUDGET_KOPECKS
        ? 'Дневной бюджет распределён: часть потрачена, остальное занято начатыми задачами. Задача продолжится завтра.'
        : 'Дневной лимит исчерпан. Задача продолжится завтра.',
    {
      jobId: job.id,
      kind: job.kind,
      campaignId: job.payload.campaignId,
      nextAt: postponed!.run_after,
      dailyKopecks: c.DAILY_BUDGET_KOPECKS,
      // Spent and reserved separately: "exhausted" while only part is spent confused the owner.
      daySpentKopecks: budget.daySpent,
      reservedKopecks: budget.outstanding,
    },
    db,
  )
  return true
}

/**
 * Expected cost per paced category: the p90 of what each recently closed task (reservation)
 * was charged in total, real calls only, capped by the current reservation.
 */
export async function expectedCosts(db: Connection = pool) {
  const paced = Object.keys(pacingShares) as BudgetCategory[]
  const rows = await query(
    `SELECT r.category, count(*)::int AS n,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY s.total) AS p90
     FROM budget_reservations r
     JOIN LATERAL (SELECT sum(t.charged_kopecks) AS total FROM tool_calls t
       WHERE t.reservation_id=r.id AND NOT t.is_demo AND t.status<>'pending') s ON s.total IS NOT NULL
     WHERE r.status='closed' AND r.category=ANY($1)
       AND r.created_at >= now() - make_interval(days => $2)
       AND NOT EXISTS (SELECT 1 FROM tool_calls p WHERE p.reservation_id=r.id AND p.status='pending')
     GROUP BY r.category`,
    [paced, expectedCostWindowDays],
    db,
  )
  const stats = new Map(rows.map((r) => [r.category as string, r]))
  return Object.fromEntries(
    paced.map((category) => {
      const stat = stats.get(category)
      return [
        category,
        expectedTaskCost(reserveFor(category), {
          count: stat ? Number(stat.n) : 0,
          p90: stat ? Number(stat.p90) : Number.NaN,
        }),
      ]
    }),
  ) as Partial<Record<BudgetCategory, number>>
}

/** Today's spending split at the current UTC hour, and the trading manager's remaining need. */
export async function pacingNumbers(db: Connection = pool) {
  const [row] = await query(
    `WITH day AS (SELECT date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS at),
    hour AS (SELECT date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS at)
    SELECT
      COALESCE((SELECT sum(charged_kopecks) FROM tool_calls WHERE created_at>=(SELECT at FROM day) AND created_at<(SELECT at FROM hour)),0)::int AS before_hour,
      COALESCE((SELECT sum(charged_kopecks) FROM tool_calls WHERE created_at>=(SELECT at FROM hour)),0)::int AS this_hour,
      COALESCE((SELECT enabled FROM trading_manager WHERE id=true),false) AND
        COALESCE((SELECT mode='running' FROM system_state WHERE id=true),false) AS manager_enabled,
      (SELECT count(*)::int FROM trading_manager_runs WHERE created_at>=(SELECT at FROM day)) AS manager_runs,
      COALESCE((SELECT sum(t.charged_kopecks) FROM tool_calls t JOIN budget_reservations r ON r.id=t.reservation_id
        WHERE r.category='trading_manager' AND t.created_at>=(SELECT at FROM day)),0)::int AS manager_spent,
      COALESCE((SELECT sum(limit_kopecks-spent_kopecks) FROM budget_reservations WHERE category='trading_manager' AND status='open'),0)::int AS manager_reserved`,
    [],
    db,
  )
  const expectedKopecks = await expectedCosts(db)
  // Open envelopes of paced farm tasks count at their expected cost; others at their remainder.
  const open = await query(
    `SELECT category,(limit_kopecks-spent_kopecks)::int AS remaining FROM budget_reservations
     WHERE status='open' AND limit_kopecks>spent_kopecks`,
    [],
    db,
  )
  const outstanding = open.reduce(
    (sum, r) =>
      sum +
      Math.min(r.remaining as number, expectedKopecks[r.category as BudgetCategory] ?? Infinity),
    0,
  )
  const limits = managerLimits()
  return {
    expectedByCategory: expectedKopecks,
    spentBeforeHour: row!.before_hour as number,
    usedThisHour: (row!.this_hour as number) + outstanding,
    managerFloor: managerFloor({
      enabled: !!row!.manager_enabled && reserveFor('trading_manager') > 0,
      reserveKopecks: limits.reserveKopecks,
      dailyKopecks: limits.dailyKopecks,
      maxDailyRuns: limits.maxDailyRuns,
      runsToday: row!.manager_runs as number,
      spentToday: row!.manager_spent as number,
      reservedOpen: row!.manager_reserved as number,
    }),
  }
}

/** Owners may start a new run when the previous one ends; parallel clicks share the active job. */
export async function requestResearch(template?: Template) {
  if (template !== undefined) templateSchema.parse(template)
  const result = await transaction(async (db) => {
    const state = await lockResearchWindow(db)
    if (!state.research_enabled) return { error: 'RESEARCH_WINDOW_CLOSED' } as const
    if (state?.mode !== 'running') throw new Error('RESEARCH_PAUSED')
    const [active] = await query(
      `SELECT id,status FROM jobs WHERE kind='research' AND status IN ('queued','running')
       AND (status='running' OR (dedupe_key !~ '^research:[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND NOT (payload ? 'scheduleSlot')) OR $1)
       ORDER BY created_at LIMIT 1`,
      [config().AUTONOMY_ENABLED && state.schedule_enabled],
      db,
    )
    if (active) return { id: active.id as string, status: active.status as string, reused: true }
    const job = await enqueue(
      'research',
      `manual-research:${randomUUID()}`,
      template ? { templates: JSON.stringify([template]) } : {},
      db,
    )
    await audit(
      'research_requested',
      'Владелец запустил дополнительное исследование.',
      { jobId: job.id, template: template || 'auto' },
      db,
    )
    return { id: job.id as string, status: job.status as string, reused: false }
  })
  // Keep the window closure and its audit committed when admission is denied.
  if ('error' in result) throw new Error(result.error)
  return result
}
export async function heartbeatJob(job: Job) {
  const result = await query(
    "UPDATE jobs SET locked_until=now()+interval '2 minutes' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
    [job.id, job.lease_token],
  )
  if (!result.length) throw new Error('LEASE_LOST')
}
export async function finishJob(job: Job, error?: unknown) {
  let code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
      ? error.message
      : error
        ? 'JOB_FAILED'
        : null
  await transaction(async (db) => {
    const [current] = await query(
      'SELECT * FROM jobs WHERE id=$1 AND lease_token=$2 FOR UPDATE',
      [job.id, job.lease_token],
      db,
    )
    if (!current || current.status !== 'running') return
    if (error instanceof WorkerDraining) {
      const unresolved = await query(
        `SELECT id FROM tool_calls WHERE status IN ('pending','uncertain') AND (
          job_id=$1 OR reservation_id IN (
            SELECT id FROM budget_reservations WHERE dedupe_key=$2
            UNION SELECT reservation_id FROM orders WHERE id::text=$3
          )
        ) AND NOT (COALESCE(provider,'')=ANY($4) AND charged_kopecks=0 AND COALESCE(charged_microusd,0)=0
          AND COALESCE(actual_microusd,0)=0
          AND COALESCE(error_code,'') !~ 'COST|POLICY|BYOK|FREE_MODEL|REFUSED|CONTENT|BUDGET')
        LIMIT 1`,
        // Free providers charge nothing: their interrupted calls are repeated, not reviewed.
        [job.id, `${job.kind}:${job.id}`, job.payload.orderId || '', freeProviders],
        db,
      )
      if (!unresolved.length) {
        await query(
          `UPDATE jobs SET status='queued',attempts=GREATEST(attempts-1,0),
           error_code='WORKER_DRAINING',locked_until=null,lease_token=null,
           run_after=now(),finished_at=null WHERE id=$1`,
          [job.id],
          db,
        )
        await audit(
          'job_yielded',
          'Обработчик штатно остановлен между этапами. Ответы, расходы и резерв сохранены; попытка возвращена.',
          { jobId: job.id, kind: job.kind },
          db,
        )
        return
      }
      // A lifecycle signal cannot turn an ambiguous earlier charge into a safe retry.
      code = 'UNCERTAIN_CALL_REQUIRES_REVIEW'
    }
    const terminal =
      !!code &&
      (job.attempts >= job.max_attempts ||
        /POLICY|UNCERTAIN|BUDGET|INPUT|SOURCE|SCHEMA|REVIEW|OUTPUT|PROVIDER_CHANGED|RECIPE_REFRESH|TRANSLATION_LANGUAGE|^RESERVATION_CLOSED$|^RESEARCH_WINDOW_CLOSED$/.test(
          code,
        ))
    await query(
      `UPDATE jobs SET status=$2,error_code=$3,locked_until=null,lease_token=null,
      run_after=now()+make_interval(secs=>$4),finished_at=CASE WHEN $2 IN ('done','failed') THEN now() ELSE null END WHERE id=$1`,
      [
        job.id,
        code ? (terminal ? 'failed' : 'queued') : 'done',
        code,
        Math.min(300, job.attempts * 15),
      ],
      db,
    )
    if (terminal) {
      await query(
        "UPDATE orders SET status='manual_review' WHERE id::text=$1 AND status IN ('paid','running')",
        [job.payload.orderId || ''],
        db,
      )
      await query(
        "UPDATE budget_reservations SET status='closed' WHERE dedupe_key=$1 OR id IN (SELECT reservation_id FROM orders WHERE id::text=$2)",
        [`${job.kind}:${job.id}`, job.payload.orderId || ''],
        db,
      )
    }
    await audit(
      code ? 'job_error' : 'job_done',
      code ? `Задание остановлено: ${code}` : 'Задание выполнено',
      { jobId: job.id, kind: job.kind, terminal },
      db,
    )
  })
}
export async function recoverJobs() {
  await transaction(async (db) => {
    const rows = await query(
      `UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
      error_code='LEASE_EXPIRED',locked_until=null,lease_token=null,run_after=now()
      WHERE status='running' AND locked_until<now() RETURNING *`,
      [],
      db,
    )
    for (const row of rows) {
      await audit(
        'job_recovered',
        'Восстановлено задание после пропущенного heartbeat',
        { jobId: row.id, status: row.status },
        db,
      )
      if (row.status === 'failed') {
        await query(
          "UPDATE orders SET status='manual_review' WHERE id::text=$1 AND status IN ('paid','running')",
          [row.payload.orderId || ''],
          db,
        )
        await query(
          "UPDATE budget_reservations SET status='closed' WHERE dedupe_key=$1 OR id IN (SELECT reservation_id FROM orders WHERE id::text=$2)",
          [`${row.kind}:${row.id}`, row.payload.orderId || ''],
          db,
        )
      }
    }
  })
}

export async function expireResearchSlots(day: string) {
  await transaction(async (db) => {
    // An attempted job owns durable responses and its reservation, even after another
    // restart replaces WORKER_DRAINING with LEASE_EXPIRED. Only expire unused slots.
    const stale = await query(
      `UPDATE jobs SET status='failed',error_code='RESEARCH_SLOT_EXPIRED',finished_at=now()
      WHERE kind='research' AND status='queued' AND NOT (payload ? 'campaignId')
      AND started_at IS NULL AND (
        (dedupe_key ~ '^research:[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND right(dedupe_key,10)<$1)
        OR (dedupe_key LIKE 'manual-research:%' AND created_at < ($1::date::timestamp AT TIME ZONE 'UTC'))
      ) RETURNING id`,
      [day],
      db,
    )
    for (const job of stale) {
      await query(
        "UPDATE budget_reservations SET status='closed' WHERE dedupe_key=$1",
        [`research:${job.id}`],
        db,
      )
      await audit(
        'research_slot_expired',
        'Пропущен устаревший суточный слот; исследования не накапливаются после паузы.',
        { jobId: job.id },
        db,
      )
    }
    // Scouting and lead slots of past days do not pile up after a pause either: scheduled ones
    // by the day in their key, the owner's "find ideas now" scouts by the day they were asked
    // for (like manual research above). The owner can press the button again today.
    const farm = await query(
      `UPDATE jobs SET status='failed',error_code='FARM_SLOT_EXPIRED',finished_at=now()
      WHERE kind IN ('scout','lead') AND status='queued' AND started_at IS NULL
      AND COALESCE(error_code,'')<>'FARM_DAILY_BUDGET_WAIT'
      AND ((dedupe_key ~ '^(scout|lead):[0-9]{4}-[0-9]{2}-[0-9]{2}:'
        AND substr(dedupe_key, strpos(dedupe_key, ':')+1, 10)<$1)
        OR (dedupe_key LIKE 'scout-manual:%'
          AND created_at < ($1::date::timestamp AT TIME ZONE 'UTC')))
      RETURNING id,kind,dedupe_key`,
      [day],
      db,
    )
    for (const job of farm)
      await query(
        "UPDATE budget_reservations SET status='closed' WHERE dedupe_key=$1",
        [`${job.kind}:${job.id}`],
        db,
      )
    if (farm.length)
      await audit(
        'farm_slots_expired',
        'Вчерашние задачи разведки и поиска клиентов пропущены, чтобы не копить очередь.',
        { jobIds: farm.map((job) => job.id) },
        db,
      )
    // A manual batch whose last scout expired still gets its report: ideas the earlier scouts
    // found are ranked and the best go to research.
    const manual = farm.find((job) => String(job.dedupe_key).startsWith('scout-manual:'))
    if (
      manual &&
      !(
        await query(
          `SELECT id FROM jobs WHERE kind='scout' AND dedupe_key LIKE 'scout-manual:%'
           AND status IN ('queued','running') LIMIT 1`,
          [],
          db,
        )
      ).length &&
      (await query('SELECT id FROM ideas WHERE ranked_at IS NULL LIMIT 1', [], db)).length
    ) {
      const reportKey = `report:after-scouts:${manual.id}`
      await enqueue('report', reportKey, { kind: 'daily', reportKey }, db)
    }
  })
}
