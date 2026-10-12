import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { config } from '../../core/config'
import { decimal, units } from '../../core/trading/decimal'
import { paperFill } from '../../core/trading/accounting'
import {
  controlTrading,
  resolveMissingOrder,
  startTrading,
  tradingTick,
} from '../../core/trading/engine'
import { agents, ensurePortfolios, pendingOrder, portfolio } from '../../core/trading/store'
import type {
  Account,
  OrderRequest,
  OrderResult,
  TradingSymbol,
  TradingVenue,
} from '../../core/trading/types'
import { market } from '../fixtures/trading'
import { applyMigrations, resetDatabase } from './helpers/db'

class Exchange implements TradingVenue {
  price = '100'
  reference = '102'
  placed: OrderRequest[] = []
  fills = new Map<string, OrderResult>()
  loseResponse = false
  loseRequest = false
  stale = false
  foreignOrder = false
  identity = 'isolated-test-account'
  balances: Account['balances'] = {
    USDT: { total: units('100'), available: units('100') },
    BTC: { total: 0n, available: 0n },
    ETH: { total: 0n, available: 0n },
  }
  async market(symbol: TradingSymbol) {
    const m = market(symbol, this.price, this.reference)
    if (this.stale) m.book.at -= 60_000
    return m
  }
  async account(): Promise<Account> {
    return {
      identity: this.identity,
      balances: this.balances,
      feeBps: { 'BTC-USDT': 10, 'ETH-USDT': 10 },
    }
  }
  async pending() {
    return this.foreignOrder ? [{ clientId: 'somebody-else' }] : []
  }
  async place(request: OrderRequest) {
    this.placed.push(request)
    if (this.loseRequest) throw new Error('TRADING_NETWORK_UNAVAILABLE')
    const m = await this.market(request.symbol)
    const fill = paperFill(request, m.book, m.instrument.lot)
    this.fills.set(request.clientId, fill)
    const ccy = request.symbol === 'BTC-USDT' ? 'BTC' : 'ETH'
    this.balances[ccy].total += request.side === 'buy' ? fill.filledQty : -fill.filledQty
    this.balances.USDT.total += (request.side === 'buy' ? -fill.quote : fill.quote) + fill.quoteFee
    this.balances[ccy].available = this.balances[ccy].total
    this.balances.USDT.available = this.balances.USDT.total
    if (this.loseResponse) throw new Error('TRADING_NETWORK_UNAVAILABLE')
  }
  async order(request: OrderRequest) {
    return this.fills.get(request.clientId) || null
  }
  async cancel() {}
}
let exchange: Exchange
const factory = () => exchange
async function tick() {
  await query('UPDATE trading_portfolios SET last_tick=NULL')
  await tradingTick(factory)
}
async function noCooldown() {
  await query('UPDATE trading_agents SET last_order_at=NULL')
}

beforeAll(applyMigrations)
beforeEach(async () => {
  await resetDatabase()
  await ensurePortfolios()
  exchange = new Exchange()
})
afterAll(() => pool.end())

