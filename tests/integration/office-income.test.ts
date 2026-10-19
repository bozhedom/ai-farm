import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { claimJob, enqueue, finishJob } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { createOrder } from '../../core/orders'
import { ensurePortfolios } from '../../core/trading/store'
import { units } from '../../core/trading/decimal'
import security from '../../server/middleware/security'
import income from '../../server/api/office/income.get'
import type { OfficeIncome } from '../../core/contracts/overview'
import { applyMigrations, resetDatabase } from './helpers/db'

let server: Server
let base = ''

beforeAll(async () => {
  await applyMigrations()
  const app = createApp()
  app.use(security)
  const router = createRouter()
  router.get('/api/office/income', income)
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

const get = async (cookie?: string) => {
  const response = await fetch(base + '/api/office/income', {
    headers: cookie ? { cookie: `farm_session=${cookie}` } : {},
  })
  return { status: response.status, json: (await response.json()) as OfficeIncome }
}
const raw = (value: string) => units(value).toString()

async function seedTrading() {
  await ensurePortfolios()
  await query(
    "UPDATE trading_portfolios SET status='running',started_at=now()-interval '2 days',heartbeat=now() WHERE exchange='bybit' AND mode='paper'",
  )
  const agent = randomUUID()
  await query(
    `INSERT INTO trading_agents(id,exchange,mode,name,symbol,kind,params,generation,initial_cash,cash,peak,realized,round_trips)
     VALUES($1,'bybit','paper','Тест · 1','BTC-USDT','trend','{}',1,$2,$2,$2,$3,2)`,
    [agent, raw('100'), raw('2.797')],
  )
  const order = (side: string, qty: string, quote: string, fee: string, ago: string) =>
    query(
      `INSERT INTO trading_orders(id,exchange,mode,agent_id,client_id,symbol,side,qty,price,status,reason,filled_qty,quote,quote_fee,created_at,settled_at)
       VALUES($1,'bybit','paper',$2,$3,'BTC-USDT',$4,$5,$6,'filled','TEST',$5,$7,$8,now()-$9::interval,now()-$9::interval)`,
      [
        randomUUID(),
        agent,
        randomUUID().replaceAll('-', '').slice(0, 30),
        side,
        raw(qty),
        raw('50000'),
        raw(quote),
        `-${raw(fee)}`,
        ago,
      ],
    )
  // Bought 3 days ago, one winning and one losing sell, the second today.
  await order('buy', '0.002', '100', '0.1', '3 days')
  await order('sell', '0.001', '55', '0.055', '2 days')
  await order('sell', '0.001', '48', '0.048', '1 minute')
  await query(
    "INSERT INTO trading_equity(exchange,mode,at,equity,cash,exposure) VALUES('bybit','paper',now()-interval '2 days',$1,$1,0),('bybit','paper',now(),$2,$2,0)",
    [raw('104.795'), raw('102.797')],
  )
}

async function seedTestOrderAndSpend() {
  await enqueue('research', 'income-order', { templates: JSON.stringify(['description']) })
  const job = (await claimJob(['research']))!
  await runJob(job)
  await finishJob(job)
  await query("UPDATE products SET visibility='public', published_at=now()")
  const [product] = await query('SELECT id,price_kopecks FROM products')
  const order = await createOrder(
    product!.id,
    'Керамическая кружка 350 мл. Белая глазурь, ручная работа. Мыть вручную.',
    randomUUID(),
  )
  await query('UPDATE orders SET paid_at=now() WHERE id=$1', [order.id])
  await query(
    `INSERT INTO budget_reservations(id,dedupe_key,category,limit_kopecks,spent_kopecks,status)
     VALUES(gen_random_uuid(),'income-spend','research',4000,1234,'closed')`,
  )
  await query(
    `INSERT INTO tool_calls(id,call_key,reservation_id,role,status,reserved_kopecks,charged_kopecks,is_demo)
     SELECT gen_random_uuid(),'income-call',id,'search','done',1234,1234,false FROM budget_reservations
     WHERE dedupe_key='income-spend'`,
  )
  return product!.price_kopecks as number
}

describe('office income overview', () => {
  it('requires the owner session', async () => {
    expect((await get()).status).toBe(401)
  })

  it('aggregates money, trading and directions without mixing test and real results', async () => {
    await seedTrading()
    const price = await seedTestOrderAndSpend()
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    const { status, json: v } = await get(session)
    expect(status).toBe(200)

    // Rubles: a sandbox payment is never revenue; net counts only real money minus spend.
    for (const period of ['today', 'week', 'month'] as const) {
      expect(v.periods[period]).toMatchObject({
        realOrdersKopecks: 0,
        testPaymentsKopecks: price,
        spendKopecks: 1234,
        netKopecks: -1234,
        liveTradingUsdt: '0',
      })
    }
    // Paper trading: today only the second (losing) sell, the week has both.
    expect(v.periods.today.paperTradingUsdt).toBe('-2.098')
    expect(v.periods.week.paperTradingUsdt).toBe('2.797')
    expect(v.allTime.paperTradingUsdt).toBe('2.797')
    expect(v.allTime.realOrdersKopecks).toBe(0)

    const bybit = v.trading.find((r) => r.exchange === 'bybit' && r.mode === 'paper')!
    expect(bybit).toMatchObject({ trades30d: 2, wins30d: 1, realized: '2.797', status: 'running' })
    expect(v.equity).toEqual([
      expect.objectContaining({ exchange: 'bybit', mode: 'paper', points: expect.any(Array) }),
    ])
    expect(v.equity[0]!.points.at(-1)!.equity).toBe('102.797')
    expect(v.agents.best[0]).toMatchObject({ name: 'Тест · 1', realized: '2.797', roundTrips: 2 })

    const source = (id: string) => v.sources.find((s) => s.id === id)!
    expect(source('trading:bybit')).toMatchObject({
      mode: 'paper',
      result: { unit: 'USDT', test: true },
    })
    expect(source('computer')).toMatchObject({ status: 'needs_human', result: null })
    expect(source('services').mode).toBe('test')
    expect(v.sources.map((s) => s.id)).toEqual(
      expect.arrayContaining(['manager', 'execution:arbitrage', 'execution:prediction', 'scouts']),
    )

    expect(v.funnel).toMatchObject({ orders: 1, publicProducts: 1, paidReal: 0 })
    expect(v.products[0]!.priceKopecks).toBe(price)
    expect(v.priceList).toContain(price)
    expect(v.daily).toHaveLength(30)
    expect(v.daily.at(-1)).toMatchObject({ realKopecks: 0, testKopecks: price, spendKopecks: 1234 })
    expect(v.strategies).toEqual([{ exchange: 'bybit', mode: 'paper', kind: 'trend', count: 1 }])
    expect(
      v.feed.some((f) => f.kind === 'trade_test' && /Bybit · Тренировка: продал BTC/.test(f.text)),
    ).toBe(true)
    expect(v.needsHuman.map((n) => n.id)).toEqual(
      expect.arrayContaining(['keys:bybit', 'live-disabled', 'computer', 'openrouter']),
    )
  })
})
