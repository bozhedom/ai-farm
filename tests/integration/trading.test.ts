import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { config } from '../../core/config'
import { listing } from '../../core/trading/universe'
import { cost, decimal, units } from '../../core/trading/decimal'
import { paperFill } from '../../core/trading/accounting'
import {
  controlTrading,
  resolveMissingOrder,
  startTrading,
  tradingTick,
  stopAllTrading,
  resumeDailyLoss,
  verifyTradingKeys,
} from '../../core/trading/engine'
import {
  agents,
  allocateLive,
  scope,
  ensurePortfolios,
  paperCandidates,
  pendingOrder,
  portfolio,
  configurePaperStrategies,
} from '../../core/trading/store'
import { tradingOverview } from '../../core/trading/overview'
import { exchanges, type TradingScope, type TradingExchange } from '../../core/trading/types'
import { tradingView } from '../../core/trading/view'
import type {
  Account,
  OrderRequest,
  OrderResult,
  TradingSymbol,
  TradingVenue,
} from '../../core/trading/types'
import { market } from '../fixtures/trading'
import { classicState } from '../../core/trading/classic'
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
  accountError = ''
  identity = 'isolated-test-account'
  balances: Account['balances'] = {
    USDT: { total: units('100'), available: units('100') },
    BTC: { total: 0n, available: 0n },
    ETH: { total: 0n, available: 0n },
  }
  symbols: TradingSymbol[] = ['BTC-USDT', 'ETH-USDT']
  async discover() {
    return this.symbols.flatMap((symbol) =>
      listing(
        symbol.slice(0, -5),
        'USDT',
        symbol,
        { active: true },
        {
          at: Date.now(),
          bid: '99.99',
          ask: '100',
          last: '100',
          open: '102',
          high: '105',
          low: '98',
          turnover: '10000000',
        },
      ),
    )
  }
  async market(symbol: TradingSymbol) {
    const m = market(symbol, this.price, this.reference)
    for (let i = 0; i < 30; i++) m.candles[i]!.close = (units(this.reference) * 102n) / 100n
    if (this.stale) m.book.at -= 60_000
    return m
  }
  async account(symbols: readonly TradingSymbol[]): Promise<Account> {
    if (this.accountError) throw new Error(this.accountError)
    return {
      identity: this.identity,
      balances: this.balances,
      feeBps: Object.fromEntries(symbols.map((s) => [s, 10])),
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
    const ccy = request.symbol.slice(0, -5)
    this.balances[ccy] ||= { total: 0n, available: 0n }
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
  it('does not report a planned budget as funds on an unconnected exchange', async () => {
    expect((await tradingView(scope('okx', 'live'))).metrics).toMatchObject({
      capital: '100',
      cash: '0',
      equity: '0',
      pnl: '0',
      drawdownBps: 0,
    })
    expect((await tradingView(scope('okx', 'paper'))).metrics).toMatchObject({
      capital: '100',
      cash: '100',
      equity: '100',
      pnl: '0',
    })
  })

  it('stops every portfolio without waiting for exchange access', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await stopAllTrading()
    await tick()
    expect(exchange.placed).toHaveLength(0)
    for (const mode of ['paper', 'demo', 'live'] as const)
      expect(await portfolio(scope('okx', mode))).toMatchObject({
        status: 'stopped',
        reason: 'OWNER_STOP',
      })
  })

  it('does not use past realized profit to hide losses in an open paper position', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    const [a] = await agents(scope('okx', 'paper'))
    await query(
      "UPDATE trading_agents SET created_at=now()-interval '8 days',round_trips=20,realized=$2,cash=$3,base=$4,basis=$5 WHERE id=$1",
      [
        a!.id,
        units('1').toString(),
        units('15').toString(),
        units('0.09').toString(),
        units('11').toString(),
      ],
    )
    expect(await paperCandidates('okx')).toHaveLength(0)
    await query('UPDATE trading_agents SET cash=$2,base=0,basis=0 WHERE id=$1', [
      a!.id,
      units('26').toString(),
    ])
    expect(await paperCandidates('okx')).toHaveLength(1)
  })
  it('starts paper with four agents, executes signals and keeps test profit out of revenue', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    await tick()
    expect(await agents(scope('okx', 'paper'))).toHaveLength(4)
    const orders = await query("SELECT * FROM trading_orders WHERE mode='paper'")
    expect(orders).toHaveLength(2)
    expect(orders.every((o) => o.status === 'filled')).toBe(true)
    expect(exchange.placed).toHaveLength(0)
    exchange.price = '103'
    exchange.reference = '103'
    await noCooldown()
    await tick()
    expect((await agents(scope('okx', 'paper'))).filter((a) => a.round_trips === 1)).toHaveLength(2)
    expect(await query('SELECT * FROM orders')).toHaveLength(0)
    expect((await query('SELECT count(*)::int AS n FROM trading_equity'))[0]!.n).toBe(2)
  })

  it('fences two workers and idempotent owner starts before external submission', async () => {
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await Promise.all([tradingTick(factory), tradingTick(factory)])
    expect(exchange.placed).toHaveLength(1)
    expect(await agents(scope('okx', 'demo'))).toHaveLength(1)
    expect(await pendingOrder(scope('okx', 'demo'))).toMatchObject({ status: 'submitted' })
    await tick()
    await tick()
    expect(exchange.placed).toHaveLength(1)
    expect(await pendingOrder(scope('okx', 'demo'))).toBeUndefined()
    expect((await agents(scope('okx', 'demo')))[0]!.cash).toBe(
      exchange.balances.USDT.total.toString(),
    )
  })

  it('recovers an accepted order whose response was lost without buying twice', async () => {
    exchange.loseResponse = true
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await tick()
    expect(await portfolio(scope('okx', 'demo'))).toMatchObject({
      status: 'stopped',
      reason: 'TRADING_ORDER_UNKNOWN',
    })
    expect(await pendingOrder(scope('okx', 'demo'))).toMatchObject({ status: 'unknown' })
    await tick()
    await tick()
    expect(exchange.placed).toHaveLength(1)
    expect(await pendingOrder(scope('okx', 'demo'))).toBeUndefined()
    expect((await agents(scope('okx', 'demo')))[0]!.base).toBe(
      exchange.balances.BTC.total.toString(),
    )
    expect(await portfolio(scope('okx', 'demo'))).toMatchObject({ status: 'stopped' })
  })

  it('keeps a missing submission blocked until explicit verified review; never reuses its ID', async () => {
    exchange.loseRequest = true
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await tick()
    await tick()
    const pending = (await pendingOrder(scope('okx', 'demo')))!
    expect(exchange.placed).toHaveLength(1)
    await expect(startTrading(scope('okx', 'demo'), '', false, factory)).rejects.toThrow(
      'TRADING_ORDER_UNKNOWN',
    )
    await expect(
      resolveMissingOrder(scope('okx', 'demo'), pending.client_id, '', factory),
    ).rejects.toThrow('TRADING_CONFIRMATION_REQUIRED')
    await query("UPDATE trading_orders SET created_at=now()-interval '2 minutes' WHERE id=$1", [
      pending.id,
    ])
    await resolveMissingOrder(
      scope('okx', 'demo'),
      pending.client_id,
      'ПРОВЕРЕНО НА БИРЖЕ',
      factory,
    )
    exchange.loseRequest = false
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await noCooldown()
    await tick()
    expect(exchange.placed).toHaveLength(2)
    expect(exchange.placed[1]!.clientId).not.toBe(pending.client_id)
    expect(await query("SELECT * FROM trading_events WHERE kind='manual_review'")).toHaveLength(1)
  })

  it('discards a prepared intent after restart without sending it to the exchange', async () => {
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await controlTrading(scope('okx', 'demo'), 'stop')
    const [a] = await agents(scope('okx', 'demo'))
    await query(
      `INSERT INTO trading_orders(id,mode,agent_id,client_id,symbol,side,qty,price,status,reason)
      VALUES ($1,'demo',$2,'preparedonly','BTC-USDT','buy',$3,$4,'prepared','TEST')`,
      [randomUUID(), a!.id, units('0.01').toString(), units('100').toString()],
    )
    await tick()
    expect(exchange.placed).toHaveLength(0)
    expect(await pendingOrder(scope('okx', 'demo'))).toBeUndefined()
    expect(
      (await query("SELECT reason FROM trading_orders WHERE client_id='preparedonly'"))[0]!.reason,
    ).toBe('NOT_SENT')
  })

  it('refuses stale prices, manual orders, balance drift and a different account', async () => {
    exchange.stale = true
    await expect(startTrading(scope('okx', 'demo'), '', false, factory)).rejects.toThrow(
      'TRADING_STALE_MARKET',
    )
    exchange.stale = false
    exchange.foreignOrder = true
    await expect(startTrading(scope('okx', 'demo'), '', false, factory)).rejects.toThrow(
      'TRADING_EXTERNAL_ORDERS',
    )
    exchange.foreignOrder = false
    await startTrading(scope('okx', 'demo'), '', false, factory)
    exchange.balances.USDT.total -= units('1')
    exchange.balances.USDT.available -= units('1')
    await tick()
    expect(await portfolio(scope('okx', 'demo'))).toMatchObject({
      status: 'stopped',
      check_error: 'TRADING_BALANCE_DRIFT',
    })
    expect(exchange.placed).toHaveLength(0)
    exchange.identity = 'different-account'
    await expect(startTrading(scope('okx', 'demo'), '', false, factory)).rejects.toThrow(
      'TRADING_ACCOUNT_CHANGED',
    )
  })

  it('pauses entries, sells existing holdings on flatten and completes a demo round trip', async () => {
    await startTrading(scope('okx', 'demo'), '', true, factory)
    await tick()
    await tick()
    await tick()
    await tick()
    expect(exchange.placed.map((o) => o.side)).toEqual(['buy', 'sell'])
    expect(await portfolio(scope('okx', 'demo'))).toMatchObject({
      status: 'paused',
      reason: 'DEMO_PROBE_COMPLETE',
      demo_probe: false,
    })
    expect((await agents(scope('okx', 'demo')))[0]!.round_trips).toBe(1)
    expect(Number(decimal(exchange.balances.USDT.total))).toBeLessThan(100)
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await noCooldown()
    await tick()
    await tick()
    await controlTrading(scope('okx', 'demo'), 'flatten')
    await tick()
    await tick()
    expect(exchange.balances.BTC.total).toBe(0n)
    expect(await portfolio(scope('okx', 'demo'))).toMatchObject({
      status: 'paused',
      reason: 'OWNER_EXIT',
    })
  })

  it('locks daily loss and total drawdown without allowing pause/resume to reset the peak', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    await tick()
    exchange.price = '80'
    exchange.reference = '80'
    await tick()
    expect(await portfolio(scope('okx', 'paper'))).toMatchObject({
      status: 'paused',
      reason: 'DAILY_LOSS_LIMIT',
    })
    await expect(startTrading(scope('okx', 'paper'), '', false, factory)).rejects.toThrow(
      'TRADING_DAILY_LOCKED',
    )
    await query("UPDATE trading_portfolios SET peak=$1 WHERE mode='paper'", [
      units('200').toString(),
    ])
    await expect(startTrading(scope('okx', 'paper'), '', false, factory)).rejects.toThrow(
      'TRADING_DRAWDOWN_LOCKED',
    )
  })

  it('keeps portfolio loss protection active while the owner has paused new entries', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    await tick()
    await controlTrading(scope('okx', 'paper'), 'pause')
    // An earlier daily mark was higher; individual positions have not reached their stop.
    await query("UPDATE trading_portfolios SET day_equity=$1 WHERE mode='paper'", [
      units('103').toString(),
    ])
    await tick()
    expect(await portfolio(scope('okx', 'paper'))).toMatchObject({
      status: 'paused',
      reason: 'DAILY_LOSS_LIMIT',
    })
    expect((await agents(scope('okx', 'paper'))).every((a) => BigInt(a.base) === 0n)).toBe(true)
    expect(
      await query("SELECT * FROM trading_orders WHERE side='sell' AND reason='RISK_EXIT'"),
    ).toHaveLength(2)
    await tick()
    expect(await query("SELECT * FROM trading_events WHERE kind='risk'")).toHaveLength(1)
  })

  /** Moves the daily-loss pause into the previous UTC day, as if midnight had passed. */
  async function nextUtcDay(mode = 'paper') {
    await query(
      "UPDATE trading_events SET created_at=created_at - interval '1 day' WHERE mode=$1 AND kind IN ('risk','start','pause','flatten','stop','demo')",
      [mode],
    )
    await query("UPDATE trading_portfolios SET risk_day='2000-01-01' WHERE mode=$1", [mode])
  }

  it('resumes a paper daily-loss pause at the next UTC day with an audit event', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    await tick()
    exchange.price = '80'
    exchange.reference = '80'
    await tick()
    expect(await portfolio(scope('okx', 'paper'))).toMatchObject({
      status: 'paused',
      reason: 'DAILY_LOSS_LIMIT',
    })
    // Still the same UTC day: the pause holds.
    await tick()
    expect((await portfolio(scope('okx', 'paper'))).status).toBe('paused')
    const peak = (await portfolio(scope('okx', 'paper'))).peak
    await nextUtcDay()
    await tick()
    expect(await portfolio(scope('okx', 'paper'))).toMatchObject({
      status: 'running',
      reason: '',
      peak,
    })
    expect(await query("SELECT mode,reason FROM trading_events WHERE kind='auto_resume'")).toEqual([
      { mode: 'paper', reason: 'DAILY_LOSS_RESET' },
    ])
  })

  it('never clears an owner pause, a drawdown lock or a live daily-loss pause', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    await tick()
    await controlTrading(scope('okx', 'paper'), 'pause')
    await query("UPDATE trading_portfolios SET day_equity=$1 WHERE mode='paper'", [
      units('103').toString(),
    ])
    await tick()
    expect((await portfolio(scope('okx', 'paper'))).reason).toBe('DAILY_LOSS_LIMIT')
    await nextUtcDay()
    await tick()
    expect(await portfolio(scope('okx', 'paper'))).toMatchObject({
      status: 'paused',
      reason: 'OWNER_PAUSE',
    })
    expect(await query("SELECT reason FROM trading_events WHERE kind='auto_resume'")).toEqual([
      { reason: 'DAILY_LOSS_RESET_PAUSE_KEPT' },
    ])

    // A legacy risk event without metadata still restores the owner's earlier exit.
    await startTrading(scope('bybit', 'paper'), '', false, factory)
    await tick()
    await controlTrading(scope('bybit', 'paper'), 'flatten')
    await query(
      "UPDATE trading_portfolios SET status='paused',reason='DAILY_LOSS_LIMIT' WHERE exchange='bybit' AND mode='paper'",
    )
    await query(
      "INSERT INTO trading_events(exchange,mode,kind,reason,data,created_at) VALUES ('bybit','paper','risk','DAILY_LOSS_LIMIT','{}',now() + interval '1 second')",
    )
    await nextUtcDay()
    await tick()
    expect(await portfolio(scope('bybit', 'paper'))).toMatchObject({
      status: 'paused',
      reason: 'OWNER_EXIT',
    })

    // Drawdown from the peak keeps the portfolio paused on the next day.
    await startTrading(scope('bitget', 'paper'), '', false, factory)
    await tick()
    exchange.price = '80'
    exchange.reference = '80'
    await tick()
    expect((await portfolio(scope('bitget', 'paper'))).reason).toBe('DAILY_LOSS_LIMIT')
    await query("UPDATE trading_portfolios SET peak=$1 WHERE exchange='bitget' AND mode='paper'", [
      units('200').toString(),
    ])
    await nextUtcDay()
    await tick()
    expect(await portfolio(scope('bitget', 'paper'))).toMatchObject({
      status: 'paused',
      reason: 'DRAWDOWN_LIMIT',
    })

    // Live keeps manual resume even on a new day.
    await query(
      "UPDATE trading_portfolios SET status='paused',reason='DAILY_LOSS_LIMIT' WHERE exchange='binance' AND mode='live'",
    )
    await query(
      "INSERT INTO trading_events(exchange,mode,kind,reason,data,created_at) VALUES ('binance','live','risk','DAILY_LOSS_LIMIT','{}',now() - interval '2 days')",
    )
    const live = await portfolio(scope('binance', 'live'))
    await resumeDailyLoss(live, new Date().toISOString().slice(0, 10), pool)
    expect(await portfolio(scope('binance', 'live'))).toMatchObject({
      status: 'paused',
      reason: 'DAILY_LOSS_LIMIT',
    })
  })

  it('checks configured keys hourly with reads only and persists the result', async () => {
    const c = config()
    const saved = { key: c.BYBIT_LIVE_API_KEY, secret: c.BYBIT_LIVE_SECRET }
    c.BYBIT_LIVE_API_KEY = 'test-live-key'
    c.BYBIT_LIVE_SECRET = 'test-live-secret'
    try {
      const live = scope('bybit', 'live')
      expect((await portfolio(live)).checked_at).toBeNull()
      expect(await verifyTradingKeys(factory)).toContain('bybit:live')
      expect(await portfolio(live)).toMatchObject({
        check_error: '',
        started_at: null,
        account_identity: null,
        status: 'idle',
      })
      expect((await portfolio(live)).checked_at).not.toBeNull()
      expect(exchange.placed).toEqual([])
      // Within the hour nothing is checked again.
      expect(await verifyTradingKeys(factory)).not.toContain('bybit:live')

      exchange.accountError = 'TRADING_KEY_PERMISSIONS'
      const later = Date.now() + 2 * 3_600_000
      await verifyTradingKeys(factory, () => false, later)
      expect((await portfolio(live)).check_error).toBe('TRADING_KEY_PERMISSIONS')
      await verifyTradingKeys(factory, () => false, later + 2 * 3_600_000)
      expect(
        await query(
          "SELECT reason FROM trading_events WHERE exchange='bybit' AND mode='live' AND kind='connection' ORDER BY created_at",
        ),
      ).toEqual([{ reason: 'CONNECTION_OK' }, { reason: 'TRADING_KEY_PERMISSIONS' }])
      expect(exchange.placed).toEqual([])
      expect(await query('SELECT id FROM trading_orders')).toEqual([])
    } finally {
      c.BYBIT_LIVE_API_KEY = saved.key
      c.BYBIT_LIVE_SECRET = saved.secret
    }
  })

  it('requires independent live opt-in, a demo round trip and mature profitable paper evidence', async () => {
    await expect(
      startTrading(scope('okx', 'live'), 'ТОРГОВАТЬ 100 USDT НА OKX', false, factory),
    ).rejects.toThrow('TRADING_LIVE_DISABLED')
    const c = config()
    c.TRADING_LIVE_ENABLED = true
    try {
      await expect(startTrading(scope('okx', 'live'), '', false, factory)).rejects.toThrow(
        'TRADING_CONFIRMATION_REQUIRED',
      )
      await expect(
        startTrading(scope('okx', 'live'), 'ТОРГОВАТЬ 100 USDT НА OKX', false, factory),
      ).rejects.toThrow('TRADING_DEMO_REQUIRED')
      await startTrading(scope('okx', 'demo'), '', true, factory)
      await tick()
      await tick()
      await tick()
      await tick()
      await expect(
        startTrading(scope('okx', 'live'), 'ТОРГОВАТЬ 100 USDT НА OKX', false, factory),
      ).rejects.toThrow('TRADING_PAPER_REQUIRED')
    } finally {
      c.TRADING_LIVE_ENABLED = false
    }
    expect(await agents(scope('okx', 'live'))).toHaveLength(0)
  })

  it.each([20, 100, 1000])(
    'starts one live agent with a %i USDT budget and an independent account ledger',
    async (budget) => {
      await allocateLive({ okx: budget, bybit: 0, binance: 0, bitget: 0 })
      await startTrading(scope('okx', 'demo'), '', true, factory)
      await tick()
      await tick()
      await tick()
      await tick()
      await startTrading(scope('okx', 'paper'), '', false, factory)
      const proven = (await agents(scope('okx', 'paper'))).find((a) => a.kind === 'reversion')!
      await query(
        "UPDATE trading_agents SET created_at=now()-interval '8 days',round_trips=20,realized=$2,cash=$3 WHERE id=$1",
        [proven.id, units('1').toString(), units('26').toString()],
      )
      const live = new Exchange()
      live.identity = 'live-test-account'
      const separate = (s: { mode: string }) => (s.mode === 'live' ? live : exchange)
      const c = config()
      c.TRADING_LIVE_ENABLED = true
      try {
        const confirmation = `ТОРГОВАТЬ ${budget} USDT НА OKX`
        if (budget !== 100) {
          await expect(
            startTrading(scope('okx', 'live'), 'ТОРГОВАТЬ 100 USDT НА OKX', false, separate),
          ).rejects.toThrow('TRADING_CONFIRMATION_REQUIRED')
        }
        live.balances.USDT = {
          total: units(String(budget - 1)),
          available: units(String(budget - 1)),
        }
        await expect(
          startTrading(scope('okx', 'live'), confirmation, false, separate),
        ).rejects.toThrow('TRADING_INSUFFICIENT_FUNDS')
        expect(await agents(scope('okx', 'live'))).toHaveLength(0)
        live.balances.USDT = { total: units(String(budget)), available: units(String(budget)) }
        await startTrading(scope('okx', 'live'), confirmation, false, separate)
        const [a] = await agents(scope('okx', 'live'))
        expect(a).toMatchObject({
          parent_id: proven.id,
          initial_cash: units(String(budget)).toString(),
          cash: units(String(budget)).toString(),
          round_trips: 0,
        })
        await tradingTick(separate)
        expect(live.placed).toHaveLength(1)
        expect(cost(live.placed[0]!.qty, live.placed[0]!.price)).toBeLessThanOrEqual(units('10'))
        expect(exchange.placed).toHaveLength(2)
        await query('UPDATE trading_portfolios SET last_tick=NULL')
        await tradingTick(separate)
        expect((await agents(scope('okx', 'live')))[0]!.cash).toBe(
          live.balances.USDT.total.toString(),
        )
      } finally {
        c.TRADING_LIVE_ENABLED = false
      }
    },
  )

  it('archives a complete paper generation, clones the two leaders and preserves the capital', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    exchange.price = '102'
    exchange.reference = '102'
    const team = await agents(scope('okx', 'paper'))
    for (let i = 0; i < 4; i++) {
      await query(
        "UPDATE trading_agents SET created_at=now()-interval '8 days',round_trips=20,realized=$2,cash=$3 WHERE id=$1",
        [team[i]!.id, units(String(4 - i)).toString(), units(String(29 - i)).toString()],
      )
    }
    await tick()
    const children = await agents(scope('okx', 'paper'))
    expect(children).toHaveLength(4)
    expect(new Set(children.map((a) => a.parent_id)).size).toBe(2)
    expect(children.every((a) => a.round_trips === 0 && a.realized === '0')).toBe(true)
    expect(children.reduce((sum, a) => sum + BigInt(a.cash), 0n)).toBe(units('110'))
    expect(await query("SELECT * FROM trading_agents WHERE status='archived'")).toHaveLength(4)
    await tick()
    expect(await query('SELECT * FROM trading_agents')).toHaveLength(8)
    expect(await portfolio(scope('okx', 'paper'))).toMatchObject({ generation: 2 })
    expect(await paperCandidates('okx')).toHaveLength(4)
  })

  it('promotes a stronger paper leader into the flat live account without resetting losses or limits', async () => {
    await startTrading(scope('okx', 'demo'), '', true, factory)
    await tick()
    await tick()
    await tick()
    await tick()
    exchange.reference = '100'
    await startTrading(scope('okx', 'paper'), '', false, factory)
    const [first, better] = (await agents(scope('okx', 'paper'))).filter(
      (a) => a.kind === 'reversion',
    )
    await query(
      "UPDATE trading_agents SET created_at=now()-interval '8 days',round_trips=20,realized=$2,cash=$3 WHERE id=$1",
      [first!.id, units('1').toString(), units('26').toString()],
    )
    const live = new Exchange()
    live.identity = 'live-promotion-account'
    live.reference = '100'
    const separate = (s: { mode: string }) => (s.mode === 'live' ? live : exchange)
    const c = config()
    c.TRADING_LIVE_ENABLED = true
    try {
      await startTrading(scope('okx', 'live'), 'ТОРГОВАТЬ 100 USDT НА OKX', false, separate)
      const [original] = await agents(scope('okx', 'live'))
      await query('UPDATE trading_agents SET cash=$2,realized=$3 WHERE id=$1', [
        original!.id,
        units('99').toString(),
        units('-1').toString(),
      ])
      live.balances.USDT = { total: units('99'), available: units('99') }
      await query(
        "UPDATE trading_agents SET created_at=now()-interval '8 days',round_trips=20,realized=$2,cash=$3 WHERE id=$1",
        [better!.id, units('2').toString(), units('27').toString()],
      )
      await query('UPDATE trading_portfolios SET last_tick=NULL')
      await tradingTick(separate)
      const [next] = await agents(scope('okx', 'live'))
      expect(next).toMatchObject({
        parent_id: better!.id,
        cash: units('99').toString(),
        generation: 2,
        realized: '0',
      })
      expect(next!.id).not.toBe(original!.id)
      expect(await portfolio(scope('okx', 'live'))).toMatchObject({
        capital: units('100').toString(),
        peak: units('100').toString(),
        day_equity: units('100').toString(),
      })
      expect((await tradingView(scope('okx', 'live'))).metrics).toMatchObject({
        equity: '99',
        pnl: '-1',
        realized: '-1',
      })
      expect(
        await query("SELECT * FROM trading_agents WHERE mode='live' AND status='archived'"),
      ).toHaveLength(1)
      expect(live.placed).toHaveLength(0)
    } finally {
      c.TRADING_LIVE_ENABLED = false
    }
  })
})

