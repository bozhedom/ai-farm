import { randomUUID } from 'node:crypto'
import { config } from '../config'
import { audit, query, transaction, type Connection } from '../db'
import { closeReservation, reserveBudget } from '../budget'
import { model } from '../providers'
import { demoReport } from '../providers/demo'
import { reportSchemaFor, validateReport, type ReportNarrative } from '../policy'
import { enqueue, type Job } from '../queue'
import { applyIdeaDecisions } from '../ideas'
import { categoryById } from '../taxonomy'
import { errorCode, mustPropagate, withLease } from './lease'

export type ReportKind = 'daily' | 'weekly'
const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`)

/** Report period: a UTC day so far, or the last seven days. */
export function reportPeriod(kind: ReportKind, key: string, now = new Date()) {
  if (kind === 'daily') {
    const day =
      /^report:daily:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1] ?? now.toISOString().slice(0, 10)
    const start = dayStart(day)
    const end = new Date(Math.min(now.getTime(), start.getTime() + 86400000))
    return { start, end: end > start ? end : new Date(start.getTime() + 86400000) }
  }
  return { start: new Date(now.getTime() - 7 * 86400000), end: now }
}

/** Server numbers for the period. The manager model receives them; it never computes them. */
export async function reportMetrics(start: Date, end: Date, db?: Connection) {
  const [row] = await query(
    `SELECT
      (SELECT count(*)::int FROM ideas WHERE created_at>=$1 AND created_at<$2) AS ideas,
      (SELECT count(*)::int FROM ideas WHERE created_at>=$1 AND created_at<$2 AND critique->>'verdict'='PASS') AS passed,
      (SELECT count(*)::int FROM ideas WHERE created_at>=$1 AND created_at<$2 AND critique->>'verdict'='REVISE') AS revise,
      (SELECT count(*)::int FROM ideas WHERE created_at>=$1 AND created_at<$2 AND critique->>'verdict'='BLOCKED') AS blocked,
      (SELECT count(*)::int FROM ideas WHERE created_at>=$1 AND created_at<$2 AND duplicate_of IS NOT NULL) AS duplicates,
      (SELECT count(*)::int FROM ideas WHERE created_at>=$1 AND created_at<$2 AND status IN ('accepted','productized')) AS accepted,
      (SELECT count(*)::int FROM ideas WHERE created_at>=$1 AND created_at<$2 AND status='needs_human') AS "needsHuman",
      (SELECT count(*)::int FROM jobs WHERE kind='scout' AND created_at>=$1 AND created_at<$2 AND status='done') AS "scoutsDone",
      (SELECT count(*)::int FROM jobs WHERE kind='scout' AND created_at>=$1 AND created_at<$2 AND status='failed') AS "scoutsFailed",
      (SELECT count(*)::int FROM products WHERE visibility='public' AND status='sandbox') AS "publicProducts",
      (SELECT count(*)::int FROM opportunities WHERE first_seen_at>=$1 AND first_seen_at<$2) AS leads,
      (SELECT count(*)::int FROM orders WHERE delivered_at>=$1 AND delivered_at<$2) AS "ordersDelivered",
      (SELECT COALESCE(sum(charged_kopecks),0)::int FROM tool_calls WHERE created_at>=$1 AND created_at<$2) AS "spentKopecks",
      (SELECT COALESCE(sum(revenue_kopecks),0)::int FROM orders) AS "realRevenueKopecks"`,
    [start, end],
    db,
  )
  return row as Record<string, number>
}

async function reportRanking(start: Date, end: Date, db?: Connection) {
  const rows = await query(
    `SELECT i.id,i.title,i.rank_score,i.status,i.category,i.farm_executable,i.critique->>'verdict' AS verdict
     FROM ideas i WHERE created_at>=$1 AND created_at<$2
     ORDER BY rank_score DESC,created_at,id LIMIT 10`,
    [start, end],
    db,
  )
  return rows.map((row) => ({
    ideaId: row.id as string,
    title: row.title as string,
    rankScore: row.rank_score as number,
    status: row.status as string,
    industry: categoryById[row.category]?.label ?? row.category,
    verdict: row.verdict as string,
    farmExecutable: row.farm_executable as boolean,
  }))
}

/**
 * Manager report: deterministic decisions and ranking by the server, one model call for the
 * text, then research of the best farm-executable ideas. Without a model answer the report is
 * saved with numbers only.
 */
export async function report(job: Job) {
  const kind: ReportKind = job.payload.kind === 'weekly' ? 'weekly' : 'daily'
  const key =
    job.payload.reportKey ||
    (kind === 'daily'
      ? `report:daily:${new Date().toISOString().slice(0, 10)}`
      : `report:${job.id}`)
  if ((await query('SELECT id FROM manager_reports WHERE report_key=$1', [key])).length) return
  const { start, end } = reportPeriod(kind, key)
  const changed = await transaction((db) => applyIdeaDecisions(db))
  const [metrics, ranking, [state]] = await Promise.all([
    reportMetrics(start, end),
    reportRanking(start, end),
    query('SELECT generation FROM system_state WHERE id=true'),
  ])
  const demo = config().MODEL_PROVIDER === 'demo'
  const reservationId = await reserveBudget(`report:${job.id}`, 'report')
  let narrative: ReportNarrative | null = null
  let narrativeError: string | null = null
  try {
    narrative = validateReport(
      await model({
        role: 'Руководитель',
        key: `${job.id}:report`,
        reservationId,
        context: {
          period: { kind, start: start.toISOString(), end: end.toISOString() },
          metrics,
          ranking,
          task: 'Напиши короткий отчёт руководителя для владельца по серверным цифрам и рейтингу. headline: главный итог одной фразой. summary: 2-4 предложения простыми словами. ideaComments: по одному короткому комментарию к лучшим идеям из ranking (ideaId только из списка). nextActions: что ферма сделает дальше. needsOwner: что требует решения владельца. Не меняй цифры, не ранжируй заново, не обещай доход. Тестовые оплаты не выручка.',
        },
        schema: reportSchemaFor(ranking.map((item) => item.ideaId)),
        demoValue: demoReport(metrics, ranking),
      }),
    )
  } catch (error) {
    if (mustPropagate(error)) throw error
    narrativeError = errorCode(error, 'REPORT_MODEL_FAILED')
  }
  const limit = config().IDEA_PRODUCTS_PER_DAY
  await withLease(job, async (db) => {
    const rows = await query(
      `INSERT INTO manager_reports(id,report_key,kind,job_id,generation,period_start,period_end,metrics,ranking,narrative,is_demo)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(report_key) DO NOTHING RETURNING id`,
      [
        randomUUID(),
        key,
        kind,
        job.id,
        state!.generation,
        start,
        end,
        metrics,
        JSON.stringify(ranking),
        narrative,
        demo,
      ],
      db,
    )
    if (!rows.length) return
    await audit(
      'report_ready',
      narrative
        ? `Руководитель написал отчёт: ${narrative.headline}`
        : 'Руководитель собрал отчёт по цифрам. Текст модели не получен.',
      {
        reportId: rows[0]!.id,
        kind,
        headline: narrative?.headline ?? null,
        ideas: metrics.ideas,
        accepted: changed.filter((c) => c.status === 'accepted').length,
        narrativeError,
        isDemo: demo,
      },
      db,
    )
    await scheduleIdeaResearch(db, limit, job.payload.scheduled === 'true')
  })
  await closeReservation(reservationId)
}

/**
 * Research the best accepted ideas the farm can execute, at most `limit` a day. Templates
 * without a public product go first, so the storefront grows before versions are replaced.
 */
export async function scheduleIdeaResearch(db: Connection, limit: number, scheduled: boolean) {
  const [today] = await query(
    `SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE 'idea-research:%'
     AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [],
    db,
  )
  let room = Math.max(0, limit - (today!.n as number))
  if (!room) return []
  const candidates = await query(
    `SELECT i.id,i.suggested_template,i.strategy_id,i.title,
       EXISTS(SELECT 1 FROM products p WHERE p.template=i.suggested_template AND p.visibility='public' AND p.status='sandbox') AS listed
     FROM ideas i
     WHERE i.status='accepted' AND i.farm_executable AND i.suggested_template IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM hypotheses h WHERE h.idea_id=i.id)
     AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.dedupe_key='idea-research:'||i.id::text)
     ORDER BY listed,i.rank_score DESC,i.created_at,i.id LIMIT 50`,
    [],
    db,
  )
  const picked: { id: string; template: string }[] = []
  for (const row of candidates) {
    if (!room) break
    if (picked.some((p) => p.template === row.suggested_template)) continue
    const job = await enqueue(
      'research',
      `idea-research:${row.id}`,
      {
        templates: JSON.stringify([row.suggested_template]),
        ideaId: row.id,
        strategyId: row.strategy_id,
        ...(scheduled ? { scheduled: 'true' } : {}),
      },
      db,
    )
    picked.push({ id: row.id, template: row.suggested_template })
    room--
    await audit(
      'idea_research_scheduled',
      `Руководитель отправил идею «${row.title}» на сборку продукта.`,
      { ideaId: row.id, jobId: job.id, template: row.suggested_template },
      db,
    )
  }
  return picked
}
