import { config } from '../core/config'
import { audit, pool, query } from '../core/db'
import { recoverJobs, expireResearchSlots, type Job } from '../core/queue'
import { claimWorkerJob, executeWorkerJob } from '../core/worker-runtime'
import { reconcilePayments } from '../core/payments'
import { localProviderReadiness } from '../core/providers/readiness'
import { scheduleWork } from '../core/autonomy'
import { setTimeout as pause } from 'node:timers/promises'
import { tradingTick } from '../core/trading/engine'
import { exchanges } from '../core/trading/types'
import { earningsTick } from '../core/earnings/monitor'
import { managerTick } from '../core/manager/runtime'
import { executionTick } from '../core/execution/engine'
import { computerUseTick } from '../core/computer-use/runtime'
import { EXECUTION_POLICY } from '../core/policy'
import { createLoopRunner, loopSpecs } from '../core/worker-loops'
import { runAutopilot } from '../core/autopilot'

let stopping = false
let farmBusy = false
let ordersBusy = false
let lastExecutionAt = 0
let lastAutopilotAt = 0
let stuckExit = false
let tickStartedAt = Date.now()
let unavailableProviders = ''
const running = new Set<Promise<void>>()
const reportedStuck = new Set<string>()
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

const loops = createLoopRunner()
const step = loops.step
function background(name: string, fn: () => Promise<unknown>) {
  if (!stopping) loops.background(name, fn)
}

/**
 * A loop that never returns keeps its lock or lease. The worker reports it and exits, so the
 * container restart policy starts a clean process: locks are released and leases recover.
 */
const watchdog = setInterval(() => {
  const now = Date.now()
  const stuck = loops.stuck(now)
  if (now - tickStartedAt > loopSpecs.tick!.stuckMs) stuck.push('tick')
  for (const name of stuck) {
    if (reportedStuck.has(name)) continue
    reportedStuck.add(name)
    console.error(`WORKER_LOOP_STUCK ${name}`)
    void audit(
      'worker_loop_stuck',
      `Цикл «${loopSpecs[name]?.label ?? name}» не завершился вовремя.${config().WORKER_STUCK_RESTART ? ' Обработчик перезапускается.' : ''}`,
      { loop: name },
    ).catch(() => {})
  }
  if (stuck.length && config().WORKER_STUCK_RESTART && !stopping) {
    stuckExit = true
    process.exitCode = 1
    signal()
  }
}, 30_000)
watchdog.unref()

await audit(
  'worker_started',
  config().AUTONOMY_ENABLED
    ? 'Worker запущен. Расписание фермы и обработка заказов включены.'
    : 'Worker запущен. Расписание выключено; выполняются ручные задания и принятые заказы.',
)
while (!stopping) {
  tickStartedAt = Date.now()
  try {
    if (
      config().AUTOPILOT_ON_BOOT &&
      Date.now() - lastAutopilotAt >= config().AUTOPILOT_INTERVAL_MS
    ) {
      lastAutopilotAt = Date.now()
      background('autopilot', () => runAutopilot())
    }
    await step('recovery', async () => {
      await recoverJobs()
      if (stopping) return
      await expireResearchSlots(new Date().toISOString().slice(0, 10))
    })
    if (stopping) break
    background('payments', () => reconcilePayments())
    for (const exchange of exchanges)
      background(`trading:${exchange}`, () => tradingTick(undefined, isStopping, [exchange]))
    background('earnings', () => earningsTick())
    if (Date.now() - lastExecutionAt >= EXECUTION_POLICY.tickMs && !loops.busy.has('execution')) {
      lastExecutionAt = Date.now()
      background('execution', () => executionTick(undefined, isStopping))
    }
    if (config().WORKSPACE_MODE === 'studio') await step('schedule', () => scheduleWork())
    if (stopping) break
    const ready = (await step('providers', () => localProviderReadiness())) ?? {
      model: false,
      search: false,
    }
    if (stopping) break
    const unavailable = [!ready.model && 'модель', !ready.search && 'поиск']
      .filter(Boolean)
      .join(', ')
    if (unavailable !== unavailableProviders) {
      await step('tick', () =>
        audit(
          'provider_readiness',
          unavailable
            ? `Ожидаем локальные службы: ${unavailable}. Задания остаются в очереди, попытки не расходуются.`
            : 'Локальные службы готовы. Обработка очереди возобновлена.',
        ),
      )
      unavailableProviders = unavailable
    }
    await step('orders', async () => {
      if (ordersBusy || !ready.model) return
      const job = await claimWorkerJob(['fulfill'], isStopping)
      if (job) launch(job, 'orders')
    })
    background('manager', () => managerTick(undefined, isStopping, ready.model))
    // One browser task on the separate VM, screenshot by screenshot.
    if (config().COMPUTER_USE_ENABLED)
      background('computer', () => computerUseTick(undefined, isStopping))
    if (config().WORKSPACE_MODE === 'studio')
      await step('farm', async () => {
        if (farmBusy) return
        // Three lanes: orders, farm and payment reconciliation. The farm lane runs one job at a
        // time. Financial HOLD, window expiry and the quality selection need neither a model nor
        // search; reports, research, scouting and leads wait for both.
        const job =
          (await claimWorkerJob(['evaluate', 'evolve'], isStopping)) ||
          (ready.model && ready.search
            ? await claimWorkerJob(['report', 'research', 'scout', 'lead'], isStopping)
            : undefined)
        if (job) launch(job, 'farm')
      })
    if (stopping) break
    await step('tick', () =>
      query('UPDATE system_state SET worker_heartbeat=now(),provider_readiness=$1 WHERE id=true', [
        { ...ready, checkedAt: new Date().toISOString() },
      ]),
    )
  } catch {
    // Never log provider URLs, request bodies or secrets.
    console.error('WORKER_TICK_FAILED')
  }
  await pause(config().POLL_INTERVAL_MS, undefined, { signal: shutdown.signal }).catch(() => {})
}
clearInterval(watchdog)
// A stuck loop never settles: give the others a bounded grace period, then exit for a restart.
const settled = Promise.all([...running, ...loops.running])
await (stuckExit ? Promise.race([settled, pause(60_000)]) : settled)
await pool.end().catch(() => {})
if (stuckExit) process.exit(1)
