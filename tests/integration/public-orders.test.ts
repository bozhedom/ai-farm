import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Small daily cap so the limit test stays short. Set before config() is first read. Buyers are
// told apart by X-Forwarded-For from the local test client acting as the reverse proxy, and the
// sandbox button is open to buyers as in a local demo.
vi.hoisted(() => {
  process.env.PUBLIC_ORDERS_PER_DAY = '4'
  process.env.TRUST_PROXY = 'true'
  process.env.PUBLIC_SANDBOX_PAY = 'true'
})

import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { orderTokenHash, orderTokenPattern, randomOrderToken } from '../../core/public-orders'
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
afterAll(async () => {
  await app.close()
  await pool.end()
})

const order = (slug = 'description', extra: Record<string, unknown> = {}) => ({
  slug,
  input,
  requestKey: randomUUID(),
  rightsConfirmed: true,
  ...extra,
})

describe('public buyer path (sandbox)', () => {
  it('lets a buyer order, pay, wait and download the result without a session', async () => {
    await publishProducts(['description', 'faq'])
    const catalog = await (await app.call('/api/public/catalog')).json()
    expect(catalog.acceptingOrders).toBe(true)
    expect(catalog.notice).toBe('Тестовый магазин: оплата ненастоящая, деньги не списываются.')
    expect(catalog.services.map((s: any) => s.slug)).toEqual(['description', 'faq'])
    expect(catalog.services[0]).toMatchObject({
      name: 'Описание товара для маркетплейса',
      priceKopecks: 49000,
      currency: 'RUB',
    })
    const page = await app.call('/api/public/services/description')
    expect(page.status).toBe(200)
    expect((await page.json()).service.slug).toBe('description')
    expect((await app.call('/api/public/services/landing')).status).toBe(404)
    expect((await app.call('/api/public/services/Bad_Slug')).status).toBe(404)

    const body = order()
    const created = await app.call('/api/public/orders', { body })
    expect(created.status).toBe(200)
    const { orderId, token, url } = await created.json()
    expect(token).toMatch(orderTokenPattern)
    expect(url).toBe(`/order/${token}`)
    // A retried request returns the same order and link; a changed text is a conflict.
    expect(await (await app.call('/api/public/orders', { body })).json()).toEqual({
      orderId,
      token,
      url,
    })
    const conflict = await app.call('/api/public/orders', {
      body: { ...body, input: input + ' Ещё.' },
    })
    expect(conflict.status).toBe(409)
    expect(
      (
        await app.call('/api/public/orders', {
          body: order('description', { rightsConfirmed: false }),
        })
      ).status,
    ).toBe(400)

    const waiting = await (await app.call(`/api/public/orders/${token}`)).json()
    expect(waiting).toMatchObject({
      id: orderId,
      status: 'awaiting_payment',
      price: { kopecks: 49000, currency: 'RUB', test: true },
      payment: { mode: 'sandbox', canConfirm: true },
      message: { title: 'Ждём оплату' },
      result: null,
    })
    expect(waiting.inputPreview).toContain('Блокнот')
    const hidden = JSON.stringify(waiting)
    for (const word of [
      'strategy',
      'reservation',
      'client_key',
      'access_token',
      'Альфа',
      'Бета',
      'generation',
    ])
      expect(hidden).not.toContain(word)
    expect((await app.call(`/api/public/orders/${token}/result.txt`)).status).toBe(404)

    expect(
      (await app.call(`/api/public/orders/${token}/pay`, { body: { mode: 'sandbox' } })).status,
    ).toBe(200)
    expect((await (await app.call(`/api/public/orders/${token}`)).json()).status).toBe(
      'in_progress',
    )
    expect(await fulfillNext()).toBe(true)

    const done = await (await app.call(`/api/public/orders/${token}`)).json()
    expect(done.status).toBe('delivered')
    expect(done.steps.every((s: any) => s.done)).toBe(true)
    expect(done.result.downloadUrl).toBe(`/api/public/orders/${token}/result.txt`)
    const file = await app.call(done.result.downloadUrl)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toContain('text/plain')
    expect(file.headers.get('content-disposition')).toMatch(
      /^attachment; filename="order-[0-9A-F]{6}\.txt"$/,
    )
    expect(await file.text()).toBe(done.result.text)

    const [row] = await query('SELECT * FROM orders WHERE id=$1', [orderId])
    expect(row).toMatchObject({
      source: 'public',
      price_kopecks: 49000,
      is_test_payment: true,
      revenue_kopecks: 0,
      access_token_hash: orderTokenHash(token),
    })
    expect(row!.client_key).toMatch(/^[0-9a-f]{64}$/)
    const everything =
      JSON.stringify(await query('SELECT * FROM orders')) +
      JSON.stringify(await query('SELECT * FROM audit_events'))
    expect(everything).not.toContain(token)
    expect(everything).not.toContain('203.0.113.10')
  })

  it('keeps the office closed and other orders private', async () => {
    await publishProducts(['description'])
    const { orderId, token } = await (
      await app.call('/api/public/orders', { body: order() })
    ).json()
    expect((await app.call('/api/dashboard')).status).toBe(401)
    expect((await app.call(`/api/orders/${orderId}`)).status).toBe(401)
    expect((await app.call(`/api/orders/${orderId}/relink`, { body: {} })).status).toBe(401)

    const misses = [
      randomOrderToken(),
      'abc',
      token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
      'a'.repeat(300),
      'not-a-token!',
    ]
    const answers = await Promise.all(
      misses.map(async (t) => {
        const r = await app.call(`/api/public/orders/${t}`)
        const json = await r.json()
        return [r.status, json.statusMessage]
      }),
    )
    expect(answers).toEqual(misses.map(() => [404, 'ORDER_NOT_FOUND']))
    expect(
      (
        await app.call(`/api/public/orders/${randomOrderToken()}/pay`, {
          body: { mode: 'sandbox' },
        })
      ).status,
    ).toBe(404)

    const foreign = await app.call('/api/public/orders', {
      body: order(),
      origin: 'https://evil.example',
    })
    expect(foreign.status).toBe(403)
    const payForeign = await app.call(`/api/public/orders/${token}/pay`, {
      body: { mode: 'sandbox' },
      origin: 'https://evil.example',
    })
    expect(payForeign.status).toBe(403)

    // The owner replaces a leaked link: the old one stops working at once.
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    const relinked = await app.call(`/api/orders/${orderId}/relink`, {
      body: {},
      cookie: `farm_session=${session}`,
    })
    expect(relinked.status).toBe(200)
    const fresh = await relinked.json()
    expect(fresh.token).toMatch(orderTokenPattern)
    expect((await app.call(`/api/public/orders/${token}`)).status).toBe(404)
    expect((await app.call(`/api/public/orders/${fresh.token}`)).status).toBe(200)
    expect(
      (await app.call(`/api/orders/${orderId}`, { cookie: `farm_session=${session}` })).status,
    ).toBe(200)
  })

  it('limits requests per buyer and public orders per day', async () => {
    await publishProducts(['description'])
    const many = await Promise.all(
      Array.from({ length: 121 }, () => app.call('/api/public/catalog', { ip: '198.51.100.1' })),
    )
    expect(many.filter((r) => r.status === 429)).toHaveLength(1)
    const limited = many.find((r) => r.status === 429)!
    expect((await limited.json()).statusMessage).toBe('RATE_LIMITED')
    expect((await app.call('/api/public/catalog', { ip: '198.51.100.2' })).status).toBe(200)

    // Ten order attempts per hour per buyer, counted even when the form is wrong.
    for (let i = 0; i < 10; i++)
      expect(
        (
          await app.call('/api/public/orders', {
            body: { slug: 'description' },
            ip: '198.51.100.3',
          })
        ).status,
      ).toBe(400)
    expect(
      (await app.call('/api/public/orders', { body: order(), ip: '198.51.100.3' })).status,
    ).toBe(429)

    for (let i = 0; i < 4; i++)
      expect(
        (await app.call('/api/public/orders', { body: order(), ip: `192.0.2.${i + 1}` })).status,
      ).toBe(200)
    const capped = await app.call('/api/public/orders', { body: order(), ip: '192.0.2.50' })
    expect(capped.status).toBe(409)
    expect((await capped.json()).statusMessage).toBe('PUBLIC_ORDERS_LIMIT')
    expect(
      (await (await app.call('/api/public/catalog', { ip: '192.0.2.51' })).json()).acceptingOrders,
    ).toBe(false)
  })

  it('refuses orders while the farm is paused and for unpublished services', async () => {
    await publishProducts(['description', 'faq'])
    await query("UPDATE products SET visibility='private' WHERE slug='faq'")
    const hidden = await app.call('/api/public/orders', { body: order('faq') })
    expect(hidden.status).toBe(404)
    await query("UPDATE system_state SET mode='paused'")
    const paused = await app.call('/api/public/orders', { body: order() })
    expect(paused.status).toBe(409)
    expect((await paused.json()).statusMessage).toBe('NEW_ORDERS_PAUSED')
    expect((await (await app.call('/api/public/catalog')).json()).acceptingOrders).toBe(false)
  })

  it('writes one audit event when many unknown links arrive, without addresses', async () => {
    for (let i = 0; i < 55; i++)
      expect(
        (await app.call(`/api/public/orders/${randomOrderToken()}`, { ip: `10.9.${i}.1` })).status,
      ).toBe(404)
    const events = await query("SELECT * FROM audit_events WHERE kind='public_token_probe'")
    expect(events).toHaveLength(1)
    expect(events[0]!.message).toBe(
      'Похоже на перебор ссылок заказов: 50 неизвестных ссылок за 10 минут.',
    )
    expect(JSON.stringify(events[0]!.data)).not.toMatch(/10\.9\.|ip|key/i)
  })
})
