import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import { config } from '../../core/config'
import { configureExecution, controlExecution, executionTick } from '../../core/execution/engine'
import { createArbitrageDriver } from '../../core/execution/drivers/arbitrage'
import { createSpotAdapter, executionSpotVenue } from '../../core/execution/adapters/spot'
import { ensureExecution, portfolio } from '../../core/execution/store'
import type {
  ExecutionLeg,
  ExecutionOperation,
  ExecutionPortfolio,
} from '../../core/execution/types'
import { cost, decimal, fee, floorStep, units } from '../../core/trading/decimal'
import { listing } from '../../core/trading/universe'
import type {
  Account,
  Market,
  OrderRequest,
  OrderResult,
  TradingSymbol,
  TradingVenue,
} from '../../core/trading/types'
import { applyMigrations, resetDatabase } from './helpers/db'

class PrefundedVenue implements TradingVenue {
  bid: bigint
  ask: bigint
  buyBaseFee = 0n
  feeBps = 10
  sellFraction = 1n
  loseAcknowledgement = false
  hideReceipt = false
  foreignOrder = false
  placed: OrderRequest[] = []
  fills = new Map<string, OrderResult>()
  balances: Account['balances'] = {
    USDT: { total: units('300'), available: units('300') },
    BTC: { total: units('2'), available: units('2') },
  }
  constructor(
    public identity: string,
    price: string,
  ) {
    this.bid = units(price)
    this.ask = this.bid + units('0.01')
  }
  async discover() {
    return listing(
      'BTC',
      'USDT',
      'BTCUSDT',
      { active: true },
      {
        at: Date.now(),
        bid: decimal(this.bid),
        ask: decimal(this.ask),
        last: decimal(this.bid),
        open: decimal(this.bid),
        high: decimal((this.bid * 105n) / 100n),
        low: decimal((this.bid * 95n) / 100n),
        turnover: '10000000',
      },
    )
  }
  async market(symbol: TradingSymbol): Promise<Market> {
    return {
      instrument: {
        symbol,
        lot: units('0.0001'),
        minQty: units('0.0001'),
        tick: units('0.01'),
        minNotional: units('5'),
      },
      book: {
        symbol,
        at: Date.now(),
        bids: [[this.bid, units('100')]],
        asks: [[this.ask, units('100')]],
      },
      candles: [],
    }
  }
  async account(symbols: readonly TradingSymbol[]): Promise<Account> {
    return {
      identity: this.identity,
      balances: this.balances,
      feeBps: Object.fromEntries(symbols.map((symbol) => [symbol, this.feeBps])),
    }
  }
  async pending() {
    return this.foreignOrder ? [{ clientId: 'foreign-order' }] : []
  }
  async place(request: OrderRequest) {
    this.placed.push(request)
    const price = request.side === 'buy' ? this.ask : this.bid
    const qty =
      request.side === 'sell'
        ? floorStep(request.qty / this.sellFraction, units('0.0001'))
        : request.qty
    const gross = cost(qty, price)
    const baseFee = request.side === 'buy' ? -this.buyBaseFee : 0n
    const quoteFee = baseFee ? 0n : -fee(gross, this.feeBps)
    const fill: OrderResult = {
      ...request,
      exchangeId: `remote-${request.clientId}`,
      state: qty === request.qty ? 'filled' : 'canceled',
      filledQty: qty,
      quote: gross,
      baseFee,
      quoteFee,
    }
    this.fills.set(request.clientId, fill)
    this.balances.BTC!.total += (request.side === 'buy' ? qty : -qty) + baseFee
    this.balances.USDT.total += (request.side === 'buy' ? -gross : gross) + quoteFee
    this.balances.BTC!.available = this.balances.BTC!.total
    this.balances.USDT.available = this.balances.USDT.total
    if (this.loseAcknowledgement) throw new Error('TRADING_NETWORK_UNAVAILABLE')
  }
  async order(request: OrderRequest) {
    return this.hideReceipt ? null : this.fills.get(request.clientId) || null
  }
  async cancel() {}
}

let buy: PrefundedVenue
let sell: PrefundedVenue
const factory = (p: ExecutionPortfolio) => createArbitrageDriver(p.mode, { okx: buy, bybit: sell })
const settings = {
  buyExchange: 'okx',
  sellExchange: 'bybit',
  symbols: ['BTC-USDT'],
  minEdgeBps: 20,
}
async function activate(mode: 'paper' | 'demo' = 'demo') {
  await configureExecution({ track: 'arbitrage', mode, capital: '1000', settings })
  await controlExecution('arbitrage', mode, 'start', factory)
}
async function operations() {
  return query<ExecutionOperation>(
    "SELECT * FROM execution_operations WHERE track='arbitrage' ORDER BY created_at",
  )
}
async function legs() {
  return query<ExecutionLeg>('SELECT * FROM execution_legs ORDER BY created_at,sequence')
}
async function tick(count = 1) {
  for (let i = 0; i < count; i++) await executionTick(factory)
}

