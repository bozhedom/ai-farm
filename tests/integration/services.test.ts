import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { attemptLogin } from '../../core/auth'
import { config } from '../../core/config'
import { pool, query } from '../../core/db'
import { sandboxPayment } from '../../core/payments'
import { serviceByTemplate } from '../../core/service-catalog'
import {
  createServiceJob,
  quoteService,
  serviceJob,
  servicesCatalog,
} from '../../core/services/store'
import { readServiceQuote, signServiceQuote } from '../../core/services/quote'
import security from '../../server/middleware/security'
import catalog from '../../server/api/services/index.get'
import quoteHandler from '../../server/api/services/quote.post'
import createJob from '../../server/api/services/jobs/index.post'
import getJob from '../../server/api/services/jobs/[id].get'
import { applyMigrations, resetDatabase } from './helpers/db'
import { fulfillNext, publishProducts } from './helpers/public'

const input = serviceByTemplate.description.example
let productId: string
let base: string
let cookie: string
const server = createServer()

beforeAll(async () => {
  await applyMigrations()
  const app = createApp()
  app.use(security)
  const router = createRouter()
  router.get('/api/services', catalog)
  router.post('/api/services/quote', quoteHandler)
  router.post('/api/services/jobs', createJob)
  router.get('/api/services/jobs/:id', getJob)
  app.use(router)
  server.on('request', toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(async () => {
  await resetDatabase()
  const products = await publishProducts(['description'])
  productId = products[0]!.id
  await query(
    'UPDATE system_state SET worker_heartbeat=now(),provider_readiness=$1 WHERE id=true',
    [{ model: true, search: true, checkedAt: new Date().toISOString() }],
  )
  cookie = `farm_session=${await attemptLogin(config().OWNER_PASSWORD, '127.0.0.1')}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

async function call(
  path: string,
  body?: unknown,
  extra: { anonymous?: boolean; origin?: string } = {},
) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(extra.anonymous ? {} : { cookie }),
      ...(body === undefined
        ? {}
        : { 'content-type': 'application/json', origin: extra.origin ?? config().APP_ORIGIN }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function request() {
  const offer = await quoteService(productId, input)
  return { quote: offer.quote, input, requestKey: randomUUID() }
}

describe('owner service API', () => {
  it('lists all contracts and clearly separates prepared products and unsupported x402', async () => {
    const view = await servicesCatalog()
    expect(view.services).toHaveLength(12)
    expect(view.services.find((service) => service.template === 'description')).toMatchObject({
      productId,
      ready: true,
      priceKopecks: 49000,
      testOnly: true,
      example: input,
    })
    expect(view.services.find((service) => service.template === 'faq')).toMatchObject({
      productId: null,
      ready: false,
    })
    expect(view.x402.status).toBe('not-implemented')
    expect(view.apiAccess).toBe('owner-session')
    expect(view.storefront).toMatchObject({ published: 1, testOnly: true })
  })

  it('keeps every endpoint behind owner authentication and the existing origin guard', async () => {
    expect((await call('/api/services', undefined, { anonymous: true })).status).toBe(401)
    expect(
      (
        await call(
          '/api/services/quote',
          { productId, input, rightsConfirmed: true },
          { anonymous: true },
        )
      ).status,
    ).toBe(401)
    expect((await call('/api/services/jobs', {}, { anonymous: true })).status).toBe(401)
    expect(
      (await call(`/api/services/jobs/${randomUUID()}`, undefined, { anonymous: true })).status,
    ).toBe(401)
    expect(
      (
        await call(
          '/api/services/quote',
          { productId, input, rightsConfirmed: true },
          { origin: 'https://other.example' },
        )
      ).status,
    ).toBe(403)
    expect(
      (await call('/api/services/quote', { productId, input, rightsConfirmed: false })).status,
    ).toBe(400)
    expect(
      (
        await call('/api/services/quote', {
          productId,
          input,
          rightsConfirmed: true,
          callbackUrl: 'https://other.example',
        })
      ).status,
    ).toBe(400)
  })

  it('quotes, accepts once, waits for explicit test payment and reuses the normal quality gate', async () => {
    const callsBefore = (await query('SELECT count(*)::int AS n FROM tool_calls'))[0]!.n
    const quoted = await call('/api/services/quote', { productId, input, rightsConfirmed: true })
    expect(quoted.status).toBe(200)
    const offer = await quoted.json()
    const requestBody = {
      quote: offer.quote,
      input,
      requestKey: randomUUID(),
      rightsConfirmed: true,
    }
    const created = await call('/api/services/jobs', requestBody)
    expect(created.status).toBe(200)
    const job = await created.json()
    expect(job).toMatchObject({
      status: 'awaiting_payment',
      testOnly: true,
      result: null,
      existing: false,
    })
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(0)
    expect((await query('SELECT count(*)::int AS n FROM tool_calls'))[0]!.n).toBe(callsBefore)
    expect(await (await call('/api/services/jobs', requestBody)).json()).toMatchObject({
      id: job.id,
      existing: true,
    })
    await sandboxPayment(job.orderId)
    expect(await fulfillNext()).toBe(true)
    const completed = await (await call(`/api/services/jobs/${job.id}`)).json()
    expect(completed.status).toBe('delivered')
    expect(completed.result.length).toBeGreaterThan(30)
    const [order] = await query(
      'SELECT is_test_payment,revenue_kopecks,review,price_kopecks FROM orders WHERE id=$1',
      [job.orderId],
    )
    expect(order).toMatchObject({
      is_test_payment: true,
      revenue_kopecks: 0,
      price_kopecks: offer.priceKopecks,
      review: { verdict: 'PASS' },
    })
  })

  it('serializes concurrent retries and refuses reusing the same quote for a second job', async () => {
    const body = await request()
    const results = await Promise.all([createServiceJob(body), createServiceJob(body)])
    expect(new Set(results.map((job) => job.id)).size).toBe(1)
    expect(results.filter((job) => !job.existing)).toHaveLength(1)
    expect(await query('SELECT id FROM service_requests')).toHaveLength(1)
    expect(await query('SELECT id FROM orders')).toHaveLength(1)
    await expect(createServiceJob({ ...body, requestKey: randomUUID() })).rejects.toThrow(
      'SERVICE_QUOTE_ALREADY_USED',
    )
  })

  it('rejects input changes, quote tampering and a conflicting request key', async () => {
    const body = await request()
    await expect(createServiceJob({ ...body, input: input + ' Другой материал.' })).rejects.toThrow(
      'SERVICE_QUOTE_INPUT_CHANGED',
    )
    await expect(createServiceJob({ ...body, quote: 'broken' })).rejects.toThrow(
      'SERVICE_QUOTE_INVALID',
    )
    await createServiceJob(body)
    const next = await request()
    await expect(createServiceJob({ ...next, requestKey: body.requestKey })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    )
  })

  it('refuses expired and changed offers before making an order or reservation', async () => {
    const body = await request()
    const parsed = readServiceQuote(body.quote, config().SESSION_SECRET)
    await expect(createServiceJob(body, new Date(parsed.expiresAt))).rejects.toThrow(
      'SERVICE_QUOTE_EXPIRED',
    )
    await query('UPDATE products SET price_kopecks=price_kopecks+1 WHERE id=$1', [productId])
    await expect(createServiceJob(body)).rejects.toThrow('SERVICE_QUOTE_CHANGED')
    expect(await query('SELECT id FROM orders')).toHaveLength(0)
    expect(await query("SELECT id FROM budget_reservations WHERE category='order'")).toHaveLength(0)
  })

  it('detects a recipe change even if its version number is accidentally unchanged', async () => {
    const body = await request()
    await query(
      `UPDATE products SET spec=jsonb_set(spec,'{promise}',to_jsonb('Другой результат услуги.'::text)) WHERE id=$1`,
      [productId],
    )
    await expect(createServiceJob(body)).rejects.toThrow('SERVICE_QUOTE_CHANGED')
  })

  it('retrieves accepted requests after expiry or a pause without creating another obligation', async () => {
    const body = await request()
    const original = await createServiceJob(body)
    await query("UPDATE system_state SET mode='emergency_stop'")
    const replay = await createServiceJob(body, new Date(Date.now() + 3600000))
    expect(replay).toMatchObject({ id: original.id, existing: true })
    expect(await query('SELECT id FROM orders')).toHaveLength(1)
  })

  it('does not allow a stale worker, missing model readiness or pause to admit new work', async () => {
    const body = await request()
    await query("UPDATE system_state SET worker_heartbeat=now()-interval '2 minutes'")
    expect((await servicesCatalog()).acceptingJobs).toBe(false)
    await expect(createServiceJob(body)).rejects.toThrow('SERVICE_WORKER_UNAVAILABLE')
    await query('UPDATE system_state SET worker_heartbeat=now(),provider_readiness=null')
    await expect(quoteService(productId, input)).rejects.toThrow('SERVICE_MODEL_UNAVAILABLE')
    await query("UPDATE system_state SET mode='paused'")
    await expect(createServiceJob(body)).rejects.toThrow('NEW_ORDERS_PAUSED')
    expect(await query('SELECT id FROM orders')).toHaveLength(0)
  })

  it('does not accept a signed offer from another configured test payment mode', async () => {
    const body = await request()
    const parsed = readServiceQuote(body.quote, config().SESSION_SECRET)
    const quote = signServiceQuote({ ...parsed, paymentMode: 'sepolia' }, config().SESSION_SECRET)
    await expect(createServiceJob({ ...body, quote })).rejects.toThrow('PAYMENT_MODE_MISMATCH')
  })

  it('preserves archived products and hides unfinished or unrelated results', async () => {
    const body = await request()
    const job = await createServiceJob(body)
    await query("UPDATE orders SET result='Непроверенный текст' WHERE id=$1", [job.orderId])
    expect((await serviceJob(job.id)).result).toBeNull()
    await expect(serviceJob(job.orderId)).rejects.toThrow('SERVICE_JOB_NOT_FOUND')
    await query("UPDATE products SET status='archived' WHERE id=$1", [productId])
    expect(
      (await servicesCatalog()).services.find((service) => service.template === 'description')!
        .productId,
    ).toBeNull()
    const another = signServiceQuote(
      { ...readServiceQuote(body.quote, config().SESSION_SECRET), id: randomUUID() },
      config().SESSION_SECRET,
    )
    await expect(
      createServiceJob({ ...body, quote: another, requestKey: randomUUID() }),
    ).rejects.toThrow('PRODUCT_NOT_FOUND')
    expect((await serviceJob(job.id)).id).toBe(job.id)
  })
})
