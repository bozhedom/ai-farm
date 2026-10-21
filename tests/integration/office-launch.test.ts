import { createServer, type Server } from 'node:http'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { ensurePortfolios } from '../../core/trading/store'
import security from '../../server/middleware/security'
import launch from '../../server/api/office/launch.get'
import type { LaunchView } from '../../core/contracts/launch'
import { applyMigrations, resetDatabase } from './helpers/db'

let server: Server
let base = ''

beforeAll(async () => {
  await applyMigrations()
  const app = createApp()
  app.use(security)
  const router = createRouter()
  router.get('/api/office/launch', launch)
  app.use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  await resetDatabase()
  await query('INSERT INTO computer_use(id) VALUES(true) ON CONFLICT DO NOTHING')
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

const get = async (cookie?: string) => {
  const response = await fetch(base + '/api/office/launch', {
    headers: cookie ? { cookie: `farm_session=${cookie}` } : {},
  })
  const text = await response.text()
  return { status: response.status, text, json: JSON.parse(text) as LaunchView }
}
const step = (view: LaunchView, id: string) =>
  view.groups.flatMap((g) => g.steps).find((s) => s.id === id)!

describe('owner launch checklist API', () => {
  it('needs the owner session and never carries a secret', async () => {
    expect((await get()).status).toBe(401)
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    const { status, text, json } = await get(session)
    expect(status).toBe(200)
    expect(json.total).toBeGreaterThan(5)
    expect(json.groups.map((g) => g.id)).toEqual([
      'required',
      'freelance',
      'payments',
      'trading',
      'extra',
    ])
    // Only booleans, counts and codes: no password, session, key or database URL.
    expect(text).not.toContain('test-owner-password-at-least-20')
    expect(text).not.toContain('test-session-secret')
    expect(text).not.toContain('test-only-key')
    expect(text).not.toContain(process.env.DATABASE_URL!)
    expect(text).not.toContain(session)
  })

  it('detects the state from the tables: a halted agent, a rejected key, a logged-in platform', async () => {
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    // Nothing runs: the worker is silent and the demo model is configured.
    let view = (await get(session)).json
    expect(step(view, 'server')).toMatchObject({ status: 'needed' })
    expect(step(view, 'model')).toMatchObject({ status: 'needed' })
    expect(step(view, 'platforms')).toMatchObject({ status: 'needed' })
    expect(step(view, 'wallet-key')).toMatchObject({ status: 'needed', state: 'Ключ не внесён.' })
    expect(view.next?.id).toBe('server')

    await query('UPDATE system_state SET worker_heartbeat=now(),provider_readiness=$1', [
      JSON.stringify({ model: true, search: true, checkedAt: new Date().toISOString() }),
    ])
    await query(
      "UPDATE computer_use SET enabled=true,failures=3,last_error='COMPUTER_USE_VM_UNAVAILABLE',auto_proposals=true",
    )
    await query("INSERT INTO computer_use_platforms(domain,logged_in) VALUES('kwork.ru',true)")
    await ensurePortfolios()
    await query(
      "UPDATE trading_portfolios SET check_error='TRADING_KEY_PERMISSIONS' WHERE exchange='bybit' AND mode='live'",
    )
    view = (await get(session)).json
    expect(step(view, 'server')).toMatchObject({ status: 'done' })
    const halted = step(view, 'computer-on')
    expect(halted.status).toBe('needed')
    expect(halted.state).toContain('3 сбоя подряд')
    expect(halted.codes).toEqual(['COMPUTER_USE_VM_UNAVAILABLE'])
    expect(step(view, 'platforms')).toMatchObject({ status: 'done' })
    expect(step(view, 'platforms').state).toContain('kwork.ru')
    expect(step(view, 'auto-proposals')).toMatchObject({ status: 'done' })
    // No live key in the test environment: the stored error is shown only once a key exists.
    expect(step(view, 'bybit-live-key')).toMatchObject({
      status: 'needed',
      state: 'Ключ реального счёта не внесён.',
    })
    expect(step(view, 'live-trading')).toMatchObject({ status: 'blocked', required: false })
    expect(view.done).toBe(
      view.groups.flatMap((g) => g.steps).filter((s) => s.required && s.status === 'done').length,
    )
  })
})
