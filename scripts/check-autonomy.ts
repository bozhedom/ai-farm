import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { qualityCases } from './fixtures/quality'

// This acceptance run owns an EMPTY, explicitly selected local test database.
// It never truncates a database, uses production credentials for APIs, or contacts a model.
const database = process.env.AUTONOMY_DATABASE_URL
if (!database) throw new Error('AUTONOMY_DATABASE_URL_REQUIRED')
const target = new URL(database)
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.search ||
  target.hash ||
  !target.pathname.endsWith('_test') ||
  !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
)
  throw new Error('LOCAL_AUTONOMY_DATABASE_MUST_END_IN_TEST')
const preflight = new Pool({ connectionString: database, connectionTimeoutMillis: 5000 })
try {
  const actual = await preflight.query('SELECT current_database() AS name')
  assert.equal(actual.rows[0]?.name, decodeURIComponent(target.pathname.slice(1)))
  assert.ok(actual.rows[0]?.name.endsWith('_test'))
  const { rows } = await preflight.query(
    "SELECT tablename FROM pg_tables WHERE schemaname NOT LIKE 'pg_%' AND schemaname<>'information_schema'",
  )
  if (rows.length) throw new Error('AUTONOMY_DATABASE_MUST_BE_EMPTY')
} finally {
  await preflight.end()
}
Object.assign(process.env, {
  DATABASE_URL: database,
  MODEL_PROVIDER: 'demo',
  SEARCH_PROVIDER: 'demo',
  PAYMENT_MODE: 'sandbox',
  AUTONOMY_ENABLED: 'true',
  POLL_INTERVAL_MS: '250',
  APP_ORIGIN: 'http://localhost:3210',
  SECURE_COOKIE: 'false',
  OWNER_PASSWORD: randomUUID(),
  SESSION_SECRET: randomUUID() + randomUUID(),
  OPENAI_API_KEY: '',
  OPENROUTER_API_KEY: '',
  YANDEX_API_KEY: '',
  YANDEX_FOLDER_ID: '',
  SEPOLIA_RPC_URL: '',
  SEPOLIA_RECEIVER: '',
})

type Process = {
  child: ChildProcess
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  exited: boolean
}
const children: Process[] = []
function start(file: string, env: NodeJS.ProcessEnv = {}): Process {
  const child = spawn(process.execPath, ['--import', 'tsx', file], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const processState: Process = {
    child,
    exited: false,
    completion: new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        processState.exited = true
        resolve({ code, signal })
      })
    }),
  }
  children.push(processState)
  return processState
}
async function waitFor<T>(
  label: string,
  check: () => Promise<T>,
  timeout = 30000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(150)
  }
  throw new Error(`AUTONOMY_TIMEOUT_${label}`)
}
async function stop(worker: Process, signal: NodeJS.Signals = 'SIGTERM') {
  if (!worker.exited) worker.child.kill(signal)
  await waitFor('WORKER_EXIT', async () => worker.exited, 30000)
  const result = await worker.completion
  if (signal === 'SIGTERM') assert.equal(result.code, 0, 'Worker must drain without an error')
  else assert.equal(result.signal, signal)
}
function gate() {
  let release!: () => void
  return { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() }
}

const run = randomUUID()
const results: Record<string, unknown>[] = []
function passed(scenario: string, evidence: Record<string, unknown>) {
  results.push({ scenario, ...evidence })
  console.log(`PASS ${scenario}`)
}
const migration = start('scripts/migrate.ts')
assert.equal((await migration.completion).code, 0, 'Test database migration failed')
const { pool, query } = await import('../core/db')
const { createOrder } = await import('../core/orders')
const { sandboxPayment } = await import('../core/payments')
const { demoResult } = await import('../core/providers/demo')

// An HTTP fixture exercises the real Ollama adapter, persistence, queue and OS signals.
// Its replies remain explicitly synthetic: this is NOT a model quality evaluation.
let available = true
let heldRequest: { arrived: ReturnType<typeof gate>; response: ReturnType<typeof gate> } | null =
  null