describe('durable trading lifecycle', () => {
  it('starts paper with four agents, executes signals and keeps test profit out of revenue', async () => {
    await startTrading('paper', '', false, factory)
    await tick()
    expect(await agents('paper')).toHaveLength(4)
    const orders = await query("SELECT * FROM trading_orders WHERE mode='paper'")
    expect(orders).toHaveLength(2)
    expect(orders.every((o) => o.status === 'filled')).toBe(true)
    expect(exchange.placed).toHaveLength(0)
    exchange.price = '103'
    exchange.reference = '103'
    await noCooldown()
    await tick()
    expect((await agents('paper')).filter((a) => a.round_trips === 1)).toHaveLength(2)
    expect(await query('SELECT * FROM orders')).toHaveLength(0)
    expect((await query('SELECT count(*)::int AS n FROM trading_equity'))[0]!.n).toBe(2)
  })

  it('fences two workers and idempotent owner starts before external submission', async () => {
    await startTrading('demo', '', false, factory)
    await startTrading('demo', '', false, factory)
    await Promise.all([tradingTick(factory), tradingTick(factory)])
    expect(exchange.placed).toHaveLength(1)
    expect(await agents('demo')).toHaveLength(1)
    expect(await pendingOrder('demo')).toMatchObject({ status: 'submitted' })
    await tick()
    await tick()
    expect(exchange.placed).toHaveLength(1)
    expect(await pendingOrder('demo')).toBeUndefined()
    expect((await agents('demo'))[0]!.cash).toBe(exchange.balances.USDT.total.toString())
  })

  it('recovers an accepted order whose response was lost without buying twice', async () => {
    exchange.loseResponse = true
    await startTrading('demo', '', false, factory)
    await tick()
    expect(await portfolio('demo')).toMatchObject({
      status: 'stopped',
      reason: 'TRADING_ORDER_UNKNOWN',
    })
    expect(await pendingOrder('demo')).toMatchObject({ status: 'unknown' })
    await tick()
    await tick()
    expect(exchange.placed).toHaveLength(1)
    expect(await pendingOrder('demo')).toBeUndefined()
    expect((await agents('demo'))[0]!.base).toBe(exchange.balances.BTC.total.toString())
    expect(await portfolio('demo')).toMatchObject({ status: 'stopped' })
  })

  it('keeps a missing submission blocked until explicit verified review; never reuses its ID', async () => {
    exchange.loseRequest = true
    await startTrading('demo', '', false, factory)
    await tick()
    await tick()
    const pending = (await pendingOrder('demo'))!
    expect(exchange.placed).toHaveLength(1)
    await expect(startTrading('demo', '', false, factory)).rejects.toThrow('TRADING_ORDER_UNKNOWN')
    await expect(resolveMissingOrder('demo', pending.client_id, '', factory)).rejects.toThrow(
      'TRADING_CONFIRMATION_REQUIRED',
    )
    await query("UPDATE trading_orders SET created_at=now()-interval '2 minutes' WHERE id=$1", [
      pending.id,
    ])
    await resolveMissingOrder('demo', pending.client_id, 'ПРОВЕРЕНО НА БИРЖЕ', factory)
    exchange.loseRequest = false
    await startTrading('demo', '', false, factory)
    await noCooldown()
    await tick()
    expect(exchange.placed).toHaveLength(2)
    expect(exchange.placed[1]!.clientId).not.toBe(pending.client_id)
    expect(await query("SELECT * FROM trading_events WHERE kind='manual_review'")).toHaveLength(1)
  })

  it('discards a prepared intent after restart without sending it to the exchange', async () => {
    await startTrading('demo', '', false, factory)
    await controlTrading('demo', 'stop')
    const [a] = await agents('demo')
    await query(
      `INSERT INTO trading_orders(id,mode,agent_id,client_id,symbol,side,qty,price,status,reason)
      VALUES ($1,'demo',$2,'preparedonly','BTC-USDT','buy',$3,$4,'prepared','TEST')`,
      [randomUUID(), a!.id, units('0.01').toString(), units('100').toString()],
    )
    await tick()
    expect(exchange.placed).toHaveLength(0)
    expect(await pendingOrder('demo')).toBeUndefined()
    expect(
      (await query("SELECT reason FROM trading_orders WHERE client_id='preparedonly'"))[0]!.reason,
    ).toBe('NOT_SENT')
  })

  it('refuses stale prices, manual orders, balance drift and a different account', async () => {
    exchange.stale = true
    await expect(startTrading('demo', '', false, factory)).rejects.toThrow('TRADING_STALE_MARKET')
    exchange.stale = false
    exchange.foreignOrder = true
    await expect(startTrading('demo', '', false, factory)).rejects.toThrow(
      'TRADING_EXTERNAL_ORDERS',
    )
    exchange.foreignOrder = false
    await startTrading('demo', '', false, factory)
    exchange.balances.USDT.total -= units('1')
    exchange.balances.USDT.available -= units('1')
    await tick()
    expect(await portfolio('demo')).toMatchObject({
      status: 'stopped',
      check_error: 'TRADING_BALANCE_DRIFT',
    })
    expect(exchange.placed).toHaveLength(0)
    exchange.identity = 'different-account'
    await expect(startTrading('demo', '', false, factory)).rejects.toThrow(
      'TRADING_ACCOUNT_CHANGED',
    )
  })

  it('pauses entries, sells existing holdings on flatten and completes a demo round trip', async () => {
    await startTrading('demo', '', true, factory)
    await tick()
    await tick()
    await tick()
    await tick()
    expect(exchange.placed.map((o) => o.side)).toEqual(['buy', 'sell'])
    expect(await portfolio('demo')).toMatchObject({
      status: 'paused',
      reason: 'DEMO_PROBE_COMPLETE',
      demo_probe: false,
    })
    expect((await agents('demo'))[0]!.round_trips).toBe(1)
    expect(Number(decimal(exchange.balances.USDT.total))).toBeLessThan(100)
    await startTrading('demo', '', false, factory)
    await noCooldown()
    await tick()
    await tick()
    await controlTrading('demo', 'flatten')
    await tick()
    await tick()
    expect(exchange.balances.BTC.total).toBe(0n)
    expect(await portfolio('demo')).toMatchObject({ status: 'paused', reason: 'OWNER_EXIT' })
  })

  it('locks daily loss and total drawdown without allowing pause/resume to reset the peak', async () => {
    await startTrading('paper', '', false, factory)
    await tick()
    exchange.price = '80'
    exchange.reference = '80'
    await tick()
    expect(await portfolio('paper')).toMatchObject({ status: 'paused', reason: 'DAILY_LOSS_LIMIT' })
    await expect(startTrading('paper', '', false, factory)).rejects.toThrow('TRADING_DAILY_LOCKED')
    await query("UPDATE trading_portfolios SET peak=$1 WHERE mode='paper'", [
      units('200').toString(),
    ])
    await expect(startTrading('paper', '', false, factory)).rejects.toThrow(
      'TRADING_DRAWDOWN_LOCKED',
    )
  })

  it('requires independent live opt-in, a demo round trip and mature profitable paper evidence', async () => {
    await expect(startTrading('live', 'ТОРГОВАТЬ 100 USDT', false, factory)).rejects.toThrow(
      'TRADING_LIVE_DISABLED',
    )
    const c = config()
    c.TRADING_LIVE_ENABLED = true
    try {
      await expect(startTrading('live', '', false, factory)).rejects.toThrow(
        'TRADING_CONFIRMATION_REQUIRED',
      )
      await expect(startTrading('live', 'ТОРГОВАТЬ 100 USDT', false, factory)).rejects.toThrow(
        'TRADING_DEMO_REQUIRED',
      )
      await startTrading('demo', '', true, factory)
      await tick()
      await tick()
      await tick()
      await tick()
      await expect(startTrading('live', 'ТОРГОВАТЬ 100 USDT', false, factory)).rejects.toThrow(
        'TRADING_PAPER_REQUIRED',
      )
    } finally {
      c.TRADING_LIVE_ENABLED = false
    }
    expect(await agents('live')).toHaveLength(0)
  })

  it('archives a complete paper generation, clones the two leaders and preserves the capital', async () => {
    await startTrading('paper', '', false, factory)
    exchange.price = '102'
    exchange.reference = '102'
    const team = await agents('paper')
    for (let i = 0; i < 4; i++) {
      await query(
        "UPDATE trading_agents SET created_at=now()-interval '8 days',round_trips=20,realized=$2,cash=$3 WHERE id=$1",
        [team[i]!.id, units(String(4 - i)).toString(), units(String(29 - i)).toString()],
      )
    }
    await tick()
    const children = await agents('paper')
    expect(children).toHaveLength(4)
    expect(new Set(children.map((a) => a.parent_id)).size).toBe(2)
    expect(children.every((a) => a.round_trips === 0 && a.realized === '0')).toBe(true)
    expect(children.reduce((sum, a) => sum + BigInt(a.cash), 0n)).toBe(units('110'))
    expect(await query("SELECT * FROM trading_agents WHERE status='archived'")).toHaveLength(4)
    await tick()
    expect(await query('SELECT * FROM trading_agents')).toHaveLength(8)
    expect(await portfolio('paper')).toMatchObject({ generation: 2 })
  })
})
