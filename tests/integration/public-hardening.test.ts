import { request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Buyers are told apart by X-Forwarded-For from the local test client acting as the proxy.
// PUBLIC_SANDBOX_PAY stays at its default (off).
vi.hoisted(() => {
  process.env.TRUST_PROXY = 'true'
})

import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import { budgetSummary, reserveBudget } from '../../core/budget'
import { createOrder, requestKeyHash } from '../../core/orders'
import { sandboxPayment } from '../../core/payments'
import { applyMigrations, resetDatabase } from './helpers/db'
import { fulfillNext, publishProducts, startPublicApp } from './helpers/public'

const input =
  'Блокнот «Линия». Формат А5, 80 листов в точку, бумага 100 г/м². Обложка из картона. Цвет серый.'
let app: Awaited<ReturnType<typeof startPublicApp>>

beforeAll(async () => {
  await applyMigrations()
  app = await startPublicApp()
})
beforeEach(() => resetDatabase())
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(async () => {
  await app.close()
  await pool.end()
})

const order = (extra: Record<string, unknown> = {}) => ({
  slug: 'description',
  input,
  requestKey: randomUUID(),
  rightsConfirmed: true,
  ...extra,
})
async function create(ip: string) {
  const response = await app.call('/api/public/orders', { body: order(), ip })
  return { status: response.status, body: await response.json() }
}
/**
 * Paid cloud models reserve real budget; the demo provider reserves nothing. Such a stand sells
 * only products made by a real model, so the published ones are marked that way.
 */
async function paidModel(overrides: Partial<ReturnType<typeof settings.config>> = {}) {
  await query('UPDATE products SET is_demo=false')
  const real = settings.config()
  vi.spyOn(settings, 'config').mockReturnValue({
    ...real,
    MODEL_PROVIDER: 'openai',
    SEARCH_PROVIDER: 'searxng',
    ORDER_RESERVE_KOPECKS: 15000,
    ...overrides,
  })
}
/** A raw request: fetch() would normalize the path before sending it. */
function raw(path: string, method = 'GET') {
  const { port } = new URL(app.base)
  return new Promise<{ status: number; message: string }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        let message = ''
        try {
          message = JSON.parse(body).statusMessage ?? ''
        } catch {}
        resolve({ status: res.statusCode!, message })
      })
    })
    r.on('error', reject)
    r.end()
  })
}

