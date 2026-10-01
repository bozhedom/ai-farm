import { config } from '../core/config'
import { audit, pool, query } from '../core/db'
import {
  claimJob,
  finishJob,
  heartbeatJob,
  recoverJobs,
  expireResearchSlots,
  type Job,
} from '../core/queue'
import { runJob } from '../core/jobs/run'
import { reconcilePayments } from '../core/payments'
import { localProviderReadiness } from '../core/providers/readiness'
import { scheduleWork } from '../core/autonomy'

let stopping = false
let researchBusy = false
let ordersBusy = false
let paymentsBusy = false
let unavailableProviders = ''
const running = new Set<Promise<void>>()
const signal = () => {
  stopping = true
}
process.on('SIGTERM', signal)
process.on('SIGINT', signal)

async function execute(job: Job) {
  const timer = setInterval(() => {
    void heartbeatJob(job).catch(() => {
      stopping = true
    })
  }, 10000)
  try {
    await runJob(job)
    await finishJob(job)
  } catch (error) {
    await finishJob(job, error)
  } finally {
    clearInterval(timer)
  }
}
function launch(job: Job, lane: 'orders' | 'research') {
  if (lane === 'orders') ordersBusy = true
  else researchBusy = true
  const promise = execute(job)
    .catch(async () => {
      stopping = true
      console.error('WORKER_JOB_PERSISTENCE_FAILURE')
    })
    .finally(() => {
      running.delete(promise)
      if (lane === 'orders') ordersBusy = false
      else researchBusy = false
    })
  running.add(promise)
}

await audit(
  'worker_started',
  config().AUTONOMY_ENABLED
    ? 'Worker запущен. Расписание и обработка заказов включены.'
    : 'Worker запущен. Расписание выключено; выполняются ручные задания и принятые заказы.',
)
while (!stopping) {
  try {
    await recoverJobs()
    await expireResearchSlots(new Date().toISOString().slice(0, 10))
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
    const ready = await localProviderReadiness()
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
      const job = await claimJob(['fulfill'])
      if (job) launch(job, 'orders')
    }
    if (!researchBusy) {
      // Financial HOLD/window expiry needs neither a model nor a working search provider.
      const job =
        (await claimJob(['evaluate'])) ||
        (ready.model && ready.search ? await claimJob(['research']) : undefined)
      if (job) launch(job, 'research')
    }
    await query(
      'UPDATE system_state SET worker_heartbeat=now(),provider_readiness=$1 WHERE id=true',
      [{ ...ready, checkedAt: new Date().toISOString() }],
    )
  } catch {
    // Never log provider URLs, request bodies or secrets.
    console.error('WORKER_TICK_FAILED')
  }
  await new Promise((resolve) => setTimeout(resolve, config().POLL_INTERVAL_MS))
}
await Promise.all(running)
await pool.end()
