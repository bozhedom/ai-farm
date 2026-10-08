import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as database from '../../core/db'
import * as budget from '../../core/budget'
import { simulateEvolution } from '../../core/evolution'
import { runJob } from '../../core/jobs/run'
import { createOrder } from '../../core/orders'
import {
  reconcilePayments,
  sandboxPayment,
  submitTransaction,
  type Invoice,
} from '../../core/payments'
import { claimJob, enqueue, finishJob, recoverJobs } from '../../core/queue'
import { paymentHash, paymentReceiver, paymentRpc } from '../fixtures/sepolia'

const { pool, query } = database
const input = 'Керамическая кружка 350 мл. Белая глазурь, ручная работа. Мыть вручную.'

beforeAll(async () => {
  const [db] = await query('SELECT current_database() AS name')
  if (!db?.name.endsWith('_test')) throw new Error('REFUSING_NON_TEST_DATABASE')
  for (const file of readdirSync('db')
    .filter((name) => name.endsWith('.sql'))
    .sort())
    await query(readFileSync(`db/${file}`, 'utf8'))
})
beforeEach(async () => {
  await query(
    'TRUNCATE sessions,login_attempts,audit_events,evaluations,orders,tool_calls,budget_reservations,products,hypotheses,jobs,strategies,system_state RESTART IDENTITY CASCADE',
  )
  await query('INSERT INTO system_state(id) VALUES(true)')
  for (const name of ['Альфа', 'Бета', 'Гамма', 'Дельта'])
    await query('INSERT INTO strategies(id,name,approach,generation) VALUES($1,$2,$3,1)', [
      randomUUID(),
      name,
      'Только проверенные факты и ясная структура.',
    ])
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await pool.end()
})

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function order(mode: 'sandbox' | 'sepolia' = 'sandbox') {
  await enqueue('research', 'obligation-fixture', { templates: JSON.stringify(['description']) })
  const job = (await claimJob(['research']))!
  await runJob(job)
  await finishJob(job)
  const [product] = await query('SELECT id FROM products')
  const created = await createOrder(product!.id, input, randomUUID())
  if (mode === 'sepolia') {
    await query("UPDATE orders SET payment_mode='sepolia',receiver=$2 WHERE id=$1", [
      created.id,
      paymentReceiver,
    ])
    await submitTransaction(created.id, paymentHash)
  }
  const [invoice] = await query('SELECT * FROM orders WHERE id=$1', [created.id])
  // A nonzero, locally simulated earlier expense makes conservation observable.
  await query('UPDATE budget_reservations SET limit_kopecks=1000 WHERE id=$1', [
    invoice!.reservation_id,
  ])
  await budget.meteredCall({
    key: `obligation-cost:${created.id}`,
    reservationId: invoice!.reservation_id,
    role: 'integration fixture',
    maximum: 200,
    demo: true,
    invoke: async () => ({ value: 'fixture', cost: 125 }),
  })
  return invoice!
}

async function snapshots(id: string) {
  return (
    await query(
      'SELECT product_snapshot,strategy_snapshot,strategy_id,generation,input FROM orders WHERE id=$1',
      [id],
    )
  )[0]
}

function pauseAfterQuery(match: (sql: string) => boolean) {
  const started = gate(),
    released = gate()
  const original = database.query
  let paused = false
  vi.spyOn(database, 'query').mockImplementation((async (...args) => {
    const result = await original(...args)
    if (!paused && match(args[0])) {
      paused = true
      started.release()
      await released.promise
    }
    return result
  }) as typeof database.query)
  return { started: started.promise, release: released.release }
}

