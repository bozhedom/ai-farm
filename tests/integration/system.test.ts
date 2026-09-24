import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import { budgetSummary, meteredCall, reserveBudget } from '../../core/budget'
import { claimJob, enqueue, finishJob, recoverJobs } from '../../core/queue'
import { runJob } from '../../core/engine'
import { createOrder } from '../../core/orders'
import {
  sandboxPayment,
  submitTransaction,
  confirmPayment,
  reconcilePayments,
} from '../../core/payments'
import { simulateEvolution, evaluateWeek } from '../../core/evolution'
import { attemptLogin, validSession, digest } from '../../core/auth'

const input = 'Керамическая кружка 350 мл. Белая глазурь, ручная работа. Мыть вручную.'
beforeAll(async () => {
  const [db] = await query('SELECT current_database() AS name')
  if (!db?.name.endsWith('_test')) throw new Error('REFUSING_NON_TEST_DATABASE')
  for (const file of readdirSync('db')
    .filter((x) => x.endsWith('.sql'))
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

async function research() {
  await enqueue('research', 'test-research')
  const job = (await claimJob(['research']))!
  await runJob(job)
  await finishJob(job)
  return await query('SELECT * FROM products ORDER BY created_at')
}
async function order() {
  const products = await research()
  return createOrder(products[0]!.id, input, randomUUID())
}

describe('durable autonomous pipeline', () => {
  it('researches, checks fixtures, creates two products and delivers once after a test payment', async () => {
    const products = await research()
    expect(products).toHaveLength(2)
    expect(
      products.every((p) => p.checks.normal === 'PASS' && p.checks.injection === 'BLOCKED'),
    ).toBe(true)
    const key = randomUUID(),
      created = await createOrder(products[0]!.id, input, key)
    expect(await createOrder(products[0]!.id, input, key)).toEqual(created)
    await expect(createOrder(products[0]!.id, input + ' Иное.', key)).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    )
    await Promise.all([sandboxPayment(created.id), sandboxPayment(created.id)])
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(1)
    const job = (await claimJob(['fulfill']))!
    await runJob(job)
    await finishJob(job)
    await runJob(job)
    const [saved] = await query('SELECT * FROM orders WHERE id=$1', [created.id])
    expect(saved!.status).toBe('delivered')
    expect(saved!.result).toContain('ДЕМОНСТРАЦИЯ')
    expect(await query("SELECT id FROM audit_events WHERE kind='order_delivered'")).toHaveLength(1)
    expect((await budgetSummary()).outstanding).toBe(0)
    await evaluateWeek('week-1')
    const [evaluation] = await query('SELECT * FROM evaluations')
    expect(evaluation!.decision).toBe('HOLD')
    expect(evaluation!.details.realRevenueKopecks).toBe(0)
  })
  it('does not queue delivery for an unpaid order', async () => {
    const o = await order()
    expect(await claimJob(['fulfill'])).toBeUndefined()
    await expect(
      runJob({
        id: randomUUID(),
        kind: 'fulfill',
        payload: { orderId: o.id },
        attempts: 1,
        max_attempts: 3,
        lease_token: randomUUID(),
      }),
    ).rejects.toThrow('ORDER_NOT_PAID')
  })
  it('archives half atomically and starts children with no inherited orders', async () => {
    await research()
    const results = await Promise.all([simulateEvolution(1), simulateEvolution(1)])
    expect(results[0]!.id).toBe(results[1]!.id)
    expect(await query("SELECT id FROM strategies WHERE status='active'")).toHaveLength(4)
    expect(await query("SELECT id FROM strategies WHERE status='archived'")).toHaveLength(2)
    expect(await query('SELECT id FROM strategies WHERE parent_id IS NOT NULL')).toHaveLength(2)
    expect(await query('SELECT id FROM orders')).toHaveLength(0)
    expect(await query('SELECT id FROM products')).toHaveLength(2)
  })
  it('does not rotate while an accepted obligation is unfinished', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    await expect(simulateEvolution(1)).rejects.toThrow('OPEN_OBLIGATIONS')
  })
  it('pauses new work but completes already confirmed orders', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    await query("UPDATE system_state SET mode='paused'")
    const [product] = await query('SELECT id FROM products LIMIT 1')
    await expect(createOrder(product!.id, input, randomUUID())).rejects.toThrow('NEW_ORDERS_PAUSED')
    await enqueue('research', 'another-research')
    expect(await claimJob(['research'])).toBeUndefined()
    const job = (await claimJob(['fulfill']))!
    await runJob(job)
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'delivered',
    )
  })
  it('emergency stop preserves payments and prevents execution', async () => {
    const o = await order()
    await query("UPDATE system_state SET mode='emergency_stop'")
    await sandboxPayment(o.id)
    expect(await claimJob(['fulfill'])).toBeUndefined()
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe('paid')
  })
  it('recovers an abandoned lease and bounds retries', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    const job = (await claimJob(['fulfill']))!
    await query("UPDATE jobs SET locked_until=now()-interval '1 minute' WHERE id=$1", [job.id])
    await recoverJobs()
    const retry = (await claimJob(['fulfill']))!
    expect(retry.id).toBe(job.id)
    expect(retry.attempts).toBe(2)
    await finishJob(job) // An obsolete worker cannot finish a new lease.
    expect((await query('SELECT status FROM jobs WHERE id=$1', [job.id]))[0]!.status).toBe(
      'running',
    )
    await query("UPDATE jobs SET attempts=3,locked_until=now()-interval '1 minute' WHERE id=$1", [
      job.id,
    ])
    await recoverJobs()
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'manual_review',
    )
    expect(await claimJob(['fulfill'])).toBeUndefined()
  })
  it('claims a queued task only once across concurrent workers', async () => {
    await enqueue('research', 'singleton')
    const claimed = await Promise.all([claimJob(['research']), claimJob(['research'])])
    expect(claimed.filter(Boolean)).toHaveLength(1)
  })
  it('rejects replayed transaction hashes and wrong payment mode', async () => {
    const products = await research()
    const a = await createOrder(products[0]!.id, input, randomUUID()),
      b = await createOrder(products[0]!.id, input, randomUUID())
    await expect(confirmPayment(a.id, 'test', 3, 'sepolia')).rejects.toThrow(
      'PAYMENT_MODE_MISMATCH',
    )
    await query("UPDATE orders SET payment_mode='sepolia' WHERE id=ANY($1::uuid[])", [[a.id, b.id]])
    const hash = '0x' + 'a'.repeat(64)
    await submitTransaction(a.id, hash)
    await expect(submitTransaction(b.id, hash)).rejects.toMatchObject({ code: '23505' })
    await expect(sandboxPayment(a.id)).rejects.toThrow('PAYMENT_MODE_MISMATCH')
  })
  it('expires unpaid invoices and releases their reservation', async () => {
    const o = await order()
    await query("UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1", [o.id])
    await expect(sandboxPayment(o.id)).rejects.toThrow('INVOICE_EXPIRED')
    await reconcilePayments()
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'expired',
    )
    expect(
      (
        await query('SELECT status FROM budget_reservations WHERE dedupe_key=$1', [`order:${o.id}`])
      )[0]!.status,
    ).toBe('closed')
  })
})