describe('public orders do not hold the farm budget', () => {
  it('refuses an incompatible model reserve before creating an invoice or obligation', async () => {
    await publishProducts(['description'])
    await paidModel({ ORDER_RESERVE_KOPECKS: 4000 })
    const before = await budgetSummary()
    const calls = await query('SELECT id FROM tool_calls ORDER BY id')
    const reservations = await query('SELECT id FROM budget_reservations ORDER BY id')
    const response = await create('198.51.100.1')
    expect(response.status).toBe(409)
    expect(response.body.statusMessage).toBe('ORDER_MODEL_BUDGET_TOO_SMALL')
    const [product] = await query("SELECT id FROM products WHERE slug='description'")
    await expect(createOrder(product!.id, input, randomUUID())).rejects.toThrow(
      'ORDER_MODEL_BUDGET_TOO_SMALL',
    )
    expect(await query('SELECT id FROM orders')).toHaveLength(0)
    expect(await query('SELECT id FROM budget_reservations ORDER BY id')).toEqual(reservations)
    expect(await query('SELECT id FROM tool_calls ORDER BY id')).toEqual(calls)
    expect(await budgetSummary()).toEqual(before)
    expect(settings.config().ORDER_RESERVE_KOPECKS).toBe(4000)
  })

  it('reserves nothing before payment, funds the order when it is paid', async () => {
    await publishProducts(['description'])
    await paidModel({ PUBLIC_SANDBOX_PAY: true })
    const before = await budgetSummary()
    const orders = []
    for (let i = 0; i < 5; i++) orders.push((await create(`198.51.100.${i + 1}`)).body)
    expect(orders.every((o) => o.token)).toBe(true)
    // Five unpaid orders: no outstanding budget, research still gets its reservation.
    expect((await budgetSummary()).outstanding).toBe(before.outstanding)
    const research = await reserveBudget(`research:${randomUUID()}`, 'research')
    expect(research).toBeTruthy()
    await query("UPDATE budget_reservations SET status='closed' WHERE id=$1", [research])

    const pay = await app.call(`/api/public/orders/${orders[0].token}/pay`, {
      body: { mode: 'sandbox' },
    })
    expect(pay.status).toBe(200)
    const [funded] = await query(
      `SELECT r.limit_kopecks,o.status FROM orders o JOIN budget_reservations r
       ON r.id=o.reservation_id WHERE o.id=$1`,
      [orders[0].orderId],
    )
    expect(funded).toEqual({ limit_kopecks: 15000, status: 'paid' })
  })

  it('refuses the buyer button when the budget is gone, and holds a confirmed payment for the owner', async () => {
    await publishProducts(['description'])
    await paidModel({ PUBLIC_SANDBOX_PAY: true, DAILY_BUDGET_KOPECKS: 18000 })
    const a = (await create('198.51.100.20')).body
    const b = (await create('198.51.100.21')).body
    expect(
      (await app.call(`/api/public/orders/${a.token}/pay`, { body: { mode: 'sandbox' } })).status,
    ).toBe(200)
    // 15000 of 18000 are now reserved: the second payment cannot be funded.
    const refused = await app.call(`/api/public/orders/${b.token}/pay`, {
      body: { mode: 'sandbox' },
    })
    expect(refused.status).toBe(409)
    expect((await refused.json()).statusMessage).toBe('PUBLIC_CAPACITY_REACHED')
    expect((await query('SELECT status FROM orders WHERE id=$1', [b.orderId]))[0]!.status).toBe(
      'awaiting_payment',
    )
    // The owner confirms it anyway (or a Sepolia transfer arrives): paid, but not started.
    await sandboxPayment(b.orderId)
    const [held] = await query('SELECT status,paid_at,payment_error FROM orders WHERE id=$1', [
      b.orderId,
    ])
    expect(held).toMatchObject({ status: 'manual_review', payment_error: 'BUDGET_BLOCKED' })
    expect(held!.paid_at).toBeTruthy()
    expect(
      await query('SELECT id FROM jobs WHERE dedupe_key=$1', [`fulfill:${b.orderId}`]),
    ).toEqual([])
    const view = await (await app.call(`/api/public/orders/${b.token}`)).json()
    expect(view.status).toBe('needs_attention')
    expect(view.message.title).toBe('Оплата получена, но сегодня не успеем')
    // New orders are not taken while the budget has no room for them.
    const full = await create('198.51.100.22')
    expect(full.status).toBe(409)
    expect(full.body.statusMessage).toBe('BUDGET_BLOCKED')
  })

  it('caps paid public orders per day', async () => {
    await publishProducts(['description'])
    const real = settings.config()
    vi.spyOn(settings, 'config').mockReturnValue({
      ...real,
      PUBLIC_SANDBOX_PAY: true,
      PUBLIC_PAID_ORDERS_PER_DAY: 1,
    })
    const a = (await create('198.51.100.30')).body
    const b = (await create('198.51.100.31')).body
    expect(
      (await app.call(`/api/public/orders/${a.token}/pay`, { body: { mode: 'sandbox' } })).status,
    ).toBe(200)
    const second = await app.call(`/api/public/orders/${b.token}/pay`, {
      body: { mode: 'sandbox' },
    })
    expect((await second.json()).statusMessage).toBe('PUBLIC_CAPACITY_REACHED')
    expect((await (await app.call('/api/public/catalog')).json()).acceptingOrders).toBe(false)
    expect((await create('198.51.100.32')).body.statusMessage).toBe('PUBLIC_ORDERS_LIMIT')
  })

  it('keeps the sandbox button closed to buyers unless PUBLIC_SANDBOX_PAY is on', async () => {
    await publishProducts(['description'])
    const { token, orderId } = (await create('198.51.100.40')).body
    const view = await (await app.call(`/api/public/orders/${token}`)).json()
    expect(view.payment).toEqual({ mode: 'sandbox', canConfirm: false })
    const pay = await app.call(`/api/public/orders/${token}/pay`, { body: { mode: 'sandbox' } })
    expect(pay.status).toBe(409)
    expect((await pay.json()).statusMessage).toBe('SANDBOX_PAY_DISABLED')
    // The owner still confirms test payments from the office.
    await sandboxPayment(orderId)
    expect((await (await app.call(`/api/public/orders/${token}`)).json()).status).toBe(
      'in_progress',
    )
  })
})