const requests: { input: string; role: 'generate' | 'review' }[] = []
const fixture = createServer(async (req, res) => {
  try {
    if (req.url === '/api/tags') {
      res.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'autonomy-fixture:latest' }] }))
      return
    }
    if (req.url === '/healthz') {
      res.end('ok')
      return
    }
    if (req.url !== '/api/chat' || req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk.toString()
    const body = JSON.parse(raw)
    const context = JSON.parse(
      body.messages.find((m: { role: string }) => m.role === 'user').content,
    )
    const role = Object.hasOwn(context, 'output') ? 'review' : 'generate'
    requests.push({ input: context.input, role })
    if (role === 'generate' && heldRequest) {
      const current = heldRequest
      heldRequest = null
      current.arrived.release()
      await current.response.promise
    }
    const answer =
      role === 'review'
        ? {
            verdict: 'PASS',
            reason: 'Синтетическая проверка восстановления очереди, не оценка качества модели.',
          }
        : { text: demoResult('description', context.input) }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.end(
      JSON.stringify({
        message: { content: JSON.stringify(answer) },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 100,
        eval_count: 100,
      }) + '\n',
    )
  } catch {
    res.writeHead(500).end()
  }
})
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const address = fixture.address()
assert.ok(address && typeof address !== 'string')
const endpoint = `http://127.0.0.1:${address.port}`
const fixtureEnvironment = {
  MODEL_PROVIDER: 'ollama',
  SEARCH_PROVIDER: 'searxng',
  OLLAMA_URL: endpoint,
  SEARXNG_URL: endpoint,
  OLLAMA_MODEL: 'autonomy-fixture:latest',
  OLLAMA_TIMEOUT_MS: '30000',
  AUTONOMY_ENABLED: 'false',
}
async function orderState(id: string) {
  const [row] = await query(
    `SELECT o.status,o.result,o.reservation_id,r.status AS reservation_status,
       j.id AS job_id,j.status AS job_status,j.attempts,j.error_code
     FROM orders o JOIN jobs j ON j.dedupe_key='fulfill:'||o.id
     JOIN budget_reservations r ON r.id=o.reservation_id WHERE o.id=$1`,
    [id],
  )
  return row!
}
async function fixtureOrder(label: string) {
  await query("UPDATE system_state SET mode='running',schedule_enabled=false WHERE id=true")
  const [product] = await query("SELECT id FROM products WHERE template='description'")
  const input = `${qualityCases[0]!.input} Проверка: ${label}.`
  const order = await createOrder(product!.id, input, randomUUID())
  await sandboxPayment(order.id)
  await query("UPDATE system_state SET mode='paused' WHERE id=true")
  return { ...order, input }
}
async function delivered(id: string) {
  return waitFor('DELIVERY', async () => {
    const state = await orderState(id)
    return state.status === 'delivered' && state.job_status === 'done' ? state : null
  })
}
async function assertSingleDelivery(id: string) {
  const [count] = await query(
    "SELECT count(*)::int AS n FROM audit_events WHERE kind='order_delivered' AND data->>'orderId'=$1",
    [id],
  )
  assert.equal(count!.n, 1)
}