describe('global budget under concurrency', () => {
  function paidConfig(extra: Partial<settings.Config> = {}) {
    const original = settings.config()
    vi.spyOn(settings, 'config').mockReturnValue({
      ...original,
      MODEL_PROVIDER: 'yandex',
      DAILY_BUDGET_KOPECKS: 15000,
      MONTHLY_BUDGET_KOPECKS: 300000,
      RESEARCH_RESERVE_KOPECKS: 10000,
      ...extra,
    })
  }
  it('never gives simultaneous research tasks independent budgets', async () => {
    paidConfig()
    const results = await Promise.allSettled([
      reserveBudget('a', 'research'),
      reserveBudget('b', 'research'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await budgetSummary()).outstanding).toBe(10000)
  })
  it('settles actual cost and replays a saved call without another charge', async () => {
    paidConfig()
    const reservationId = await reserveBudget('a', 'research')
    const invoke = vi.fn(async () => ({ value: { text: 'ok' }, cost: 150 }))
    const call = { key: 'one', reservationId, role: 'test', maximum: 500, demo: false, invoke }
    expect(await meteredCall(call)).toEqual({ text: 'ok' })
    expect(await meteredCall(call)).toEqual({ text: 'ok' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await budgetSummary()).toMatchObject({ daySpent: 150, outstanding: 9850 })
  })
  it('keeps ambiguous charges and refuses an unsafe retry', async () => {
    paidConfig()
    const reservationId = await reserveBudget('a', 'research')
    const invoke = vi.fn(async () => {
      throw new Error('NETWORK_TIMEOUT')
    })
    const call = { key: 'unknown', reservationId, role: 'test', maximum: 500, demo: false, invoke }
    await expect(meteredCall(call)).rejects.toThrow('NETWORK_TIMEOUT')
    await expect(meteredCall(call)).rejects.toThrow('UNCERTAIN_CALL_REQUIRES_REVIEW')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await budgetSummary()).daySpent).toBe(500)
  })
  it('blocks the tool before making a network call when its envelope is exhausted', async () => {
    paidConfig()
    const reservationId = await reserveBudget('a', 'research')
    const invoke = vi.fn(async () => ({ value: 'no', cost: 1 }))
    await expect(
      meteredCall({
        key: 'large',
        reservationId,
        role: 'test',
        maximum: 10001,
        demo: false,
        invoke,
      }),
    ).rejects.toThrow('BUDGET_BLOCKED')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('counts reservations carried over midnight', async () => {
    paidConfig()
    await reserveBudget('old', 'research')
    await query("UPDATE budget_reservations SET created_at=now()-interval '2 days'")
    await expect(reserveBudget('new', 'research')).rejects.toThrow('BUDGET_BLOCKED')
  })
})

describe('owner authentication', () => {
  it('rejects passwords, accepts a session, and respects revocation', async () => {
    await expect(attemptLogin('wrong', '127.0.0.1')).rejects.toThrow('LOGIN_FAILED')
    const token = await attemptLogin(settings.config().OWNER_PASSWORD, '127.0.0.1')
    expect(await validSession(token)).toBe(true)
    expect(await validSession(token + 'x')).toBe(false)
    await query('DELETE FROM sessions WHERE token_hash=$1', [digest(token)])
    expect(await validSession(token)).toBe(false)
  })
  it('rate limits repeated password guesses', async () => {
    for (let i = 0; i < 8; i++)
      await expect(attemptLogin('wrong', '127.0.0.2')).rejects.toThrow('LOGIN_FAILED')
    await expect(attemptLogin(settings.config().OWNER_PASSWORD, '127.0.0.2')).rejects.toThrow(
      'LOGIN_RATE_LIMIT',
    )
  })
})