async function expectStateLockWaiter() {
  await vi.waitFor(
    async () => {
      const [locks] = await query(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
       AND query ~ '^SELECT .* FROM system_state WHERE id=true FOR UPDATE$'`,
      )
      expect(locks!.waiting).toBeGreaterThan(0)
    },
    { interval: 10, timeout: 2000 },
  )
}

it.each(['expired', 'requeued', 'reclaimed'])(
  'retains late fulfillment output and expenses without delivering with a %s lease',
  async (outcome) => {
    const invoice = await order()
    await sandboxPayment(invoice.id)
    const originalSnapshots = await snapshots(invoice.id)
    const originalBudget = await budget.budgetSummary()
    const job = (await claimJob(['fulfill']))!
    const started = gate(),
      released = gate()
    const original = budget.meteredCall
    const qaInvoke = vi.fn()
    vi.spyOn(budget, 'meteredCall').mockImplementation(async (args: any) => {
      if (!args.key.endsWith(':verify')) return original(args)
      return original({
        ...args,
        invoke: async () => {
          qaInvoke()
          started.release()
          await released.promise
          return args.invoke()
        },
      })
    })
    const pending = runJob(job).then(
      () => null,
      (error: Error) => error,
    )
    let replacement: Awaited<ReturnType<typeof claimJob>>
    try {
      await started.promise
      await query("UPDATE jobs SET locked_until=now()-interval '1 minute' WHERE id=$1", [job.id])
      if (outcome !== 'expired') await recoverJobs()
      if (outcome === 'reclaimed') {
        replacement = (await claimJob(['fulfill']))!
        expect(replacement.id).toBe(job.id)
        expect(replacement.lease_token).not.toBe(job.lease_token)
      }
    } finally {
      released.release()
    }
    expect(await pending).toMatchObject({ message: 'LEASE_LOST' })
    expect(
      (
        await query('SELECT status,result,review,delivered_at FROM orders WHERE id=$1', [
          invoice.id,
        ])
      )[0],
    ).toEqual({ status: 'running', result: null, review: null, delivered_at: null })
    expect(
      (
        await query('SELECT status,spent_kopecks FROM budget_reservations WHERE id=$1', [
          invoice.reservation_id,
        ])
      )[0],
    ).toEqual({ status: 'open', spent_kopecks: 125 })
    expect(await budget.budgetSummary()).toEqual(originalBudget)
    expect(await snapshots(invoice.id)).toEqual(originalSnapshots)
    expect(await query("SELECT id FROM audit_events WHERE kind='order_delivered'")).toHaveLength(0)
    expect(
      (
        await query('SELECT status,output FROM tool_calls WHERE call_key=$1', [`${job.id}:verify`])
      )[0],
    ).toMatchObject({ status: 'done', output: { verdict: 'PASS' } })

    // Recovery reuses the completed calls; the obsolete completion cannot finish a new lease.
    if (!replacement) {
      await recoverJobs()
      replacement = (await claimJob(['fulfill']))!
    }
    await finishJob(job, new Error('LEASE_LOST'))
    expect((await query('SELECT status,lease_token FROM jobs WHERE id=$1', [job.id]))[0]).toEqual({
      status: 'running',
      lease_token: replacement.lease_token,
    })
    await runJob(replacement)
    await finishJob(replacement)
    expect(qaInvoke).toHaveBeenCalledOnce()
    expect((await query('SELECT status FROM orders WHERE id=$1', [invoice.id]))[0]!.status).toBe(
      'delivered',
    )
    expect(await query("SELECT id FROM audit_events WHERE kind='order_delivered'")).toHaveLength(1)
    expect(await query('SELECT id FROM tool_calls WHERE job_id=$1', [job.id])).toHaveLength(2)
    expect(
      (
        await query('SELECT status,spent_kopecks FROM budget_reservations WHERE id=$1', [
          invoice.reservation_id,
        ])
      )[0],
    ).toEqual({ status: 'closed', spent_kopecks: 125 })
    expect((await budget.budgetSummary()).daySpent).toBe(125)
    expect(await snapshots(invoice.id)).toEqual(originalSnapshots)
  },
)

it.each(['sandbox', 'sepolia'] as const)(
  'serializes %s confirmation after a generation change has checked its obligations',
  async (mode) => {
    const invoice = await order(mode)
    const originalSnapshots = await snapshots(invoice.id)
    const originalBudget = await budget.budgetSummary()
    const paused = pauseAfterQuery((sql) =>
      sql.startsWith("SELECT * FROM strategies WHERE status='active'"),
    )
    const rotating = simulateEvolution(1)
    let paying: Promise<unknown> | undefined
    try {
      await paused.started
      paying =
        mode === 'sandbox'
          ? sandboxPayment(invoice.id)
          : reconcilePayments(paymentRpc({}, invoice as Invoice))
      await expectStateLockWaiter()
      expect((await query('SELECT status FROM orders WHERE id=$1', [invoice.id]))[0]!.status).toBe(
        'awaiting_payment',
      )
      expect(await query("SELECT id FROM strategies WHERE status='archived'")).toHaveLength(0)
    } finally {
      paused.release()
      await Promise.all([rotating, paying])
    }
    expect((await query('SELECT status FROM orders WHERE id=$1', [invoice.id]))[0]!.status).toBe(
      'paid',
    )
    expect((await query('SELECT generation FROM system_state'))[0]!.generation).toBe(2)
    expect(await query("SELECT id FROM strategies WHERE status='active'")).toHaveLength(4)
    expect(await snapshots(invoice.id)).toEqual(originalSnapshots)
    expect(await budget.budgetSummary()).toEqual(originalBudget)
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(1)
    await expect(simulateEvolution(2)).rejects.toThrow('OPEN_OBLIGATIONS')
    if (mode === 'sepolia') {
      expect(
        (
          await query('SELECT tx_hash,confirmations,payment_proof FROM orders WHERE id=$1', [
            invoice.id,
          ])
        )[0],
      ).toMatchObject({
        tx_hash: paymentHash,
        confirmations: 3,
        payment_proof: { hash: paymentHash, chainId: 11155111 },
      })
      expect(
        await query(
          'SELECT tx_hash FROM payment_attempts WHERE order_id=$1 AND confirmed_at IS NOT NULL',
          [invoice.id],
        ),
      ).toEqual([{ tx_hash: paymentHash }])
    }
  },
)

it.each(['sandbox', 'sepolia'] as const)(
  'prevents generation rotation after a concurrent %s confirmation wins the lock',
  async (mode) => {
    const invoice = await order(mode)
    const originalSnapshots = await snapshots(invoice.id)
    const originalBudget = await budget.budgetSummary()
    const paused = pauseAfterQuery((sql) => sql.startsWith("UPDATE orders SET status='paid'"))
    const paying =
      mode === 'sandbox'
        ? sandboxPayment(invoice.id)
        : reconcilePayments(paymentRpc({}, invoice as Invoice))
    let rotating: Promise<unknown> | undefined
    try {
      await paused.started
      rotating = simulateEvolution(1).then(
        () => null,
        (error: Error) => error,
      )
      await expectStateLockWaiter()
    } finally {
      paused.release()
      await paying
    }
    expect(await rotating).toMatchObject({ message: 'OPEN_OBLIGATIONS' })
    expect((await query('SELECT generation FROM system_state'))[0]!.generation).toBe(1)
    expect(await query("SELECT id FROM strategies WHERE status='active'")).toHaveLength(4)
    expect(await query("SELECT id FROM strategies WHERE status='archived'")).toHaveLength(0)
    expect(await query('SELECT id FROM evaluations')).toHaveLength(0)
    expect(await snapshots(invoice.id)).toEqual(originalSnapshots)
    expect(await budget.budgetSummary()).toEqual(originalBudget)
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(1)
  },
)
