import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createApp, createRouter, toNodeListener } from 'h3'
import { query } from '../../../core/db'
import { claimJob, enqueue, finishJob } from '../../../core/queue'
import { runJob } from '../../../core/jobs/run'
import security from '../../../server/middleware/security'
import catalog from '../../../server/api/public/catalog.get'
import service from '../../../server/api/public/services/[slug].get'
import createOrder from '../../../server/api/public/orders/index.post'
import viewOrder from '../../../server/api/public/orders/[token].get'
import payOrder from '../../../server/api/public/orders/[token]/pay.post'
import resultTxt from '../../../server/api/public/orders/[token]/result.txt.get'
import dashboard from '../../../server/api/dashboard.get'
import ownerOrder from '../../../server/api/orders/[id].get'
import relink from '../../../server/api/orders/[id]/relink.post'

/** Runs a demo research for the templates and publishes the resulting products. */
export async function publishProducts(templates: string[]) {
  await enqueue('research', `publish:${randomUUID()}`, { templates: JSON.stringify(templates) })
  const job = (await claimJob(['research']))!
  await runJob(job)
  await finishJob(job)
  await query("UPDATE products SET visibility='public', published_at=now()")
  return query('SELECT * FROM products ORDER BY slug')
}

/** Executes one queued fulfill job like the worker does. */
export async function fulfillNext() {
  const job = await claimJob(['fulfill'])
  if (!job) return false
  try {
    await runJob(job)
    await finishJob(job)
  } catch (error) {
    await finishJob(job, error)
  }
  return true
}

/**
 * The real security middleware and route handlers on a plain h3 server, the same order Nitro
 * uses: middleware first, then the router. Requests come from 127.0.0.1, so a test can act as
 * different buyers through X-Forwarded-For (a private peer counts as the reverse proxy).
 */
export async function startPublicApp() {
  const app = createApp()
  app.use(security)
  const router = createRouter()
  router.get('/api/public/catalog', catalog)
  router.get('/api/public/services/:slug', service)
  router.post('/api/public/orders', createOrder)
  router.get('/api/public/orders/:token', viewOrder)
  router.post('/api/public/orders/:token/pay', payOrder)
  router.get('/api/public/orders/:token/result.txt', resultTxt)
  router.get('/api/dashboard', dashboard)
  router.get('/api/orders/:id', ownerOrder)
  router.post('/api/orders/:id/relink', relink)
  app.use(router)
  const server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const origin = 'http://localhost:3210'
  const call = (
    path: string,
    init: { method?: string; body?: unknown; ip?: string; origin?: string; cookie?: string } = {},
  ) => {
    const headers: Record<string, string> = { 'x-forwarded-for': init.ip || '203.0.113.10' }
    if (init.cookie) headers.cookie = init.cookie
    let body: string | undefined
    if (init.body !== undefined) {
      body = JSON.stringify(init.body)
      headers['content-type'] = 'application/json'
      headers.origin = init.origin ?? origin
    }
    return fetch(base + path, { method: init.method || (body ? 'POST' : 'GET'), headers, body })
  }
  return {
    base,
    call,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
