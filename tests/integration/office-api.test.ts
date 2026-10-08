import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createApp, createRouter, toNodeListener, type EventHandler } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { claimJob, enqueue, finishJob } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { createOrder } from '../../core/orders'
import security from '../../server/middleware/security'
import overview from '../../server/api/office/overview.get'
import ideas from '../../server/api/office/ideas/index.get'
import idea from '../../server/api/office/ideas/[id].get'
import ideaUpdate from '../../server/api/office/ideas/[id].post'
import agents from '../../server/api/office/agents/index.get'
import evolve from '../../server/api/office/agents/evolve.post'
import products from '../../server/api/office/products/index.get'
import visibility from '../../server/api/office/products/[id]/visibility.post'
import orders from '../../server/api/office/orders/index.get'
import money from '../../server/api/office/money.get'
import reports from '../../server/api/office/reports.get'
import journal from '../../server/api/office/journal.get'
import settingsGet from '../../server/api/office/settings.get'
import settingsPost from '../../server/api/office/settings.post'
import scout from '../../server/api/office/scout.post'
import leads from '../../server/api/office/leads/index.get'
import draft from '../../server/api/office/leads/[id]/draft.post'
import dashboard from '../../server/api/dashboard.get'
import control from '../../server/api/control.post'
import opportunities from '../../server/api/opportunities/index.get'
import catalog from '../../server/api/public/catalog.get'
import { applyMigrations, resetDatabase } from './helpers/db'

const origin = 'http://localhost:3210'
let server: Server
let base = ''

const gets: [string, EventHandler][] = [
  ['/api/office/overview', overview],
  ['/api/office/ideas', ideas],
  ['/api/office/ideas/:id', idea],
  ['/api/office/agents', agents],
  ['/api/office/products', products],
  ['/api/office/orders', orders],
  ['/api/office/money', money],
  ['/api/office/reports', reports],
  ['/api/office/journal', journal],
  ['/api/office/settings', settingsGet],
  ['/api/office/leads', leads],
  ['/api/dashboard', dashboard],
  ['/api/opportunities', opportunities],
  ['/api/public/catalog', catalog],
]
const posts: [string, EventHandler][] = [
  ['/api/office/ideas/:id', ideaUpdate],
  ['/api/office/agents/evolve', evolve],
  ['/api/office/products/:id/visibility', visibility],
  ['/api/office/settings', settingsPost],
  ['/api/office/scout', scout],
  ['/api/office/leads/:id/draft', draft],
  ['/api/control', control],
]

beforeAll(async () => {
  await applyMigrations()
  const app = createApp()
  app.use(security)
  const router = createRouter()
  for (const [path, handler] of gets) router.get(path, handler)
  for (const [path, handler] of posts) router.post(path, handler)
  app.use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(() => resetDatabase())
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

async function call(method: 'GET' | 'POST', path: string, cookie?: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie: `farm_session=${cookie}` } : {}),
      ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  const text = await response.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: response.status, json }
}
const someId = '00000000-0000-4000-8000-000000000000'
const path = (route: string) => route.replace(':id', someId)

