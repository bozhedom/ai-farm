import { randomUUID } from 'node:crypto'
import { config } from '../core/config'
import { pool, query } from '../core/db'
import { enqueue, type Job } from '../core/queue'
import { claimWorkerJob, executeWorkerJob } from '../core/worker-runtime'
import { requestScout } from '../core/autonomy'
import { ensureStrategyParams } from '../core/agents'
import { requestEvolution } from '../core/evolution'
import { activityFeed } from '../core/activity-feed'

/**
 * Prepares the office and the storefront for a show: a few full farm cycles (scouting by all
 * agents, a manager report, research of the best ideas with publication, lead search with
 * reply drafts) and one quality selection round with a lowered K. It uses the configured
 * providers. Refuses to touch a working database unless its name ends with _test, the demo
 * provider is configured, or --i-know-this-is-production is passed.
 */
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string, fallback: number) => {
  const index = args.indexOf(name)
  const value = index >= 0 ? Number(args[index + 1]) : fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) throw new Error(`BAD_OPTION ${name}`)
  return value
}
const cycles = option('--cycles', 2)
const minIdeas = option('--min-ideas', 2)
const c = config()

const [database] = await query('SELECT current_database() AS name')
const testDatabase = String(database?.name).endsWith('_test')
if (!testDatabase && c.MODEL_PROVIDER !== 'demo' && !flag('--i-know-this-is-production')) {
  console.error(
    `Отказ: база «${database?.name}» не тестовая, а модель не демо. Запустите на базе *_test, с MODEL_PROVIDER=demo или с флагом --i-know-this-is-production.`,
  )
  await pool.end()
  process.exit(2)
}
const [state] = await query('SELECT mode,research_enabled,evolution_min_ideas FROM system_state')
if (state?.mode !== 'running' || !state.research_enabled) {
  console.error('Ферма на паузе или сезон закрыт. Включите работу в кабинете и повторите.')
  await pool.end()
  process.exit(3)
}
console.log(
  `База ${database?.name}, модель ${c.MODEL_PROVIDER}, поиск ${c.SEARCH_PROVIDER}. Циклов: ${cycles}, порог отбора: ${minIdeas}.`,
)
await ensureStrategyParams()

const started = Date.now()
/** Same path as the worker: lease heartbeat every 10 seconds, so slow free models keep their job. */
async function drain(kinds: Job['kind'][], label: string) {
  let count = 0
  for (;;) {
    const job = await claimWorkerJob(kinds, () => false)
    if (!job) break
    await executeWorkerJob(job, {
      isStopping: () => false,
      onHeartbeatError: () => console.error('  аренда задачи потеряна'),
    })
    count++
    const [row] = await query('SELECT status,error_code FROM jobs WHERE id=$1', [job.id])
    console.log(
      `  ${label}: ${job.kind} ${row?.status === 'done' ? 'готово' : `не удалось (${row?.error_code}), статус ${row?.status}`}`,
    )
  }
  return count
}

const day = new Date().toISOString().slice(0, 10)
for (let cycle = 1; cycle <= cycles; cycle++) {
  console.log(`Цикл ${cycle}: разведка всеми агентами`)
  await requestScout()
  await drain(['scout'], 'разведка')
  console.log(`Цикл ${cycle}: отчёт руководителя и сборка продуктов`)
  const reportKey = `report:demo:${day}:${cycle}:${randomUUID().slice(0, 8)}`
  await enqueue('report', reportKey, { kind: 'daily', reportKey })
  await drain(['report'], 'отчёт')
  await drain(['research'], 'сборка')
  const products = await query(
    "SELECT id FROM products WHERE status='sandbox' AND visibility='public' ORDER BY published_at",
  )
  console.log(`Цикл ${cycle}: поиск клиентов по ${products.length} продуктам`)
  for (const product of products)
    await enqueue('lead', `lead-demo:${day}:${product.id}:${cycle}:${randomUUID().slice(0, 8)}`, {
      productId: product.id,
    })
  await drain(['lead'], 'клиенты')
}

console.log(`Отбор агентов при пороге ${minIdeas} идей`)
await query('UPDATE system_state SET evolution_min_ideas=$1', [minIdeas])
try {
  await requestEvolution()
  await drain(['evolve'], 'отбор')
} finally {
  await query('UPDATE system_state SET evolution_min_ideas=$1', [state.evolution_min_ideas])
}
const [round] = await query(
  'SELECT decision,reason,generation FROM evolution_rounds ORDER BY created_at DESC LIMIT 1',
)
const [summary] = await query(
  `SELECT (SELECT count(*)::int FROM ideas) AS ideas,
     (SELECT count(*)::int FROM ideas WHERE status IN ('accepted','productized')) AS accepted,
     (SELECT count(*)::int FROM ideas WHERE status='needs_human') AS needs_human,
     (SELECT count(*)::int FROM products WHERE status='sandbox' AND visibility='public') AS public_products,
     (SELECT count(*)::int FROM opportunities) AS leads,
     (SELECT count(*)::int FROM opportunities WHERE reply_draft IS NOT NULL) AS drafts,
     (SELECT count(*)::int FROM manager_reports) AS reports,
     (SELECT count(*)::int FROM strategies WHERE status='archived') AS archived`,
)
console.log('Итог:', summary)
console.log(
  `Последний отбор: ${round ? `${round.decision}, поколение ${round.generation}. ${round.reason}` : 'нет'}`,
)
console.log(
  `Порог отбора возвращён: ${state.evolution_min_ideas}. Время: ${Math.round((Date.now() - started) / 1000)} с.`,
)
console.log('Лента:')
for (const item of (await activityFeed(12)).reverse()) console.log(`  ${item.text}`)
await pool.end()