describe('public order limits per buyer', () => {
  it('allows two open unpaid orders per address and counts only open or paid ones per day', async () => {
    await publishProducts(['description'])
    const real = settings.config()
    vi.spyOn(settings, 'config').mockReturnValue({ ...real, PUBLIC_ORDERS_PER_DAY: 5 })
    const first = await create('203.0.113.50')
    expect((await create('203.0.113.50')).status).toBe(200)
    const third = await create('203.0.113.50')
    expect(third.status).toBe(409)
    expect(third.body.statusMessage).toBe('PUBLIC_OPEN_ORDERS_LIMIT')
    // One IPv6 /64 is one buyer.
    expect((await create('2001:db8:1:2::10')).status).toBe(200)
    expect((await create('2001:db8:1:2:aaaa::1')).status).toBe(200)
    expect((await create('2001:db8:1:2:bbbb::2')).body.statusMessage).toBe(
      'PUBLIC_OPEN_ORDERS_LIMIT',
    )
    expect((await create('203.0.113.99')).status).toBe(200)
    expect((await create('203.0.113.98')).body.statusMessage).toBe('PUBLIC_ORDERS_LIMIT')
    // An expired invoice frees its slot in both limits.
    await query("UPDATE orders SET status='expired' WHERE id=$1", [first.body.orderId])
    expect((await create('203.0.113.50')).status).toBe(200)
  })

  it('ignores X-Forwarded-For unless TRUST_PROXY is on', async () => {
    await publishProducts(['description'])
    const real = settings.config()
    vi.spyOn(settings, 'config').mockReturnValue({ ...real, TRUST_PROXY: false })
    expect((await create('192.0.2.1')).status).toBe(200)
    expect((await create('192.0.2.2')).status).toBe(200)
    // Different forged headers, one socket address: the third open order is refused.
    expect((await create('192.0.2.3')).body.statusMessage).toBe('PUBLIC_OPEN_ORDERS_LIMIT')
  })

  it('does not sell demo products on a stand with a real model', async () => {
    await publishProducts(['description'])
    expect((await query("SELECT is_demo FROM products WHERE slug='description'"))[0]!.is_demo).toBe(
      true,
    )
    const real = settings.config()
    vi.spyOn(settings, 'config').mockReturnValue({
      ...real,
      MODEL_PROVIDER: 'openrouter',
      SEARCH_PROVIDER: 'searxng',
    })
    const refused = await create('198.51.100.80')
    expect(refused.status).toBe(404)
    expect(refused.body.statusMessage).toBe('PRODUCT_NOT_FOUND')
    expect(await query('SELECT id FROM orders')).toEqual([])
    vi.restoreAllMocks()
    expect((await create('198.51.100.81')).status).toBe(200)
  })

  it('stores only a hash of the idempotency key', async () => {
    await publishProducts(['description'])
    const body = order()
    const created = await app.call('/api/public/orders', { body, ip: '198.51.100.60' })
    const { orderId } = await created.json()
    const [row] = await query('SELECT request_key FROM orders WHERE id=$1', [orderId])
    expect(row!.request_key).toBe(requestKeyHash(body.requestKey))
    expect(row!.request_key).not.toContain(body.requestKey)
    const again = await app.call('/api/public/orders', { body, ip: '198.51.100.60' })
    expect((await again.json()).orderId).toBe(orderId)
  })
})

describe('request hygiene', () => {
  it('refuses paths the router and URL parsing would read differently', async () => {
    for (const path of [
      '/api/orders/..\\public\\orders\\abc',
      '/api/products/..\\public\\services/versions',
      '/api/public/orders/%2e%2e/x',
      '/api/public/orders/%2E%2E%2Fdashboard',
      '/api/public/orders/abc%2fdef',
      '/api/public/orders/abc%5Cdef',
      '/api//dashboard',
      '/api/./dashboard',
      '/api/public/../dashboard',
      '/api/public/orders/..',
      '/order/..%2F..%2Fdashboard',
    ])
      expect([path, await raw(path)]).toEqual([path, { status: 400, message: 'BAD_PATH' }])
    expect(await raw('/api/public/catalog')).toEqual({ status: 200, message: '' })
    expect((await raw('/api/dashboard')).status).toBe(401)
  })

  it('answers 400 to a body that is not JSON', async () => {
    const response = await fetch(`${app.base}/api/public/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3210' },
      body: '{"slug":',
    })
    expect(response.status).toBe(400)
    expect((await response.json()).statusMessage).toBe('INVALID_INPUT')
  })

  it('serves HEAD for the result file and marks responses noindex and uncached', async () => {
    await publishProducts(['description'])
    const { token, orderId } = (await create('198.51.100.70')).body
    await sandboxPayment(orderId)
    expect(await fulfillNext()).toBe(true)
    const head = await fetch(`${app.base}/api/public/orders/${token}/result.txt`, {
      method: 'HEAD',
      headers: { 'x-forwarded-for': '198.51.100.70' },
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-disposition')).toMatch(/^attachment; filename="order-/)
    expect(await head.text()).toBe('')
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(head.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const post = await app.call(`/api/public/orders/${token}/result.txt`, { body: {} })
    expect(post.status).toBe(401)
  })
})