describe('owner office API', () => {
  it('answers 401 without the owner session on every office route', async () => {
    for (const [route] of gets.filter(([route]) => route !== '/api/public/catalog'))
      expect([route, (await call('GET', path(route))).status]).toEqual([route, 401])
    for (const [route] of posts)
      expect([route, (await call('POST', path(route), undefined, {})).status]).toEqual([route, 401])
    expect((await call('GET', '/api/public/catalog')).status).toBe(200)
    // A foreign origin is refused before the session is even checked.
    const foreign = await fetch(base + '/api/office/scout', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(foreign.status).toBe(403)
  })

  it('serves the office contracts and owner actions with a session', async () => {
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    const view = await call('GET', '/api/office/overview', session)
    expect(view.status).toBe(200)
    expect(view.json).toMatchObject({
      mode: 'running',
      generation: 1,
      totals: { realRevenueKopecks: 0, testPayments: 0 },
      worker: { alive: false },
    })
    expect(Array.isArray(view.json.feed)).toBe(true)

    const queued = await call('POST', '/api/office/scout', session, {})
    expect(queued.status).toBe(200)
    expect(queued.json.jobs).toHaveLength(4)
    for (let i = 0; i < 4; i++) {
      const job = (await claimJob(['scout']))!
      if (i === 0)
        expect((await call('GET', '/api/office/overview', session)).json.now).toMatchObject({
          title: 'Разведка',
          detail: expect.stringMatching(/^Разведчик [АБВГ] ищет идею: /),
          step: 1,
          steps: 4,
        })
      await runJob(job)
      await finishJob(job)
    }
    const list = await call('GET', '/api/office/ideas', session)
    expect(list.status).toBe(200)
    expect(list.json.total).toBe(4)
    expect(list.json.items[0].agent.name).toMatch(/^Разведчик [АБВГ]$/)
    expect(list.json.categories.length).toBeGreaterThanOrEqual(12)
    // Russian names for people, ids for filters.
    const first = list.json.items[0]
    expect(first.category).toBe(
      list.json.categories.find((c: any) => c.id === first.categoryId).label,
    )
    expect(first.topic).not.toBe(first.topicId)
    const filtered = await call('GET', `/api/office/ideas?category=${first.categoryId}`, session)
    expect(filtered.json.items.every((i: any) => i.categoryId === first.categoryId)).toBe(true)
    const one = await call('GET', `/api/office/ideas/${list.json.items[0].id}`, session)
    expect(one.json).toMatchObject({
      id: list.json.items[0].id,
      research: { audience: expect.any(String) },
    })
    expect((await call('GET', `/api/office/ideas/${someId}`, session)).status).toBe(404)
    const noted = await call('POST', `/api/office/ideas/${list.json.items[0].id}`, session, {
      ownerNote: 'Посмотреть в понедельник',
    })
    expect(noted.json.ownerNote).toBe('Посмотреть в понедельник')
    expect(
      (
        await call('POST', `/api/office/ideas/${list.json.items[0].id}`, session, {
          status: 'accepted',
        })
      ).status,
    ).toBe(400)

    const team = await call('GET', '/api/office/agents', session)
    expect(team.json.agents.map((a: any) => a.name)).toEqual([
      'Разведчик А',
      'Разведчик Б',
      'Разведчик В',
      'Разведчик Г',
    ])
    expect(team.json.evolution).toMatchObject({ enabled: true, minIdeas: 6, ready: false })
    const check = await call('POST', '/api/office/agents/evolve', session, {})
    expect(check.json.reused).toBe(false)

    const updated = await call('POST', '/api/office/settings', session, {
      evolutionMinIdeas: 2,
      leadsPerDay: 3,
    })
    expect(updated.json).toMatchObject({ evolutionMinIdeas: 2, leadsPerDay: 3 })
    expect(
      (await call('POST', '/api/office/settings', session, { evolutionMinIdeas: 0 })).status,
    ).toBe(400)
    expect((await call('POST', '/api/office/settings', session, { dailyBudget: 1 })).status).toBe(
      400,
    )

    await enqueue('research', 'office-product', { templates: JSON.stringify(['faq']) })
    const research = (await claimJob(['research']))!
    await runJob(research)
    await finishJob(research)
    const productList = (await call('GET', '/api/office/products', session)).json
    expect(productList).toMatchObject({ total: 1, offset: 0, hasMore: false })
    const items = productList.items
    expect(items[0]).toMatchObject({
      slug: 'faq',
      visibility: 'private',
      publicUrl: `${origin}/services/faq`,
    })
    const shown = await call('POST', `/api/office/products/${items[0].id}/visibility`, session, {
      visibility: 'public',
    })
    expect(shown.json).toMatchObject({ visibility: 'public', publishedAt: expect.any(String) })
    await createOrder(
      items[0].id,
      'Мастерская ремонтирует велосипеды. Диагностика один день. Доставки нет.',
      randomUUID(),
    )
    const orderList = (await call('GET', '/api/office/orders', session)).json
    expect(orderList.items[0].agentName).toMatch(/^Разведчик [АБВГ]$/)
    expect((await call('GET', '/api/office/overview', session)).json.totals).toMatchObject({
      orders: 1,
      ordersDelivered: 0,
      testPayments: 0,
      testPaymentsKopecks: 0,
    })
    const money = (await call('GET', '/api/office/money', session)).json
    expect(money).toMatchObject({ realRevenueKopecks: 0, testPayments: { count: 0, kopecks: 0 } })
    expect(Object.keys(money.byCategory).sort()).toEqual([
      'lead',
      'order',
      'report',
      'research',
      'scout',
    ])

    expect((await call('GET', '/api/office/reports', session)).json).toMatchObject({
      items: [],
      total: 0,
      hasMore: false,
    })
    const settings = (await call('GET', '/api/office/settings', session)).json
    expect(settings.researchEnabled).toBe(true)
    const log = (await call('GET', '/api/office/journal', session)).json
    expect(log.events.length).toBeGreaterThan(0)
    expect(log.jobs.some((job: any) => job.title.startsWith('Разведчик '))).toBe(true)
    for (const line of [
      ...log.events.map((e: any) => e.text),
      ...log.jobs.map((j: any) => j.title),
    ])
      expect(line).not.toMatch(/[—→]/)
    // Research found request candidates before any product was public: no product link yet.
    const found = (await call('GET', '/api/office/leads', session)).json
    expect(found.total).toBe(2)
    expect(
      found.items.every((lead: any) => lead.product === null && lead.replyDraft === null),
    ).toBe(true)
    expect((await call('POST', `/api/office/leads/${someId}/draft`, session, {})).status).toBe(404)

    // The old dashboard routes keep working for the old office.
    const old = await call('GET', '/api/dashboard', session)
    expect(old.status).toBe(200)
    expect(old.json.strategies).toHaveLength(4)
    expect((await call('GET', '/api/opportunities', session)).status).toBe(200)
    expect((await call('POST', '/api/control', session, { action: 'paused' })).json).toEqual({
      mode: 'paused',
    })
    expect((await call('GET', '/api/office/overview', session)).json.worker.reason).toMatch(
      /^Пауза/,
    )
  })
})
