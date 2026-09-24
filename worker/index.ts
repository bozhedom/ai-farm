import { config } from '../core/config'
import { audit, pool, query } from '../core/db'
import { claimJob, enqueue, finishJob, heartbeatJob, recoverJobs, type Job } from '../core/queue'
import { runJob } from '../core/engine'
import { reconcilePayments } from '../core/payments'

let stopping = false
let researchBusy = false
let ordersBusy = false
let paymentsBusy = false
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

await audit('worker_started', 'Worker запущен. Расписание и обработка заказов включены.')
while (!stopping) {
  try {
    await query('UPDATE system_state SET worker_heartbeat=now() WHERE id=true')
    await recoverJobs()
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
    if (config().AUTONOMY_ENABLED) {
      const day = new Date().toISOString().slice(0, 10)
      const week = Math.floor(Date.now() / (7 * 86400000))
      await enqueue('research', `research:${day}`)
      await enqueue('evaluate', `evaluate:${week}`)
    }
    if (!ordersBusy) {
      const job = await claimJob(['fulfill'])
      if (job) launch(job, 'orders')
    }
    if (!researchBusy) {
      const job = await claimJob(['research', 'evaluate'])
      if (job) launch(job, 'research')
    }
  } catch {
    // Never log provider URLs, request bodies or secrets.
    console.error('WORKER_TICK_FAILED')
  }
  await new Promise((resolve) => setTimeout(resolve, config().POLL_INTERVAL_MS))
}
await Promise.all(running)
await pool.end()