try {
  await query(
    // The portfolio scenario measures research alone; the farm day is checked separately below.
    `UPDATE system_state SET mode='running',research_enabled=true,schedule_enabled=true,research_scope='all',
     scouts_per_strategy_per_day=0,leads_per_day=0 WHERE id=true`,
  )
  const workers = [start('worker/index.ts'), start('worker/index.ts')]
  await waitFor(
    'PORTFOLIO',
    async () => {
      const [counts] = await query(
        "SELECT count(*) FILTER(WHERE kind='research' AND status='done')::int AS research,count(*) FILTER(WHERE kind='evaluate' AND status='done')::int AS evaluated FROM jobs",
      )
      return counts!.research === 12 && counts!.evaluated === 1
    },
    60000,
  )
  assert.ok(workers.every((worker) => !worker.exited))
  await Promise.all(workers.map((worker) => stop(worker)))
  const products = await query('SELECT id,template FROM products')
  assert.equal(products.length, 12)
  assert.equal(new Set(products.map((p) => p.template)).size, 12)
  const [portfolio] = await query(
    `SELECT (SELECT count(*)::int FROM jobs) AS jobs,
       (SELECT count(*)::int FROM opportunities WHERE is_demo) AS sources,
       (SELECT count(*)::int FROM evaluations WHERE decision='HOLD') AS holds`,
  )
  assert.equal(portfolio!.jobs, 13)
  assert.equal(portfolio!.sources, 24)
  assert.equal(portfolio!.holds, 1)
  passed('scheduled_portfolio_two_workers', {
    products: 12,
    researchJobs: 12,
    sources: 24,
    evaluations: 1,
  })

  // Farm day with two real workers: scouting, report, idea research with publication, leads.
  await query('UPDATE system_state SET scouts_per_strategy_per_day=1,leads_per_day=2 WHERE id=true')
  const farmWorkers = [start('worker/index.ts'), start('worker/index.ts')]
  await waitFor(
    'FARM_DAY',
    async () => {
      const [farm] = await query(
        `SELECT (SELECT count(*)::int FROM manager_reports WHERE kind='daily') AS reports,
          (SELECT count(*)::int FROM jobs WHERE kind='lead' AND status='done') AS leads,
          (SELECT count(*)::int FROM jobs WHERE kind IN ('scout','report','research','lead','evolve')
             AND status IN ('queued','running')) AS open`,
      )
      return farm!.reports === 1 && farm!.leads > 0 && farm!.open === 0
    },
    60000,
  )
  await Promise.all(farmWorkers.map((worker) => stop(worker)))
  const [day] = await query(
    `SELECT (SELECT count(*)::int FROM ideas) AS ideas,
       (SELECT count(DISTINCT topic_id)::int FROM ideas) AS topics,
       (SELECT count(*)::int FROM jobs WHERE kind='scout') AS scouts,
       (SELECT count(*)::int FROM jobs WHERE kind='scout' AND status='failed') AS failed_scouts,
       (SELECT count(*)::int FROM products WHERE visibility='public' AND idea_id IS NOT NULL) AS public_products,
       (SELECT count(*)::int FROM opportunities WHERE product_id IS NOT NULL) AS leads,
       (SELECT count(*)::int FROM opportunities WHERE reply_draft IS NOT NULL) AS drafts`,
  )
  assert.equal(day!.scouts, 4)
  assert.equal(day!.failed_scouts, 0)
  assert.equal(day!.ideas, 4)
  assert.equal(day!.topics, 4)
  assert.ok(day!.public_products >= 1)
  assert.ok(day!.leads >= 1)
  assert.ok(day!.drafts >= 1)
  await query('UPDATE system_state SET scouts_per_strategy_per_day=0,leads_per_day=0 WHERE id=true')
  passed('farm_day_two_workers', day!)

  await query('UPDATE system_state SET schedule_enabled=false WHERE id=true')
  const orders: string[] = []
  for (const item of qualityCases) {
    const product = products.find((p) => p.template === item.template)!
    const order = await createOrder(product.id, item.input, randomUUID())
    await sandboxPayment(order.id)
    await sandboxPayment(order.id)
    orders.push(order.id)
  }
  await query("UPDATE system_state SET mode='paused' WHERE id=true")
  const pausedWorker = start('worker/index.ts')
  for (const id of orders) {
    const result = await delivered(id)
    assert.equal(result.reservation_status, 'closed')
    assert.equal(result.attempts, 1)
    assert.match(result.result, /^Демонстрация: /)
    await assertSingleDelivery(id)
  }
  await stop(pausedWorker)
  passed('paid_orders_continue_during_research_pause', {
    delivered: 12,
    duplicatePaymentsPerOrder: 2,
  })

  const graceful = await fixtureOrder('graceful')
  const gracefulGate = { arrived: gate(), response: gate() }
  heldRequest = gracefulGate
  const draining = start('worker/index.ts', fixtureEnvironment)
  await waitFor('REQUEST_STARTED', async () => requests.some((r) => r.input === graceful.input))
  draining.child.kill('SIGTERM')
  await delay(350)
  assert.equal(draining.exited, false, 'SIGTERM must allow the current call to be persisted')
  gracefulGate.response.release()
  await stop(draining)
  const drained = await orderState(graceful.id)
  assert.equal(drained.job_status, 'queued')
  assert.equal(drained.error_code, 'WORKER_DRAINING')
  assert.equal(drained.reservation_status, 'open')
  assert.equal(requests.filter((r) => r.input === graceful.input).length, 1)
  const resumed = start('worker/index.ts', fixtureEnvironment)
  await delivered(graceful.id)
  await stop(resumed)
  await assertSingleDelivery(graceful.id)
  assert.deepEqual(
    requests.filter((r) => r.input === graceful.input).map((r) => r.role),
    ['generate', 'review'],
  )
  passed('sigterm_persists_call_and_resumes_without_repeat', {
    generationRequests: 1,
    reviewRequests: 1,
    deliveries: 1,
  })

  const outage = await fixtureOrder('provider-outage')
  available = false
  const waiting = start('worker/index.ts', fixtureEnvironment)
  await waitFor('MODEL_DOWN', async () => {
    const [state] = await query('SELECT provider_readiness FROM system_state WHERE id=true')
    return state!.provider_readiness?.model === false
  })
  const unclaimed = await orderState(outage.id)
  assert.equal(unclaimed.job_status, 'queued')
  assert.equal(unclaimed.attempts, 0)
  assert.equal(requests.filter((r) => r.input === outage.input).length, 0)
  available = true
  await delivered(outage.id)
  await stop(waiting)
  await assertSingleDelivery(outage.id)
  passed('provider_outage_recovers_automatically', {
    attemptsDuringOutage: 0,
    deliveriesAfterRecovery: 1,
  })

  const crashed = await fixtureOrder('sigkill')
  const crashGate = { arrived: gate(), response: gate() }
  heldRequest = crashGate
  const doomed = start('worker/index.ts', fixtureEnvironment)
  await waitFor('CRASH_REQUEST_STARTED', async () =>
    requests.some((r) => r.input === crashed.input),
  )
  await stop(doomed, 'SIGKILL')
  crashGate.response.release()
  const recovered = start('worker/index.ts', fixtureEnvironment)
  const healthy = await fixtureOrder('after-crash')
  await delivered(healthy.id)
  console.log('Waiting for the real two-minute lease to expire after SIGKILL…')
  // A free local model costs nothing, so the call lost with the killed worker is retried once
  // after its lease expires. Paid providers keep UNCERTAIN_CALL_REQUIRES_REVIEW (integration tests).
  const recovery = await waitFor(
    'CRASH_RECOVERY',
    async () => {
      const state = await orderState(crashed.id)
      return state.status === 'delivered' && state.job_status === 'done' ? state : null
    },
    200000,
  )
  assert.equal(recovery.attempts, 2)
  assert.equal(recovery.reservation_status, 'closed')
  assert.equal(requests.filter((r) => r.input === crashed.input && r.role === 'generate').length, 2)
  const [retried] = await query(
    "SELECT count(*)::int AS n FROM audit_events WHERE kind='tool_call_retried'",
  )
  assert.ok(retried!.n >= 1)
  await stop(recovered)
  await assertSingleDelivery(crashed.id)
  await assertSingleDelivery(healthy.id)
  passed('sigkill_retries_free_call_once_and_other_orders_continue', {
    retriedFreeCalls: retried!.n,
    crashedOrderDeliveries: 1,
    independentOrderDelivered: true,
  })

  const [totals] = await query(
    `SELECT (SELECT count(*)::int FROM orders WHERE status='delivered') AS delivered,
       (SELECT count(*)::int FROM orders WHERE status='manual_review') AS review,
       (SELECT coalesce(sum(charged_kopecks),0)::int FROM tool_calls) AS charged,
       (SELECT count(*)::int FROM budget_reservations WHERE status='open') AS open_reservations,
       (SELECT count(*)::int FROM jobs WHERE status IN ('queued','running')) AS unfinished_jobs`,
  )
  assert.equal(totals!.delivered, 16)
  assert.equal(totals!.review, 0)
  assert.equal(totals!.charged, 0)
  assert.equal(totals!.open_reservations, 0)
  assert.equal(totals!.unfinished_jobs, 0)
  passed('final_accounting_and_queue', totals!)
} finally {
  if (heldRequest) heldRequest.response.release()
  for (const worker of children) {
    if (!worker.exited) {
      worker.child.kill('SIGKILL')
      await worker.completion
    }
  }
  fixture.closeAllConnections()
  await new Promise<void>((resolve) => fixture.close(() => resolve()))
  await pool.end()
  mkdirSync('output/autonomy', { recursive: true })
  const path = `output/autonomy/${run}.json`
  writeFileSync(
    path,
    JSON.stringify(
      {
        run,
        checkedAt: new Date().toISOString(),
        complete: results.length === 7,
        note: 'Real worker processes and database; synthetic demo and localhost HTTP fixtures, sandbox payments. No real model quality, sales, cloud availability or 48-hour uptime claim.',
        results,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  console.log(`Report: ${path}`)
}