beforeAll(applyMigrations)
beforeEach(async () => {
  await resetDatabase()
  await ensureExecution()
  buy = new PrefundedVenue('arbitrage-okx-account', '100')
  sell = new PrefundedVenue('arbitrage-bybit-account', '102')
  vi.stubEnv(
    'EXECUTION_ARBITRAGE_ASSETS',
    JSON.stringify([
      { symbol: 'BTC-USDT', identity: 'bitcoin-native', exchanges: ['okx', 'bybit'] },
    ]),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(async () => pool.end())

describe('prefunded arbitrage execution', () => {
  it('records both initial asset inventories and their basis, without buying or transferring them', async () => {
    await activate()
    const rows = await query<{
      venue: string
      snapshot: { usdt: string; assets: { quantity: string; price: string }[] }
    }>('SELECT * FROM execution_accounts ORDER BY venue')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.snapshot.usdt)).toEqual(['300', '300'])
    expect(rows.map((row) => row.snapshot.assets[0]!.quantity)).toEqual(['2', '2'])
    expect(buy.placed).toHaveLength(0)
    expect(sell.placed).toHaveLength(0)
    expect(
      await factory(await portfolio('arbitrage', 'demo')).equity!(
        await portfolio('arbitrage', 'demo'),
      ),
    ).toBe('1000')
  })

  it('runs a two-exchange cycle, preserves global inventory and books only net cash profit', async () => {
    await activate()
    await tick(3)
    const [op] = await operations()
    const p = await portfolio('arbitrage', 'demo')
    expect(op!.status).toBe('closed')
    expect(buy.placed).toHaveLength(1)
    expect(sell.placed).toHaveLength(1)
    expect(buy.balances.BTC!.total + sell.balances.BTC!.total).toBe(units('4'))
    const profit = buy.balances.USDT.total + sell.balances.USDT.total - units('600')
    expect(profit).toBeGreaterThan(0n)
    expect(units(op!.pnl)).toBe(profit)
    expect(units(p.realized)).toBe(profit)
    expect(units(p.cash)).toBe(units('1000') + profit)
    expect(units(p.fees)).toBeGreaterThan(0n)
    expect(p.status).toBe('running')
    expect(p.reason).toBe('')
    expect((await legs()).map((item) => item.prepared.intent.venue)).toEqual(['okx', 'bybit'])
  })

  it('reserves each leg commission independently when the buy venue charges more', async () => {
    buy.feeBps = 30
    sell.feeBps = 5
    await activate()
    await tick(3)
    expect((await operations())[0]!.status).toBe('closed')
    expect((await portfolio('arbitrage', 'demo')).status).toBe('running')
    expect(buy.placed).toHaveLength(1)
    expect(sell.placed).toHaveLength(1)
    const profit = buy.balances.USDT.total + sell.balances.USDT.total - units('600')
    expect(profit).toBeGreaterThan(0n)
    expect(units((await operations())[0]!.pnl)).toBe(profit)
  })

  it('hedges only the net acquired base after a buy commission in the coin', async () => {
    buy.buyBaseFee = units('0.0001')
    await activate()
    await tick(3)
    expect((await operations())[0]!.status).toBe('closed')
    expect(sell.placed[0]!.qty).toBe(buy.placed[0]!.qty - units('0.0001'))
    expect(buy.balances.BTC!.total + sell.balances.BTC!.total).toBe(units('4'))
  })

  it('compensates a partial sale on the buy venue and closes the exact remaining global exposure', async () => {
    sell.sellFraction = 2n
    await activate()
    await tick(4)
    expect((await operations())[0]!.status).toBe('closed')
    expect((await legs()).map((item) => item.role)).toEqual(['buy', 'sell', 'compensate'])
    expect(buy.placed.map((item) => item.side)).toEqual(['buy', 'sell'])
    expect(sell.placed).toHaveLength(1)
    expect(buy.balances.BTC!.total + sell.balances.BTC!.total).toBe(units('4'))
  })

  it('reconciles an accepted order after a lost response and process restart without a duplicate buy', async () => {
    buy.loseAcknowledgement = true
    buy.hideReceipt = true
    await activate()
    await tick()
    expect((await legs())[0]!.state).toBe('unknown')
    expect((await portfolio('arbitrage', 'demo')).status).toBe('attention')
    buy.hideReceipt = false
    await tick(3)
    expect((await operations())[0]!.status).toBe('closed')
    expect(buy.placed).toHaveLength(1)
    expect(sell.placed).toHaveLength(1)
  })

  it('marks prefunded inventory to market and stops before opening an arbitrage after an inventory loss', async () => {
    await activate()
    buy.bid = units('50')
    buy.ask = units('50.01')
    sell.bid = units('52')
    sell.ask = units('52.01')
    await tick()
    const p = await portfolio('arbitrage', 'demo')
    expect(p.status).toBe('stopped')
    expect(p.reason).toBe('EXECUTION_INVENTORY_LOSS_STOP')
    expect(units(p.equity)).toBe(units('800'))
    expect(await operations()).toHaveLength(0)
    expect(buy.placed).toHaveLength(0)
  })

  it('detects an account identity change between the pair legs before another private write', async () => {
    await activate()
    await tick()
    sell.identity = 'different-private-account'
    await tick()
    expect((await portfolio('arbitrage', 'demo')).reason).toBe('EXECUTION_ACCOUNT_CHANGED')
    expect(sell.placed).toHaveLength(0)
    expect(await legs()).toHaveLength(1)
  })

  it('refuses foreign assets, locked holdings and unverified token identity at activation', async () => {
    buy.balances.DOGE = { total: units('1'), available: units('1') }
    await expect(activate()).rejects.toThrow('EXECUTION_FOREIGN_ASSET')
    delete buy.balances.DOGE
    buy.balances.USDT.available -= 1n
    await expect(activate()).rejects.toThrow('EXECUTION_ACCOUNT_DRIFT')
    buy.balances.USDT.available = buy.balances.USDT.total
    vi.stubEnv('EXECUTION_ARBITRAGE_ASSETS', '[]')
    await expect(activate()).rejects.toThrow('EXECUTION_ASSET_REGISTRY_REQUIRED')
  })

  it('rejects manual balance drift after the first fill instead of selling unrelated funds', async () => {
    await activate()
    await tick()
    sell.balances.BTC!.total += units('1')
    sell.balances.BTC!.available = sell.balances.BTC!.total
    await tick()
    expect((await portfolio('arbitrage', 'demo')).reason).toBe('EXECUTION_ACCOUNT_DRIFT')
    expect(sell.placed).toHaveLength(0)
  })

  it('keeps mode ledgers and simulated inventory independent', async () => {
    await activate('paper')
    await tick(3)
    expect((await operations())[0]!.mode).toBe('paper')
    expect((await operations())[0]!.status).toBe('closed')
    expect((await portfolio('arbitrage', 'demo')).started_at).toBeNull()
    expect(buy.placed).toHaveLength(0)
    expect(sell.placed).toHaveLength(0)
    expect(buy.balances.BTC!.total + sell.balances.BTC!.total).toBe(units('4'))
  })
})

describe('separate spot execution credentials and persisted orders', () => {
  it('uses execution-scoped credentials while leaving old spot-trading keys and gates alone', async () => {
    const original = {
      key: config().BYBIT_DEMO_API_KEY,
      secret: config().BYBIT_DEMO_SECRET,
      live: config().TRADING_LIVE_ENABLED,
    }
    Object.assign(config(), {
      BYBIT_DEMO_API_KEY: 'legacy-key',
      BYBIT_DEMO_SECRET: 'legacy-secret',
      TRADING_LIVE_ENABLED: false,
    })
    vi.stubEnv('EXECUTION_ARBITRAGE_BYBIT_DEMO_API_KEY', 'execution-key')
    vi.stubEnv('EXECUTION_ARBITRAGE_BYBIT_DEMO_SECRET', 'execution-secret')
    const clientId = randomUUID().replaceAll('-', '')
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ retCode: 0, result: { orderId: 'test-order', orderLinkId: clientId } }),
        ),
      )
    try {
      await executionSpotVenue('bybit', 'demo').place({
        clientId,
        symbol: 'BTC-USDT',
        side: 'buy',
        qty: units('0.1'),
        price: units('100'),
      })
      expect(fetcher).toHaveBeenCalledOnce()
      expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>)['X-BAPI-API-KEY']).toBe(
        'execution-key',
      )
      expect(String(fetcher.mock.calls[0]![0])).toContain('api-demo.bybit.com')
      expect(config().BYBIT_DEMO_API_KEY).toBe('legacy-key')
    } finally {
      Object.assign(config(), {
        BYBIT_DEMO_API_KEY: original.key,
        BYBIT_DEMO_SECRET: original.secret,
        TRADING_LIVE_ENABLED: original.live,
      })
    }
  })

  it('binds a prepared order to the exact account and key scope across adapter restarts', async () => {
    const intent = {
      clientId: 'bound-order',
      venue: 'okx' as const,
      action: 'buy' as const,
      symbol: 'BTC-USDT',
      quantity: '0.1',
      limitPrice: '100.01',
      quoteBudget: '11',
      positionQuantity: '0',
      expiresAt: Date.now() + 60_000,
    }
    const prepared = await createSpotAdapter(buy, 'okx', 'demo').prepare(intent)
    buy.identity = 'replacement-account'
    await expect(createSpotAdapter(buy, 'okx', 'demo').broadcast(prepared)).rejects.toThrow(
      'EXECUTION_ACCOUNT_CHANGED',
    )
    expect(buy.placed).toHaveLength(0)
    buy.identity = 'arbitrage-okx-account'
    vi.stubEnv('EXECUTION_ARBITRAGE_OKX_DEMO_API_KEY', 'different-key')
    await expect(createSpotAdapter(buy, 'okx', 'demo').lookup(prepared)).rejects.toThrow(
      'EXECUTION_ACCOUNT_CHANGED',
    )
  })
})
