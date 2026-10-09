import { randomUUID } from 'node:crypto'
import { config } from '../config'
import { isDemoStand } from '../stand'
import { audit, query, transaction, type Connection } from '../db'
import { closeReservation, reserveBudget } from '../budget'
import { model } from '../providers'
import { demoReport } from '../providers/demo'
import { reportSchemaFor, validateReport, type ReportNarrative } from '../policy'
import { enqueue, type Job } from '../queue'
import { applyIdeaDecisions } from '../ideas'
import { categoryById } from '../taxonomy'
import { formatRub } from '../storefront'
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

/**
 * Server numbers for the period. The manager model receives them; it never computes them. On a
 * stand with a real model, demo ideas, products, orders, leads and calls are left out.
 */
export async function reportMetrics(start: Date, end: Date, db?: Connection) {
  const [row] = await query(
    `WITH i AS (SELECT * FROM ideas WHERE created_at>=$1 AND created_at<$2 AND (NOT is_demo OR $3))
     SELECT
      (SELECT count(*)::int FROM i) AS ideas,
      (SELECT count(*)::int FROM i WHERE critique->>'verdict'='PASS') AS passed,
      (SELECT count(*)::int FROM i WHERE critique->>'verdict'='REVISE') AS revise,
      (SELECT count(*)::int FROM i WHERE critique->>'verdict'='BLOCKED') AS blocked,
      (SELECT count(*)::int FROM i WHERE duplicate_of IS NOT NULL) AS duplicates,
      (SELECT count(*)::int FROM i WHERE status IN ('accepted','productized')) AS accepted,
      (SELECT count(*)::int FROM i WHERE status='needs_human') AS "needsHuman",
      (SELECT count(*)::int FROM jobs j WHERE kind='scout' AND created_at>=$1 AND created_at<$2 AND status='done'
        AND ($3 OR NOT EXISTS (SELECT 1 FROM ideas d WHERE d.job_id=j.id AND d.is_demo))) AS "scoutsDone",
      (SELECT count(*)::int FROM jobs WHERE kind='scout' AND created_at>=$1 AND created_at<$2 AND status='failed') AS "scoutsFailed",
      (SELECT count(*)::int FROM products WHERE visibility='public' AND status='sandbox' AND (NOT is_demo OR $3)) AS "publicProducts",
      (SELECT count(*)::int FROM opportunities WHERE first_seen_at>=$1 AND first_seen_at<$2 AND (NOT is_demo OR $3)) AS leads,
      (SELECT count(*)::int FROM orders o WHERE delivered_at>=$1 AND delivered_at<$2
        AND ($3 OR NOT EXISTS (SELECT 1 FROM product_versions v WHERE v.product_id=o.product_id
          AND v.version::text=o.product_snapshot->>'version' AND v.is_demo))) AS "ordersDelivered",
      (SELECT COALESCE(sum(charged_kopecks),0)::int FROM tool_calls WHERE created_at>=$1 AND created_at<$2 AND (NOT is_demo OR $3)) AS "spentKopecks",
      (SELECT COALESCE(sum(revenue_kopecks),0)::int FROM orders) AS "realRevenueKopecks"`,
    [start, end, isDemoStand()],
    db,
  )
  return row as Record<string, number>
}

const statusWords: Record<string, string> = {
  new: 'ждёт решения',
  accepted: 'принята, ферма сделает сама',
  needs_human: 'нужен человек',
  rejected: 'отклонена',
  productized: 'продукт уже на сайте',
}
const verdictWords: Record<string, string> = {
  PASS: 'критик принял',
  REVISE: 'критик вернул на доработку',
  BLOCKED: 'критик отклонил',
}

/**
 * What the manager model sees: the same server numbers in words, Russian labels instead of
 * status codes. Codes in the context ended up in the text ("ужеaccepted", "REVISE").
 */
export function reportContextFor(
  metrics: Record<string, number>,
  ranking: Awaited<ReturnType<typeof reportRanking>>,
) {
  return {
    numbers: {
      'Идей найдено': metrics.ideas ?? 0,
      'Принято критиком': metrics.passed ?? 0,
      'Возвращено на доработку': metrics.revise ?? 0,
      'Отклонено критиком': metrics.blocked ?? 0,
      Повторов: metrics.duplicates ?? 0,
      'Ферма сделает сама': metrics.accepted ?? 0,
      'Нужен человек': metrics.needsHuman ?? 0,
      'Разведок завершено': metrics.scoutsDone ?? 0,
      'Разведок с ошибкой': metrics.scoutsFailed ?? 0,
      'Продуктов на сайте': metrics.publicProducts ?? 0,
      'Найдено запросов клиентов': metrics.leads ?? 0,
      'Выдано заказов': metrics.ordersDelivered ?? 0,
      'Расходы на модели': formatRub(metrics.spentKopecks ?? 0),
      'Настоящая выручка': formatRub(metrics.realRevenueKopecks ?? 0),
    },
    ranking: ranking.map((item, index) => ({
      ideaId: item.ideaId,
      Место: index + 1,
      Название: item.title,
      Балл: item.rankScore,
      Статус: statusWords[item.status] ?? 'ждёт решения',
      Критик: verdictWords[item.verdict] ?? 'нет решения',
      Отрасль: item.industry,
    })),
  }
}

async function reportRanking(start: Date, end: Date, db?: Connection) {
  const rows = await query(
    `SELECT i.id,i.title,i.rank_score,i.status,i.category,i.farm_executable,i.critique->>'verdict' AS verdict
     FROM ideas i WHERE created_at>=$1 AND created_at<$2 AND (NOT is_demo OR $3)
     ORDER BY rank_score DESC,created_at,id LIMIT 10`,
    [start, end, isDemoStand()],
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
    const ideaIds = ranking.map((item) => item.ideaId)
    narrative = validateReport(
      await model({
        role: 'Руководитель',
        key: `${job.id}:report`,
        reservationId,
        context: {
          period: {
            kind: kind === 'weekly' ? 'неделя' : 'день',
            start: start.toISOString(),
            end: end.toISOString(),
          },
          ...reportContextFor(metrics, ranking),
          task: 'Напиши короткий отчёт руководителя для владельца по серверным цифрам numbers и рейтингу ranking. headline: главный итог одной фразой. summary: 2-4 предложения простыми словами. ideaComments: по одному короткому комментарию к лучшим идеям из ranking (поле ideaId только из списка, в тексте называй идею по названию, без идентификаторов). nextActions: что ферма сделает дальше. needsOwner: что требует решения владельца. Пиши по-русски без английских слов, кодов и длинного тире. Не меняй цифры, не ранжируй заново, не обещай доход. Цены, бюджет и лимиты задаёт сервер: не предлагай владельцу их менять или подтверждать. Тестовые оплаты не выручка.',
        },
        schema: reportSchemaFor(ideaIds),
        demoValue: demoReport(metrics, ranking),
      }),
      ideaIds,
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
       EXISTS(SELECT 1 FROM products p WHERE p.template=i.suggested_template AND p.visibility='public' AND p.status='sandbox'
         AND (NOT p.is_demo OR $1)) AS listed
     FROM ideas i
     WHERE i.status='accepted' AND i.farm_executable AND i.suggested_template IS NOT NULL
     AND (NOT i.is_demo OR $1)
     AND NOT EXISTS(SELECT 1 FROM hypotheses h WHERE h.idea_id=i.id)
     AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.dedupe_key='idea-research:'||i.id::text)
     ORDER BY listed,i.rank_score DESC,i.created_at,i.id LIMIT 50`,
    [isDemoStand()],
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
