import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createPredictionDriver } from '../../core/execution/drivers/prediction'
import type { KalshiSettings } from '../../core/execution/adapters/kalshi'
import type {
  ExecutionLeg,
  ExecutionOperation,
  ExecutionPortfolio,
  ExecutionReceipt,
} from '../../core/execution/types'
import { units } from '../../core/trading/decimal'

const instant = Date.parse('2026-10-13T00:00:00Z')
const ticker = 'KXEXAMPLE-26OCT13-T100'
const market = {
  ticker,
  event_ticker: 'KXEXAMPLE-26OCT13',
  market_type: 'binary',
  status: 'active',
  open_time: new Date(instant - 10000).toISOString(),
  close_time: new Date(instant + 86400000).toISOString(),
  notional_value_dollars: '1.0000',
  price_ranges: [{ start: '0.0000', end: '1.0000', step: '0.0100' }],
}
const initialBook = {
  orderbook_fp: { yes_dollars: [['0.4900', '100.00']], no_dollars: [['0.5000', '100.00']] },
}
const portfolio: ExecutionPortfolio = {
  track: 'prediction',
  mode: 'paper',
  status: 'running',
  capital: '100',
  cash: '100',
  equity: '100',
  realized: '0',
  fees: '0',
  peak: '100',
  day_equity: '100',
  risk_day: '2026-10-13',
  reason: '',
  heartbeat: null,
  last_scan: null,
  started_at: null,
  close_requested: false,
  settings: {
    buyExchange: 'okx',
    sellExchange: 'bybit',
    symbols: [],
    minEdgeBps: 100,
    minFundingBps: 1,
    maxHoldHours: 24,
    predictionTicker: ticker,
    probabilityBps: 8000,
    outcome: 'yes',
  },
}
function harness() {
  let now = instant
  let currentMarket = { ...market }
  let book = structuredClone(initialBook)
  const transport = vi.fn<typeof fetch>().mockImplementation(async (raw, options = {}) => {
    const url = new URL(String(raw))
    expect(url.host).toBe('external-api.kalshi.com')
    expect(options.method).toBe('GET')
    expect(options.headers).not.toHaveProperty('KALSHI-ACCESS-KEY')
    if (url.pathname === `/trade-api/v2/markets/${ticker}`)
      return Response.json({ market: currentMarket })
    if (url.pathname === `/trade-api/v2/markets/${ticker}/orderbook`) return Response.json(book)
    throw new Error(`Unexpected private request ${url.pathname}`)
  })
  const driver = createPredictionDriver('paper', null, { transport, now: () => now })
  return {
    driver,
    transport,
    setNow: (n: number) => {
      now = n
    },
    setBook: (b: typeof book) => {
      book = b
    },
    setMarket: (patch: Record<string, unknown>) => {
      currentMarket = { ...currentMarket, ...patch }
    },
  }
}
function operation(): ExecutionOperation {
  return {
    id: 'operation-id',
    track: 'prediction',
    mode: 'paper',
    status: 'open',
    reserve: '1.2',
    pnl: '0',
    fees: '0',
    created_at: new Date(instant),
    closed_at: null,
    plan: {
      symbol: ticker,
      quantity: '2',
      entryPrice: '0.5',
      hedgePrice: '0',
      buyVenue: 'kalshi',
      sellVenue: 'kalshi',
      outcome: 'yes',
      rate: '0.8',
      nextPaymentAt: instant + 86400000,
      intervalMs: 0,
    },
  }
}
function leg(action: 'buy' | 'sell', quantity = '2', gross = '1', fees = '0.01'): ExecutionLeg {
  const receipt: ExecutionReceipt = {
    status: 'filled',
    externalId: `paper:${action}`,
    filledQuantity: quantity,
    grossQuote: gross,
    quoteFee: fees,
    baseFee: '0',
  }
  return {
    id: action,
    operation_id: 'operation-id',
    sequence: action === 'buy' ? 0 : 1,
    role: action,
    state: 'terminal',
    created_at: new Date(instant),
    receipt,
    prepared: {
      intent: {
        clientId: action,
        venue: 'kalshi',
        action,
        symbol: ticker,
        quantity,
        limitPrice: action === 'buy' ? '0.5' : '0.8',
        quoteBudget: '2',
        positionQuantity: action === 'buy' ? '0' : quantity,
        outcome: 'yes',
        expiresAt: instant + 5000,
      },
      externalId: receipt.externalId,
      payload: {},
    },
  }
}