describe('multiple independent exchanges', () => {
  it('runs all four paper portfolios with separate agents, ledgers and prices', async () => {
    const venues = Object.fromEntries(
      exchanges.map((e, i) => {
        const v = new Exchange()
        v.price = String(100 + i)
        v.reference = String(102 + i)
        return [e, v]
      }),
    ) as Record<TradingExchange, Exchange>
    const own = (s: TradingScope) => venues[s.exchange]
    await Promise.all(exchanges.map((e) => startTrading(scope(e, 'paper'), '', false, own)))
    await tradingTick(own)
    for (const e of exchanges) {
      const view = await tradingView(scope(e, 'paper'))
      expect(view.exchange).toBe(e)
      expect(view.agents).toHaveLength(4)
      expect(view.orders).toHaveLength(2)
      expect(view.markets.find((m) => m.symbol === 'BTC-USDT')!.ask).toBe(venues[e].price)
      const ownIds = new Set((await agents(scope(e, 'paper'))).map((a) => a.id))
      const rows = await query('SELECT * FROM trading_orders WHERE exchange=$1', [e])
      expect(rows.every((o) => ownIds.has(o.agent_id))).toBe(true)
      expect(venues[e].placed).toHaveLength(0)
    }
    const summary = await tradingOverview('paper')
    expect(summary.connections.map((c) => c.activeAgents)).toEqual([4, 4, 4, 4])
    expect(units(summary.equity)).toBeGreaterThan(units('399'))
    expect((await tradingOverview('live')).equity).toBe('0')
    expect(await query('SELECT * FROM orders')).toHaveLength(0)
  })

  it('keeps one unknown order isolated while the other exchange settles normally', async () => {
    const other = new Exchange()
    other.identity = 'bybit-demo'
    const own = (s: TradingScope) => (s.exchange === 'okx' ? exchange : other)
    await startTrading(scope('okx', 'demo'), '', false, own)
    await startTrading(scope('bybit', 'demo'), '', false, own)
    exchange.loseRequest = true
    await tradingTick(own)
    expect(await pendingOrder(scope('okx', 'demo'))).toMatchObject({ status: 'unknown' })
    expect(await pendingOrder(scope('bybit', 'demo'))).toMatchObject({ status: 'submitted' })
    await query('UPDATE trading_portfolios SET last_tick=NULL')
    await tradingTick(own)
    expect(await portfolio(scope('bybit', 'demo'))).toMatchObject({
      status: 'running',
      check_error: '',
    })
    expect(await pendingOrder(scope('bybit', 'demo'))).toBeUndefined()
    expect(exchange.placed).toHaveLength(1)
    expect(other.placed).toHaveLength(1)
    const all = await query('SELECT client_id FROM trading_orders')
    expect(new Set(all.map((o) => o.client_id)).size).toBe(2)
    await controlTrading(scope('bybit', 'demo'), 'stop')
    expect(await portfolio(scope('okx', 'demo'))).toMatchObject({ reason: 'TRADING_ORDER_UNKNOWN' })
  })

  it('continues other exchanges while one public feed fails', async () => {
    const other = new Exchange(),
      own = (s: TradingScope) => (s.exchange === 'okx' ? exchange : other)
    await startTrading(scope('okx', 'paper'), '', false, own)
    await startTrading(scope('bybit', 'paper'), '', false, own)
    exchange.stale = true
    await tradingTick(own)
    expect(await portfolio(scope('okx', 'paper'))).toMatchObject({
      check_error: 'TRADING_STALE_MARKET',
    })
    expect(await portfolio(scope('bybit', 'paper'))).toMatchObject({ check_error: '' })
    expect((await tradingView(scope('okx', 'paper'))).orders).toHaveLength(0)
    expect((await tradingView(scope('bybit', 'paper'))).orders).toHaveLength(2)
    await stopAllTrading()
    expect(
      (
        await query(
          "SELECT * FROM trading_portfolios WHERE status='stopped' AND reason='OWNER_STOP'",
        )
      ).length,
    ).toBe(12)
  })

  it('allows later cycles on a fast exchange while another lane is still waiting', async () => {
    const other = new Exchange(),
      own = (s: TradingScope) => (s.exchange === 'okx' ? exchange : other)
    other.identity = 'independent-bybit-demo'
    await startTrading(scope('okx', 'demo'), '', false, own)
    await startTrading(scope('bybit', 'demo'), '', false, own)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const account = exchange.account.bind(exchange)
    exchange.account = async (symbols) => {
      await gate
      return account(symbols)
    }
    let done = false
    const slow = tradingTick(own, () => false, ['okx']).finally(() => {
      done = true
    })
    try {
      await tradingTick(own, () => false, ['bybit'])
      expect(done).toBe(false)
      expect(await pendingOrder(scope('bybit', 'demo'))).toMatchObject({ status: 'submitted' })
      await query("UPDATE trading_portfolios SET last_tick=NULL WHERE exchange='bybit'")
      await tradingTick(own, () => false, ['bybit'])
      expect(await pendingOrder(scope('bybit', 'demo'))).toBeUndefined()
      expect(done).toBe(false)
    } finally {
      release()
      await slow
    }
  })

  it('rejects cross-exchange orders and ancestry at the database boundary', async () => {
    await startTrading(scope('okx', 'paper'), '', false, factory)
    const [a] = await agents(scope('okx', 'paper'))
    await expect(
      query(
        `INSERT INTO trading_orders(id,exchange,mode,agent_id,client_id,symbol,side,qty,price,status,reason) VALUES($1,'bybit','paper',$2,'crossvenue','BTC-USDT','buy',1,1,'prepared','test')`,
        [randomUUID(), a!.id],
      ),
    ).rejects.toMatchObject({ code: '23503' })
    await startTrading(scope('bybit', 'paper'), '', false, factory)
    const [b] = await agents(scope('bybit', 'paper'))
    await expect(
      query('UPDATE trading_agents SET parent_id=$2 WHERE id=$1', [b!.id, a!.id]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('allocates one total real budget atomically and preserves active risk history', async () => {
    expect((await tradingOverview('live')).allocated).toBe('100')
    await allocateLive({ okx: 500, bybit: 1500, binance: 0, bitget: 0 })
    expect((await tradingOverview('live')).allocated).toBe('2000')
    await expect(allocateLive({ okx: 25, bybit: 10, binance: 0, bitget: 0 })).rejects.toThrow(
      'TRADING_ALLOCATION_INVALID',
    )
    await expect(allocateLive({ okx: 25.5, bybit: 0, binance: 0, bitget: 0 })).rejects.toThrow(
      'TRADING_ALLOCATION_INVALID',
    )
    const plans = [
      { okx: 50, bybit: 1500, binance: 0, bitget: 0 },
      { okx: 0, bybit: 0, binance: 500, bitget: 1050 },
    ]
    await Promise.all(plans.map(allocateLive))
    const view = await tradingOverview('live')
    expect(view.allocated).toBe('1550')
    expect(plans).toContainEqual(
      Object.fromEntries(view.connections.map((c) => [c.exchange, Number(c.liveAllocation)])),
    )
    await allocateLive({ okx: 25, bybit: 25, binance: 25, bitget: 25 })
    await query(
      "UPDATE trading_portfolios SET started_at=now(),peak=$1,reason='DRAWDOWN_LIMIT' WHERE exchange='bybit' AND mode='live'",
      [units('27').toString()],
    )
    await expect(allocateLive({ okx: 20, bybit: 30, binance: 25, bitget: 25 })).rejects.toThrow(
      'TRADING_ALLOCATION_LOCKED',
    )
    // The earlier OKX update must roll back together with the failed Bybit update.
    expect(await portfolio(scope('okx', 'live'))).toMatchObject({ capital: units('25').toString() })
    expect(await portfolio(scope('bybit', 'live'))).toMatchObject({
      capital: units('25').toString(),
      peak: units('27').toString(),
      reason: 'DRAWDOWN_LIMIT',
    })
  })

  it('keeps large allocations exact without funding or starting other portfolios', async () => {
    await allocateLive({
      okx: Number.MAX_SAFE_INTEGER,
      bybit: Number.MAX_SAFE_INTEGER,
      binance: 20,
      bitget: 21,
    })
    const view = await tradingOverview('live')
    expect(view.allocated).toBe('18014398509482023')
    expect(view.equity).toBe('0')
    expect(await portfolio(scope('okx', 'live'))).toMatchObject({
      capital: units('9007199254740991').toString(),
      started_at: null,
    })
    for (const venue of exchanges) {
      expect(await portfolio(scope(venue, 'paper'))).toMatchObject({
        capital: units('100').toString(),
      })
      expect(await portfolio(scope(venue, 'demo'))).toMatchObject({
        capital: units('100').toString(),
      })
    }
    expect(await query('SELECT id FROM trading_agents')).toHaveLength(0)
    expect(await query('SELECT id FROM trading_orders')).toHaveLength(0)
    for (const invalid of [-1, 19, 20.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      await expect(allocateLive({ okx: invalid, bybit: 0, binance: 0, bitget: 0 })).rejects.toThrow(
        'TRADING_ALLOCATION_INVALID',
      )
    }
    for (const invalid of [-1n, units('9007199254740992')]) {
      await expect(
        query("UPDATE trading_portfolios SET capital=$1 WHERE exchange='okx' AND mode='live'", [
          invalid.toString(),
        ]),
      ).rejects.toMatchObject({ code: '23514' })
    }
    expect((await tradingOverview('live')).allocated).toBe('18014398509482023')
  })

  it('requires paper evidence and a demo round trip on the same exchange', async () => {
    const bybitDemo = new Exchange()
    bybitDemo.identity = 'independent-bybit-demo'
    await allocateLive({ okx: 25, bybit: 25, binance: 25, bitget: 25 })
    await startTrading(scope('okx', 'paper'), '', false, factory)
    const [a] = await agents(scope('okx', 'paper'))
    await query(
      "UPDATE trading_agents SET created_at=now()-interval '8 days',round_trips=20,realized=$2,cash=$3 WHERE id=$1",
      [a!.id, units('1').toString(), units('26').toString()],
    )
    await startTrading(scope('okx', 'demo'), '', false, factory)
    await query("UPDATE trading_agents SET round_trips=1 WHERE exchange='okx' AND mode='demo'")
    expect(await paperCandidates('okx')).toHaveLength(1)
    expect(await paperCandidates('bybit')).toHaveLength(0)
    config().TRADING_LIVE_ENABLED = true
    try {
      await expect(
        startTrading(scope('bybit', 'live'), 'ТОРГОВАТЬ 25 USDT НА BYBIT', false, factory),
      ).rejects.toThrow('TRADING_DEMO_REQUIRED')
      await startTrading(scope('bybit', 'demo'), '', false, () => bybitDemo)
      await query("UPDATE trading_agents SET round_trips=1 WHERE exchange='bybit' AND mode='demo'")
      await expect(
        startTrading(scope('bybit', 'live'), 'ТОРГОВАТЬ 25 USDT НА BYBIT', false, factory),
      ).rejects.toThrow('TRADING_PAPER_REQUIRED')
      const live = new Exchange()
      live.identity = 'allocated-okx-live'
      await expect(
        startTrading(scope('okx', 'live'), 'ТОРГОВАТЬ 25 USDT НА BYBIT', false, () => live),
      ).rejects.toThrow('TRADING_CONFIRMATION_REQUIRED')
      await startTrading(scope('okx', 'live'), 'ТОРГОВАТЬ 25 USDT НА OKX', false, () => live)
      expect((await agents(scope('okx', 'live')))[0]!.cash).toBe(units('25').toString())
      expect(await portfolio(scope('okx', 'live'))).toMatchObject({
        quote_offset: units('75').toString(),
      })
      await expect(allocateLive({ okx: 0, bybit: 50, binance: 25, bitget: 25 })).rejects.toThrow(
        'TRADING_ALLOCATION_LOCKED',
      )
    } finally {
      config().TRADING_LIVE_ENABLED = false
    }
  })
})

describe('dynamic coin selection', () => {
  const paper = scope('okx', 'paper')
  async function expireScan() {
    await query("UPDATE trading_scouts SET attempted_at=now()-interval '6 minutes'")
  }
  async function idleAssignments() {
    await query(
      "UPDATE trading_agents SET assigned_at=now()-interval '7 hours',last_order_at=NULL WHERE status='active'",
    )
  }

  it('runs strategies and exact reconciliation for assets outside the original pair list', async () => {
    exchange.symbols = ['PEPE-USDT', 'SOL-USDT']
    await startTrading(paper, '', false, factory)
    expect(new Set((await agents(paper)).map((a) => a.symbol))).toEqual(new Set(exchange.symbols))
    await startTrading(scope('okx', 'demo'), '', true, factory)
    await tick()
    await tick()
    await tick()
    await tick()
    expect(exchange.placed.map((o) => o.symbol)).toEqual(['PEPE-USDT', 'PEPE-USDT'])
    expect(exchange.balances.PEPE!.total).toBe(0n)
    expect((await portfolio(scope('okx', 'demo'))).reason).toBe('DEMO_PROBE_COMPLETE')
    expect(await query('SELECT * FROM trading_assignments')).toHaveLength(5)
  })

  it('eventually inspects lower-ranked coins without losing coverage of assigned pairs', async () => {
    exchange.price = '102'
    exchange.symbols = Array.from(
      { length: 24 },
      (_, i) => `COIN${String(i).padStart(2, '0')}-USDT` as TradingSymbol,
    )
    await startTrading(paper, '', false, factory)
    const [first] = await query(
      "SELECT coins FROM trading_scouts WHERE exchange='okx' AND mode='paper'",
    )
    expect(first!.coins.filter((c: { inspectedAt: number | null }) => c.inspectedAt).length).toBe(
      12,
    )
    await expireScan()
    await tick()
    const [second] = await query(
      "SELECT coins FROM trading_scouts WHERE exchange='okx' AND mode='paper'",
    )
    expect(
      second!.coins.filter((c: { inspectedAt: number | null }) => c.inspectedAt).length,
    ).toBeGreaterThan(12)
    for (const a of await agents(paper))
      expect(second!.coins.find((c: { symbol: string }) => c.symbol === a.symbol).eligible).toBe(
        true,
      )
  })

  it('rotates idle flat agents and preserves their cash, fees and performance history', async () => {
    exchange.price = '102'
    await startTrading(paper, '', false, factory)
    const before = await agents(paper)
    await query("UPDATE trading_agents SET realized=$1,fees=$2,round_trips=3 WHERE mode='paper'", [
      units('0.3').toString(),
      units('0.1').toString(),
    ])
    await idleAssignments()
    exchange.symbols = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'PEPE-USDT']
    await expireScan()
    await tick()
    const after = await agents(paper)
    expect(after.some((a) => ['SOL-USDT', 'PEPE-USDT'].includes(a.symbol))).toBe(true)
    for (const a of after) {
      expect(a.cash).toBe(before.find((b) => b.id === a.id)!.cash)
      expect(a.realized).toBe(units('0.3').toString())
      expect(a.fees).toBe(units('0.1').toString())
      expect(a.round_trips).toBe(3)
    }
    expect(
      (await query("SELECT * FROM trading_assignments WHERE reason='SCOUT_IDLE_ROTATION'")).length,
    ).toBeGreaterThan(0)
    expect(await query('SELECT * FROM trading_orders')).toHaveLength(0)
  })

  it('keeps held coins after removal from the catalogue, then exits by age before changing the pair', async () => {
    await startTrading(paper, '', false, factory)
    await tick()
    const holding = (await agents(paper)).filter((a) => BigInt(a.base) > 0n)
    expect(holding).toHaveLength(2)
    exchange.symbols = ['PEPE-USDT', 'SOL-USDT']
    await idleAssignments()
    await expireScan()
    await tick()
    for (const a of holding)
      expect((await agents(paper)).find((b) => b.id === a.id)!.symbol).toBe(a.symbol)
    await query(
      "UPDATE trading_agents SET position_opened_at=now()-interval '25 hours',selector_version='fixed-v1' WHERE base>0",
    )
    await tick()
    const sales = await query("SELECT * FROM trading_orders WHERE side='sell'")
    expect(sales).toHaveLength(2)
    expect(sales.every((o) => o.reason === 'SCOUT_TIME_EXIT')).toBe(true)
    expect((await agents(paper)).every((a) => a.base === '0')).toBe(true)
    await tick()
    for (const a of holding)
      expect(exchange.symbols).toContain(
        (await agents(paper)).find((b) => b.parent_id === a.id)!.symbol,
      )
    expect((await tradingView(paper)).metrics.fees).not.toBe('0')
  })

  it('preserves the last report on failure, blocks new buys and still closes existing positions', async () => {
    await startTrading(paper, '', false, factory)
    await tick()
    const [before] = await query(
      'SELECT coins,scanned_at FROM trading_scouts WHERE exchange=$1 AND mode=$2',
      ['okx', 'paper'],
    )
    exchange.discover = async () => {
      throw new Error('TRADING_NETWORK_UNAVAILABLE')
    }
    await expireScan()
    await noCooldown()
    exchange.price = '104'
    await tick()
    const [after] = await query('SELECT * FROM trading_scouts WHERE exchange=$1 AND mode=$2', [
      'okx',
      'paper',
    ])
    expect(after!.coins).toEqual(before!.coins)
    expect(after!.scanned_at).toEqual(before!.scanned_at)
    expect(after!.error).toBe('TRADING_NETWORK_UNAVAILABLE')
    expect(await query("SELECT * FROM trading_orders WHERE side='sell'")).toHaveLength(2)
    const count = (await query('SELECT * FROM trading_orders')).length
    exchange.price = '100'
    await noCooldown()
    await tick()
    expect(await query('SELECT * FROM trading_orders')).toHaveLength(count)
  })

  it('holds cash when the complete catalogue has no candidates without fabricating a loss', async () => {
    const original = exchange.discover.bind(exchange)
    exchange.discover = async () =>
      (await original()).map((c) => ({ ...c, turnover: units('100') }))
    await startTrading(paper, '', false, factory)
    await tick()
    expect(await agents(paper)).toHaveLength(0)
    expect((await tradingView(paper)).metrics).toMatchObject({
      equity: '100',
      cash: '100',
      pnl: '0',
    })
    expect((await portfolio(paper)).status).toBe('running')
    exchange.discover = original
    await expireScan()
    await tick()
    expect(await agents(paper)).toHaveLength(4)
  })

  it('does not rotate paused agents or erase dust that the exchange cannot sell', async () => {
    exchange.price = '102'
    await startTrading(paper, '', false, factory)
    const [a] = await agents(paper)
    await query('UPDATE trading_agents SET base=1,basis=1 WHERE id=$1', [a!.id])
    await idleAssignments()
    exchange.symbols = ['PEPE-USDT', 'SOL-USDT']
    await expireScan()
    await tick()
    expect((await agents(paper)).find((b) => b.id === a!.id)).toMatchObject({
      symbol: a!.symbol,
      base: '1',
      basis: '1',
      last_signal: 'SCOUT_DUST_POSITION',
    })
    await controlTrading(paper, 'pause')
    const before = await agents(paper)
    await idleAssignments()
    await expireScan()
    await tick()
    expect((await agents(paper)).map((a) => a.symbol)).toEqual(before.map((a) => a.symbol))
  })

  it('refuses unexpected altcoin holdings at first admission and after activation', async () => {
    exchange.balances.PEPE = { total: units('1'), available: units('1') }
    await expect(startTrading(scope('okx', 'demo'), '', false, factory)).rejects.toThrow(
      'TRADING_INITIAL_ASSETS',
    )
    exchange.balances.PEPE = { total: 0n, available: 0n }
    await startTrading(scope('okx', 'demo'), '', false, factory)
    exchange.balances.DOGE = { total: units('1'), available: units('1') }
    await tick()
    expect((await portfolio(scope('okx', 'demo'))).reason).toBe('TRADING_BALANCE_DRIFT')
    expect(exchange.placed).toHaveLength(0)
  })

  it('archives the old fixed-pair experiment before collecting evidence for the selector', async () => {
    exchange.price = '102'
    await startTrading(paper, '', false, factory)
    const team = await agents(paper)
    await query(
      "UPDATE trading_agents SET selector_version='fixed-v1',created_at=now()-interval '8 days',round_trips=20,realized=$1",
      [units('1').toString()],
    )
    expect(await paperCandidates('okx')).toHaveLength(0)
    await tick()
    const current = await agents(paper)
    expect(current).toHaveLength(4)
    expect(current.every((a) => a.selector_version === 'scout-v1' && a.round_trips === 0)).toBe(
      true,
    )
    expect(current.every((a) => team.some((p) => p.id === a.parent_id))).toBe(true)
    expect(await query("SELECT * FROM trading_agents WHERE status='archived'")).toHaveLength(4)
    expect(await paperCandidates('okx')).toHaveLength(0)
  })

  it('keeps an uncertain submission on its original symbol and rejects malformed database symbols', async () => {
    exchange.symbols = ['PEPE-USDT', 'SOL-USDT']
    exchange.loseRequest = true
    const demo = scope('okx', 'demo')
    await startTrading(demo, '', false, factory)
    await tick()
    const order = await pendingOrder(demo)
    await idleAssignments()
    exchange.symbols = ['BTC-USDT', 'ETH-USDT']
    await expireScan()
    await tick()
    expect((await agents(demo))[0]!.symbol).toBe(order!.symbol)
    expect(exchange.placed).toHaveLength(1)
    await expect(
      query("UPDATE trading_agents SET symbol='PEPE-USDT&foo=x' WHERE id=$1", [order!.agent_id]),
    ).rejects.toThrow()
  })
})

describe('classic strategy rollout and complete active balances', () => {
  const paper = scope('okx', 'paper')

  it('selects a paper preset without starting trading and persists bounded DCA fills', async () => {
    await configurePaperStrategies('okx', 'classic')
    expect(await portfolio(paper)).toMatchObject({ status: 'idle', strategy_preset: 'classic' })
    expect(await agents(paper)).toHaveLength(0)
    await startTrading(paper, '', false, factory)
    expect((await agents(paper)).map((a) => a.kind).sort()).toEqual([
      'dca',
      'grid',
      'reversion',
      'trend',
    ])
    await tick()
    const first = (await agents(paper)).find((a) => a.kind === 'dca')!
    expect(classicState(first).entries).toBe(1)
    expect(BigInt(first.basis)).toBeLessThanOrEqual(units('6.25'))
    await query(
      "UPDATE trading_agents SET last_order_at=NULL,strategy_state=jsonb_set(strategy_state,'{lastEntryAt}',to_jsonb($2::bigint)) WHERE id=$1",
      [first.id, Date.now() - 31 * 60_000],
    )
    await tick()
    const second = (await agents(paper)).find((a) => a.id === first.id)!
    expect(classicState(second).entries).toBe(2)
    expect(BigInt(second.basis)).toBeLessThanOrEqual(units('12.5'))
    await noCooldown()
    await tick()
    expect(classicState((await agents(paper)).find((a) => a.id === first.id)!).entries).toBe(2)
    expect(exchange.placed).toHaveLength(0)
    expect((await tradingView(paper)).strategyPreset).toEqual({
      selected: 'classic',
      pending: false,
      paperOnlyKinds: ['grid', 'dca'],
    })
  })

  it('archives flat replacements while deferring held ones and preserves portfolio risk', async () => {
    await startTrading(paper, '', false, factory)
    const team = await agents(paper)
    const held = team.find((a) => a.kind === 'breakout')!
    await query('UPDATE trading_agents SET base=$2,basis=$3,cash=$4 WHERE id=$1', [
      held.id,
      units('0.1').toString(),
      units('10').toString(),
      units('15').toString(),
    ])
    await query(
      "UPDATE trading_portfolios SET status='paused',reason='DAILY_LOSS_LIMIT',peak=$1 WHERE exchange='okx' AND mode='paper'",
      [units('102').toString()],
    )
    await configurePaperStrategies('okx', 'classic')
    let current = await agents(paper)
    expect(current.find((a) => a.id === held.id)).toMatchObject({
      kind: 'breakout',
      base: units('0.1').toString(),
    })
    expect(await portfolio(paper)).toMatchObject({
      status: 'paused',
      reason: 'DAILY_LOSS_LIMIT',
      peak: units('102').toString(),
      strategy_preset_pending: true,
    })
    expect(current.reduce((sum, a) => sum + BigInt(a.cash) + BigInt(a.basis), 0n)).toBe(
      units('100'),
    )
    await query('UPDATE trading_agents SET base=0,basis=0,cash=$2 WHERE id=$1', [
      held.id,
      units('25').toString(),
    ])
    await configurePaperStrategies('okx', 'classic')
    current = await agents(paper)
    expect(current.map((a) => a.kind).sort()).toEqual(['dca', 'grid', 'reversion', 'trend'])
    expect(current.find((a) => a.parent_id === held.id)).toBeDefined()
    expect(await portfolio(paper)).toMatchObject({
      status: 'paused',
      reason: 'DAILY_LOSS_LIMIT',
      strategy_preset_pending: false,
    })
    expect(await query("SELECT * FROM trading_agents WHERE status='archived'")).toHaveLength(2)
  })

  it('keeps a qualified classic experiment paper-only in the selector and the database', async () => {
    await configurePaperStrategies('okx', 'classic')
    await startTrading(paper, '', false, factory)
    const grid = (await agents(paper)).find((a) => a.kind === 'grid')!
    await query(
      "UPDATE trading_agents SET created_at=now()-interval '8 days',round_trips=20,realized=$2,cash=$3 WHERE id=$1",
      [grid.id, units('1').toString(), units('26').toString()],
    )
    expect(await paperCandidates('okx')).toHaveLength(0)
    expect((await tradingView(scope('okx', 'live'))).readiness).toMatchObject({
      paperQualified: false,
      paperOnlyCandidate: true,
    })
    await expect(
      query("UPDATE trading_agents SET mode='demo' WHERE id=$1", [grid.id]),
    ).rejects.toThrow()
  })

  it('keeps every active holding visible after more than one hundred archived experiments', async () => {
    await startTrading(paper, '', false, factory)
    await tick()
    const before = await tradingView(paper)
    const team = await agents(paper)
    for (let i = 0; i < 105; i++) {
      await query(
        `INSERT INTO trading_agents(id,exchange,mode,name,symbol,kind,params,status,generation,initial_cash,cash,peak)
        VALUES($1,'okx','paper','Archived','BTC-USDT','reversion',$2,'archived',100,$3,$3,$3)`,
        [randomUUID(), team[0]!.params, units('25').toString()],
      )
    }
    const after = await tradingView(paper)
    expect(after.agents.filter((a) => a.status === 'active')).toHaveLength(4)
    expect(after.agents.filter((a) => a.status === 'archived')).toHaveLength(100)
    expect(after.metrics.cash).toBe(before.metrics.cash)
    expect(after.metrics.exposure).toBe(before.metrics.exposure)
    expect(after.metrics.equity).toBe(before.metrics.equity)
  })

  it('exits an old DCA basket before considering another scheduled entry', async () => {
    await configurePaperStrategies('okx', 'classic')
    await startTrading(paper, '', false, factory)
    await tick()
    const dca = (await agents(paper)).find((a) => a.kind === 'dca')!
    await query(
      "UPDATE trading_agents SET last_order_at=NULL,position_opened_at=now()-interval '25 hours',strategy_state=jsonb_set(strategy_state,'{lastEntryAt}',to_jsonb($2::bigint)) WHERE id=$1",
      [dca.id, Date.now() - 31 * 60_000],
    )
    await tick()
    const after = (await agents(paper)).find((a) => a.id === dca.id)!
    expect(after.base).toBe('0')
    expect(after.round_trips).toBe(1)
    expect(after.last_signal).toBe('SCOUT_TIME_EXIT')
    expect(classicState(after).entries).toBe(0)
  })

  it('closes an aged grid basket even when its profitable partial lot is below the sale minimum', async () => {
    let thin = false
    const originalMarket = exchange.market.bind(exchange)
    exchange.market = async (symbol) => {
      const m = await originalMarket(symbol)
      m.instrument.minNotional = units('5')
      if (thin) m.book.asks[0]![1] = units('0.03')
      return m
    }
    await configurePaperStrategies('okx', 'classic')
    await startTrading(paper, '', false, factory)
    await tick()
    const grid = (await agents(paper)).find((a) => a.kind === 'grid')!
    exchange.price = '98.5'
    thin = true
    await noCooldown()
    await tick()
    const partial = (await agents(paper)).find((a) => a.id === grid.id)!
    expect(classicState(partial).tranches).toHaveLength(2)
    expect(classicState(partial).tranches[1]!.qty).toBe(units('0.03').toString())
    thin = false
    exchange.price = '100.15'
    await noCooldown()
    await tick()
    expect((await agents(paper)).find((a) => a.id === grid.id)!.last_signal).toBe(
      'GRID_LOT_BELOW_MINIMUM',
    )
    await query(
      "UPDATE trading_agents SET position_opened_at=now()-interval '25 hours',last_order_at=NULL WHERE id=$1",
      [grid.id],
    )
    await tick()
    const after = (await agents(paper)).find((a) => a.id === grid.id)!
    expect(after.base).toBe('0')
    expect(after.round_trips).toBe(1)
    expect(after.last_signal).toBe('SCOUT_TIME_EXIT')
    expect(classicState(after).tranches).toHaveLength(0)
  })
})
