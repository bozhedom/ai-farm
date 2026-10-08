import { config } from '../core/config'
import { audit, pool, query } from '../core/db'
import { recoverJobs, expireResearchSlots, type Job } from '../core/queue'
import { claimWorkerJob, executeWorkerJob } from '../core/worker-runtime'
import { reconcilePayments } from '../core/payments'
import { localProviderReadiness } from '../core/providers/readiness'
import { scheduleWork } from '../core/autonomy'
import { setTimeout as pause } from 'node:timers/promises'

let stopping = false
let farmBusy = false
let ordersBusy = false
let paymentsBusy = false
let unavailableProviders = ''
const running = new Set<Promise<void>>()
const shutdown = new AbortController()
const signal = () => {
  stopping = true
  shutdown.abort()
}
process.on('SIGTERM', signal)
process.on('SIGINT', signal)

const isStopping = () => stopping
function launch(job: Job, lane: 'orders' | 'farm') {
  if (lane === 'orders') ordersBusy = true
  else farmBusy = true
  const promise = executeWorkerJob(job, {
    isStopping,
    onHeartbeatError: () => {
      signal()
      process.exitCode = 1
      console.error('WORKER_HEARTBEAT_FAILED')
    },
  })
    .catch(async () => {
      signal()
      process.exitCode = 1
      console.error('WORKER_JOB_PERSISTENCE_FAILURE')
    })
    .finally(() => {
      running.delete(promise)
      if (lane === 'orders') ordersBusy = false
      else farmBusy = false
    })
  running.add(promise)
}

await audit(
  'worker_started',
  config().AUTONOMY_ENABLED
    ? 'Worker запущен. Расписание фермы и обработка заказов включены.'
    : 'Worker запущен. Расписание выключено; выполняются ручные задания и принятые заказы.',
)
while (!stopping) {
  try {
    await recoverJobs()
    if (stopping) break
    await expireResearchSlots(new Date().toISOString().slice(0, 10))
    if (stopping) break
    if (!paymentsBusy) {
      paymentsBusy = true
      const paymentTask = reconcilePayments()
        .catch(() => {
          console.error('PAYMENT_RECONCILIATION_FAILED')
        })
        .finally(() => {
          paymentsBusy = false
          running.delete(paymentTask)
        })
      running.add(paymentTask)
    }
    await scheduleWork()
    if (stopping) break
    const ready = await localProviderReadiness()
    if (stopping) break
    const unavailable = [!ready.model && 'модель', !ready.search && 'поиск']
      .filter(Boolean)
      .join(', ')
    if (unavailable !== unavailableProviders) {
      await audit(
        'provider_readiness',
        unavailable
          ? `Ожидаем локальные службы: ${unavailable}. Задания остаются в очереди, попытки не расходуются.`
          : 'Локальные службы готовы. Обработка очереди возобновлена.',
      )
      unavailableProviders = unavailable
    }
    if (!ordersBusy && ready.model) {
      const job = await claimWorkerJob(['fulfill'], isStopping)
      if (job) launch(job, 'orders')
    }
    if (!farmBusy) {
      // Three lanes: orders, farm and payment reconciliation. The farm lane runs one job at a
      // time. Financial HOLD, window expiry and the quality selection need neither a model nor
      // search; reports, research, scouting and leads wait for both.
      const job =
        (await claimWorkerJob(['evaluate', 'evolve'], isStopping)) ||
        (ready.model && ready.search
          ? await claimWorkerJob(['report', 'research', 'scout', 'lead'], isStopping)
          : undefined)
      if (job) launch(job, 'farm')
    }
    if (stopping) break
    await query(
      'UPDATE system_state SET worker_heartbeat=now(),provider_readiness=$1 WHERE id=true',
      [{ ...ready, checkedAt: new Date().toISOString() }],
    )
  } catch {
    // Never log provider URLs, request bodies or secrets.
    console.error('WORKER_TICK_FAILED')
  }
  await pause(config().POLL_INTERVAL_MS, undefined, { signal: shutdown.signal }).catch(() => {})
}
await Promise.all(running)
await pool.end()