describe('prediction execution driver', () => {
  it('selects an owner-valued opportunity with depth, both costs and at most 10% allocation', async () => {
    const { driver, transport } = harness()
    expect(await driver.accounts(portfolio)).toEqual([
      { identity: 'kalshi:paper:virtual', venue: 'kalshi' },
    ])
    const selected = await driver.plan(portfolio)
    expect(selected?.plan).toMatchObject({
      symbol: ticker,
      entryPrice: '0.5',
      outcome: 'yes',
      rate: '0.8',
    })
    expect(units(selected!.reserve)).toBeLessThanOrEqual(units('10'))
    expect(units(selected!.plan.quantity)).toBeLessThanOrEqual(units('100'))
    expect(transport.mock.calls).toHaveLength(2)
    expect(
      await driver.plan({
        ...portfolio,
        settings: { ...portfolio.settings, probabilityBps: 6000 },
      }),
    ).toBeNull()
  })

  it('does not create a probability or trade a missing, closed or nearly closing market', async () => {
    const h = harness()
    expect(
      await h.driver.plan({
        ...portfolio,
        settings: { ...portfolio.settings, predictionTicker: '' },
      }),
    ).toBeNull()
    await expect(
      h.driver.plan({ ...portfolio, settings: { ...portfolio.settings, probabilityBps: NaN } }),
    ).rejects.toThrow('PROBABILITY_INVALID')
    h.setMarket({ status: 'closed' })
    expect(await h.driver.plan(portfolio)).toBeNull()
    h.setMarket({ status: 'active', close_time: new Date(instant + 60000).toISOString() })
    expect(await h.driver.plan(portfolio)).toBeNull()
  })

  it('creates the opening intent and completes a reproducible paper IOC without private calls', async () => {
    const { driver } = harness()
    const selected = await driver.plan(portfolio)
    const op = { ...operation(), ...selected!, status: 'opening' as const }
    const decision = await driver.decide(portfolio, op, [])
    expect(decision.type).toBe('leg')
    if (decision.type !== 'leg') return
    decision.intent.clientId = 'persisted-step-id'
    const adapter = driver.adapter('kalshi')
    const prepared = await adapter.prepare(decision.intent)
    await adapter.broadcast(prepared)
    const first = await adapter.lookup(prepared)
    expect(first?.status).toBe('filled')
    expect(first?.filledQuantity).toBe(selected!.plan.quantity)
    expect(units(first!.grossQuote) + units(first!.quoteFee)).toBeLessThanOrEqual(units(op.reserve))
    expect(await adapter.lookup(JSON.parse(JSON.stringify(prepared)))).toEqual(first)
  })

  it('simulates partial fills, excludes a stale submit and never sells more than owned', async () => {
    const h = harness()
    const intent = leg('buy').prepared.intent
    h.setBook({ orderbook_fp: { yes_dollars: [['0.49', '1.00']], no_dollars: [['0.50', '1.25']] } })
    const adapter = h.driver.adapter('kalshi')
    const prepared = await adapter.prepare(intent)
    expect(await adapter.lookup(prepared)).toMatchObject({
      status: 'cancelled',
      filledQuantity: '1.25',
    })
    h.setNow(instant + 5001)
    await expect(adapter.broadcast(prepared)).rejects.toThrow('STALE_QUOTE')
    h.setNow(instant)
    await expect(
      adapter.prepare({ ...leg('sell').prepared.intent, positionQuantity: '1.99' }),
    ).rejects.toThrow('POSITION_MISMATCH')
  })

  it('holds a position, exits at fair value and accounts the final cycle only once', async () => {
    const h = harness()
    expect(await h.driver.decide(portfolio, operation(), [leg('buy')])).toEqual({
      type: 'hold',
      pnl: '-0.03',
      fees: '0.01',
    })
    h.setBook({
      orderbook_fp: { yes_dollars: [['0.80', '100.00']], no_dollars: [['0.19', '100.00']] },
    })
    expect(await h.driver.decide(portfolio, operation(), [leg('buy')])).toMatchObject({
      type: 'leg',
      role: 'prediction-close',
      intent: { action: 'sell', quantity: '2', limitPrice: '0.8', positionQuantity: '2' },
    })
    expect(
      await h.driver.decide(portfolio, operation(), [leg('buy'), leg('sell', '2', '1.6', '0.02')]),
    ).toEqual({ type: 'close', pnl: '0.57', fees: '0.03' })
  })

  it('uses bounded loss, owner close, holding time and actual partial ownership for exits', async () => {
    const h = harness()
    h.setBook({
      orderbook_fp: { yes_dollars: [['0.40', '0.75']], no_dollars: [['0.59', '100.00']] },
    })
    expect(
      await h.driver.decide(portfolio, operation(), [leg('buy', '1.5', '0.75')]),
    ).toMatchObject({
      type: 'leg',
      intent: { action: 'sell', quantity: '0.75', positionQuantity: '0.75' },
    })
    h.setBook(initialBook)
    expect(
      await h.driver.decide({ ...portfolio, close_requested: true }, operation(), [leg('buy')]),
    ).toMatchObject({ type: 'leg', intent: { action: 'sell' } })
    h.setNow(instant + 2 * 60 * 60_000)
    expect(
      await h.driver.decide(
        { ...portfolio, settings: { ...portfolio.settings, maxHoldHours: 1 } },
        operation(),
        [leg('buy')],
      ),
    ).toMatchObject({ type: 'leg', intent: { action: 'sell' } })
  })

  it('does not invent liquidity for an exit or an exchange settlement for a pending market', async () => {
    const h = harness()
    h.setBook({ orderbook_fp: { yes_dollars: [], no_dollars: [] } })
    expect(
      await h.driver.decide({ ...portfolio, close_requested: true }, operation(), [leg('buy')]),
    ).toEqual({ type: 'hold', pnl: '-1.01', fees: '0.01' })
    h.setMarket({ status: 'determined', settlement_value_dollars: '1.0000' })
    expect(await h.driver.decide(portfolio, operation(), [leg('buy')])).toEqual({
      type: 'hold',
      pnl: '-0.01',
      fees: '0.01',
    })
  })

  it('settles paper only from finalized official outcomes and reuses a stable flow ID', async () => {
    const h = harness()
    h.setMarket({ status: 'finalized', settlement_value_dollars: '1.0000', result: 'yes' })
    const result = await h.driver.decide(portfolio, operation(), [leg('buy')])
    expect(result).toEqual({
      type: 'close',
      pnl: '0.99',
      fees: '0.01',
      flows: [
        {
          externalId: 'paper:kalshi:operation-id:settlement',
          kind: 'settlement',
          amount: '2',
          at: instant,
        },
      ],
    })
    expect(await h.driver.decide(portfolio, operation(), [leg('buy')])).toEqual(result)
    h.setMarket({ settlement_value_dollars: '0.0000', result: 'no' })
    expect(await h.driver.decide(portfolio, operation(), [leg('buy')])).toMatchObject({
      type: 'close',
      pnl: '-1.01',
      fees: '0.01',
    })
  })

  it('closes a zero fill and stops on unrelated or unresolved order effects', async () => {
    const { driver } = harness()
    expect(await driver.decide(portfolio, operation(), [leg('buy', '0', '0', '0')])).toEqual({
      type: 'close',
      pnl: '0',
      fees: '0',
    })
    await expect(
      driver.decide(portfolio, operation(), [{ ...leg('buy'), state: 'unknown' }]),
    ).rejects.toThrow('UNRESOLVED_LEG')
    const unrelated = leg('buy')
    unrelated.prepared.intent.symbol = 'OTHER'
    await expect(driver.decide(portfolio, operation(), [unrelated])).rejects.toThrow('LEG_MISMATCH')
  })

  it('validates a dedicated demo account on activation and preserves its identity on resume', async () => {
    const pair = generateKeyPairSync('ed25519')
    const settings: KalshiSettings = {
      mode: 'demo',
      keyId: 'key-id',
      privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      accountId: 'owner-user-id',
      subaccount: 1,
      liveEnabled: false,
      eligibilityConfirmed: false,
      maxQuoteAgeMs: 5000,
      requestTimeoutMs: 7000,
      maxPages: 2,
    }
    let quantity = '0.00',
      balance = '100'
    const transport = vi.fn<typeof fetch>().mockImplementation(async (raw) => {
      const url = new URL(String(raw))
      expect(url.host).toBe('external-api.demo.kalshi.co')
      const path = url.pathname.replace('/trade-api/v2', '')
      if (path === '/api_keys')
        return Response.json({
          api_keys: [
            { api_key_id: settings.keyId, scopes: ['read', 'write::trade'], subaccount: 1 },
          ],
        })
      if (path === '/portfolio/orders') return Response.json({ orders: [], cursor: '' })
      if (path === '/portfolio/balance') return Response.json({ balance_dollars: balance })
      if (path === '/portfolio/positions')
        return Response.json({
          market_positions: [
            {
              ticker,
              position_fp: quantity,
              market_exposure_dollars: '1.0',
              realized_pnl_dollars: '0',
              fees_paid_dollars: '0.01',
              last_updated_ts: new Date(instant).toISOString(),
            },
          ],
          cursor: '',
        })
      throw Error('unexpected endpoint')
    })
    const driver = createPredictionDriver('demo', settings, { transport, now: () => instant })
    const demo = { ...portfolio, mode: 'demo' as const }
    const initial = await driver.accounts(demo)
    quantity = '2.00'
    await expect(driver.accounts(demo)).rejects.toThrow('ACCOUNT_NOT_EMPTY')
    balance = '1.0'
    expect(await driver.accounts({ ...demo, started_at: new Date(instant) })).toEqual(initial)
  })

  it('records only an exact private settlement receipt and never deducts its historical fees twice', async () => {
    const pair = generateKeyPairSync('ed25519')
    const settings: KalshiSettings = {
      mode: 'demo',
      keyId: 'key-id',
      privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      accountId: 'owner-user-id',
      subaccount: 1,
      liveEnabled: false,
      eligibilityConfirmed: false,
      maxQuoteAgeMs: 5000,
      requestTimeoutMs: 7000,
      maxPages: 2,
    }
    let yesQuantity = '2.00'
    const transport = vi.fn<typeof fetch>().mockImplementation(async (raw) => {
      const path = new URL(String(raw)).pathname.replace('/trade-api/v2', '')
      if (path === `/markets/${ticker}`)
        return Response.json({
          market: {
            ...market,
            status: 'finalized',
            result: 'yes',
            settlement_value_dollars: '1.0',
          },
        })
      if (path === '/portfolio/positions')
        return Response.json({ market_positions: [], cursor: '' })
      if (path === '/portfolio/settlements')
        return Response.json({
          settlements: [
            {
              ticker,
              exchange_index: 0,
              market_result: 'yes',
              yes_count_fp: yesQuantity,
              no_count_fp: '0.00',
              yes_total_cost_dollars: '1.0',
              no_total_cost_dollars: '0',
              revenue: 200,
              fee_cost: '0.01',
              settled_time: new Date(instant + 1000).toISOString(),
            },
          ],
          cursor: '',
        })
      throw Error('unexpected endpoint')
    })
    const driver = createPredictionDriver('demo', settings, {
      transport,
      now: () => instant + 2000,
    })
    const demo = { ...portfolio, mode: 'demo' as const }
    const op = { ...operation(), mode: 'demo' as const }
    const result = await driver.decide(demo, op, [leg('buy')])
    expect(result).toMatchObject({
      type: 'close',
      pnl: '0.99',
      fees: '0.01',
      flows: [{ amount: '2', kind: 'settlement' }],
    })
    expect(await driver.decide(demo, op, [leg('buy')])).toEqual(result)
    yesQuantity = '3.00'
    await expect(driver.decide(demo, op, [leg('buy')])).rejects.toThrow('SETTLEMENT_MISMATCH')
  })
})
