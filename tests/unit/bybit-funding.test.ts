import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  BybitFundingAdapter,
  FundingOrderUnknown,
  type BybitFundingOptions,
  type FundingOrder,
} from '../../core/execution/adapters/bybit-funding'
import { ExecutionRejected, type ExecutionIntent } from '../../core/execution/types'
import { units } from '../../core/trading/decimal'

const now = 1_792_000_000_000
const options: BybitFundingOptions = {
  mode: 'demo',
  credentials: { key: 'separate-funding-demo-key', secret: 'separate-funding-secret' },
  authorizeWrite: () => true,
}
const baseIntent: ExecutionIntent = {
  clientId: 'funding-0123-buy',
  venue: 'bybit-funding',
  action: 'buy',
  symbol: 'BTC-USDT',
  quantity: '0.001',
  limitPrice: '10001',
  quoteBudget: '20',
  positionQuantity: '0',
  expiresAt: now + 60_000,
}
const order: FundingOrder = {
  clientId: baseIntent.clientId,
  symbol: 'BTC-USDT',
  market: 'spot',
  intent: 'open',
  side: 'buy',
  qty: units('0.001'),
  price: units('10001'),
}
const position = {
  symbol: 'BTCUSDT',
  positionIdx: 0,
  side: '',
  size: '0',
  leverage: '1',
  autoAddMargin: 0,
  positionStatus: 'Normal',
  avgPrice: '',
  markPrice: '10001',
  liqPrice: '',
  unrealisedPnl: '',
  positionIM: '',
}
const coin = {
  coin: 'USDT',
  walletBalance: '1000',
  locked: '0',
  borrowAmount: '0',
  accruedInterest: '0',
  spotBorrow: '0',
  spotHedgingQty: '0',
  bonus: '0',
  totalPositionIM: '0',
  totalOrderIM: '0',
}
const orderRecord = {
  orderId: 'exchange-123',
  orderLinkId: baseIntent.clientId,
  symbol: 'BTCUSDT',
  side: 'Buy',
  orderType: 'Limit',
  timeInForce: 'IOC',
  qty: '0.001',
  price: '10001',
  cumExecQty: '0.001',
  cumExecValue: '10.001',
  orderStatus: 'Filled',
  isLeverage: '0',
}
const fill = {
  orderId: 'exchange-123',
  orderLinkId: baseIntent.clientId,
  symbol: 'BTCUSDT',
  side: 'Buy',
  execId: 'fill-1',
  execType: 'Trade',
  execQty: '0.001',
  execValue: '10.001',
  execPrice: '10001',
  execFee: '0.000001',
  feeCurrency: 'BTC',
  extraFees: [],
}
const response = (result: unknown, retCode = 0) => new Response(JSON.stringify({ retCode, result }))
function defaults(url: URL): unknown {
  switch (url.pathname) {
    case '/v5/market/time':
      return { timeSecond: String(now / 1000) }
    case '/v5/market/instruments-info': {
      const common = {
        symbol: 'BTCUSDT',
        baseCoin: 'BTC',
        quoteCoin: 'USDT',
        status: 'Trading',
        priceFilter: { tickSize: '1' },
      }
      return {
        list: [
          url.searchParams.get('category') === 'spot'
            ? {
                ...common,
                stTag: '0',
                lotSizeFilter: {
                  basePrecision: '0.00000001',
                  minOrderQty: '0.00001',
                  minOrderAmt: '5',
                  maxLimitOrderQty: '100',
                },
              }
            : {
                ...common,
                contractType: 'LinearPerpetual',
                settleCoin: 'USDT',
                isPreListing: false,
                fundingInterval: 480,
                lotSizeFilter: {
                  qtyStep: '0.001',
                  minOrderQty: '0.001',
                  minNotionalValue: '5',
                  maxOrderQty: '100',
                },
              },
        ],
      }
    }
    case '/v5/market/orderbook':
      return { s: 'BTCUSDT', ts: now, b: [['10000', '10']], a: [['10001', '10']] }
    case '/v5/market/tickers':
      return {
        list: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', nextFundingTime: String(now + 60_000) }],
      }
    case '/v5/account/info':
      return { unifiedMarginStatus: 6, marginMode: 'ISOLATED_MARGIN', spotHedgingStatus: 'OFF' }
    case '/v5/account/wallet-balance':
      return {
        list: [
          { accountType: 'UNIFIED', coin: [coin, { ...coin, coin: 'BTC', walletBalance: '1' }] },
        ],
      }
    case '/v5/position/list':
      return { list: url.searchParams.has('symbol') ? [position] : [] }
    case '/v5/user/query-api':
      return {
        userID: '5678',
        readOnly: 0,
        ips: ['203.0.113.1'],
        permissions: { Spot: ['SpotTrade'], ContractTrade: ['Order', 'Position'], Wallet: [] },
      }
    case '/v5/account/fee-rate':
      return { list: [{ symbol: 'BTCUSDT', takerFeeRate: '0.001' }] }
    case '/v5/order/create':
      return { orderId: 'exchange-123', orderLinkId: baseIntent.clientId }
    case '/v5/order/realtime':
      return { list: url.searchParams.has('orderLinkId') ? [orderRecord] : [] }
    case '/v5/order/history':
      return { list: [] }
    case '/v5/execution/list':
      return { list: [fill] }
    case '/v5/order/cancel':
      return { orderId: 'exchange-123', orderLinkId: baseIntent.clientId }
    case '/v5/account/transaction-log':
      return { list: [] }
    default:
      throw new Error(`Unexpected endpoint ${url.pathname}`)
  }
}
function transport(override?: (url: URL, init?: RequestInit) => unknown | undefined) {
  return vi.fn<typeof fetch>(async (raw, init) => {
    const url = new URL(String(raw))
    const value = override?.(url, init)
    return value instanceof Response ? value : response(value === undefined ? defaults(url) : value)
  })
}
const adapter = (fetcher = transport(), opts = options, clock = () => now) =>
  new BybitFundingAdapter(opts, fetcher, clock)

describe('funding preparation and separate accounts', () => {
  it('prepares a bounded IOC using reads only and keeps keys outside the persisted payload', async () => {
    const fetcher = transport()
    const prepared = await adapter(fetcher).prepare(baseIntent)
    expect(prepared.intent).toEqual(baseIntent)
    expect(prepared.externalId).toBeNull()
    expect(prepared.payload).toMatchObject({
      mode: 'demo',
      scope: expect.stringMatching(/^[a-f0-9]{64}$/),
      accountIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(prepared)).not.toContain(options.credentials.key)
    expect(JSON.stringify(prepared)).not.toContain(options.credentials.secret)
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => /query-api|fee-rate/.test(String(url)))).toBe(false)
  })

  it('uses real USDT perpetual metadata without treating funding as already received income', async () => {
    const market = await adapter().market('BTC-USDT')
    expect(market).toMatchObject({
      fundingRate: units('0.0001'),
      nextFundingAt: now + 60_000,
      fundingIntervalMinutes: 480,
      perpMaxQty: units('100'),
    })
    expect(market.perp.instrument.lot).toBe(units('0.001'))
    expect(market.spot.instrument.lot).toBe(units('0.00000001'))
  })

  it.each([
    { quantity: '0.000001', limitPrice: '10001' },
    { quantity: '0.001', limitPrice: '10001.5' },
    { quantity: '101', limitPrice: '10001' },
  ])(
    'rejects exchange size and tick violations before private account reads: %j',
    async (change) => {
      const fetcher = transport()
      await expect(adapter(fetcher).prepare({ ...baseIntent, ...change })).rejects.toThrow(
        'EXECUTION_ORDER_SIZE',
      )
      expect(
        fetcher.mock.calls.some(
          ([, init]) => (init?.headers as Record<string, string>)['X-BAPI-API-KEY'],
        ),
      ).toBe(false)
    },
  )

  it('reserves demo fees and rejects a short larger than confirmed owned spot', async () => {
    await expect(adapter().prepare({ ...baseIntent, quoteBudget: '10.001' })).rejects.toThrow(
      'EXECUTION_INSUFFICIENT_BALANCE',
    )
    await expect(
      adapter().prepare({
        ...baseIntent,
        action: 'short',
        limitPrice: '10000',
        positionQuantity: '0.000999',
      }),
    ).rejects.toThrow('EXECUTION_POSITION_MISMATCH')
    await expect(
      adapter().prepare({
        ...baseIntent,
        action: 'short',
        limitPrice: '10000',
        positionQuantity: '0.001',
      }),
    ).resolves.toMatchObject({ externalId: null })
  })

  it('checks the configured empty position leverage before opening the first short', async () => {
    const fetcher = transport((url) =>
      url.pathname === '/v5/position/list' && url.searchParams.has('symbol')
        ? { list: [{ ...position, leverage: '10' }] }
        : undefined,
    )
    await expect(adapter(fetcher).prepare(baseIntent)).rejects.toThrow('EXECUTION_POSITION_INVALID')
  })

  it('checks isolated margin, leverage, one-way mode and prohibits debt', async () => {
    for (const marginMode of ['REGULAR_MARGIN', 'PORTFOLIO_MARGIN']) {
      const fetcher = transport((url) =>
        url.pathname === '/v5/account/info'
          ? { unifiedMarginStatus: 6, marginMode, spotHedgingStatus: 'OFF' }
          : undefined,
      )
      await expect(adapter(fetcher).account('BTC-USDT')).rejects.toThrow('EXECUTION_ACCOUNT_MODE')
    }
    const debt = transport((url) =>
      url.pathname === '/v5/account/wallet-balance'
        ? { list: [{ accountType: 'UNIFIED', coin: [{ ...coin, spotBorrow: '0.01' }] }] }
        : undefined,
    )
    await expect(adapter(debt).account('BTC-USDT')).rejects.toThrow('EXECUTION_DEBT_FORBIDDEN')
    for (const change of [
      { positionIdx: 2 },
      { side: 'Buy', size: '0.001' },
      { autoAddMargin: 1 },
      { positionStatus: 'Liq' },
    ]) {
      const fetcher = transport((url) =>
        url.pathname === '/v5/position/list' ? { list: [{ ...position, ...change }] } : undefined,
      )
      await expect(adapter(fetcher).positions('BTC-USDT')).rejects.toThrow()
    }
  })

  it('deducts locked cash and position/order margin instead of treating total wallet as available', async () => {
    const fetcher = transport((url) =>
      url.pathname === '/v5/account/wallet-balance'
        ? {
            list: [
              {
                accountType: 'UNIFIED',
                coin: [{ ...coin, totalPositionIM: '500', totalOrderIM: '10', locked: '5' }],
              },
            ],
          }
        : undefined,
    )
    const result = await adapter(fetcher).account('BTC-USDT')
    expect(result.availableMargin).toBe(units('485'))
    expect(result.balances.USDT.total).toBe(units('1000'))
  })

  it('checks actual live fee rates, restricted permissions and bound IPs', async () => {
    const live = { ...options, mode: 'live' as const }
    expect((await adapter(transport(), live).account('BTC-USDT')).feeBps).toEqual({
      spot: 10,
      perp: 10,
    })
    for (const change of [
      { ips: [] },
      { ips: ['0.0.0.0/0'] },
      { permissions: { Spot: ['SpotTrade'], ContractTrade: ['Order'], Wallet: ['Withdraw'] } },
    ]) {
      const fetcher = transport((url) =>
        url.pathname === '/v5/user/query-api'
          ? { ...(defaults(url) as object), ...change }
          : undefined,
      )
      await expect(adapter(fetcher, live).account('BTC-USDT')).rejects.toThrow(
        /EXECUTION_(IP_REQUIRED|KEY_PERMISSIONS)/,
      )
    }
    const badFee = transport((url) =>
      url.pathname === '/v5/account/fee-rate' ? { list: [] } : undefined,
    )
    await expect(adapter(badFee, live).account('BTC-USDT')).rejects.toThrow('EXECUTION_FEE_UNKNOWN')
  })

  it('refuses stale books and contracts whose settlement or type differs from the spot', async () => {
    const stale = transport((url) =>
      url.pathname === '/v5/market/orderbook'
        ? { ...(defaults(url) as object), ts: now - 10_001 }
        : undefined,
    )
    await expect(adapter(stale).market('BTC-USDT')).rejects.toThrow('EXECUTION_BOOK_INVALID')
    const delivery = transport((url) => {
      if (
        url.pathname !== '/v5/market/instruments-info' ||
        url.searchParams.get('category') !== 'linear'
      )
        return
      const result = defaults(url) as { list: object[] }
      return { list: [{ ...result.list[0], contractType: 'LinearFutures' }] }
    })
    await expect(adapter(delivery).market('BTC-USDT')).rejects.toThrow()
  })
})

describe('funding order transmission and reconciliation', () => {
  it('signs exact IOC bytes with the separate demo key and never enables spot borrowing', async () => {
    const fetcher = transport()
    const prepared = await adapter(fetcher).prepare(baseIntent)
    fetcher.mockClear()
    await adapter(fetcher).broadcast(prepared)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    const headers = init!.headers as Record<string, string>
    expect(String(url)).toBe('https://api-demo.bybit.com/v5/order/create')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(headers['X-BAPI-API-KEY']).toBe(options.credentials.key)
    expect(headers['X-BAPI-SIGN']).toBe(
      createHmac('sha256', options.credentials.secret)
        .update(String(now) + options.credentials.key + '5000' + init!.body)
        .digest('hex'),
    )
    expect(JSON.parse(String(init!.body))).toMatchObject({
      category: 'spot',
      side: 'Buy',
      orderType: 'Limit',
      timeInForce: 'IOC',
      isLeverage: 0,
      qty: '0.001',
      price: '10001',
    })
  })

  it('opens only short positions and always closes linear positions with reduceOnly', async () => {
    const fetcher = transport()
    for (const intent of ['open', 'close', 'compensate'] as const) {
      await adapter(fetcher).place({
        ...order,
        market: 'perp',
        intent,
        side: intent === 'open' ? 'sell' : 'buy',
      })
      const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))
      expect(body).toMatchObject({
        category: 'linear',
        positionIdx: 0,
        side: intent === 'open' ? 'Sell' : 'Buy',
        reduceOnly: intent !== 'open',
      })
    }
    await expect(adapter(fetcher).place({ ...order, market: 'perp', side: 'buy' })).rejects.toThrow(
      'EXECUTION_ORDER_INVALID',
    )
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('checks separate live opt-in, write authorization, account binding and expiry without sending', async () => {
    const fetcher = transport()
    await expect(adapter(fetcher, { ...options, mode: 'live' }).place(order)).rejects.toThrow(
      'EXECUTION_LIVE_DISABLED',
    )
    await expect(
      adapter(fetcher, { ...options, authorizeWrite: () => false }).place(order),
    ).rejects.toThrow('EXECUTION_WRITE_DISABLED')
    await expect(
      adapter(fetcher, { ...options, authorizeWrite: undefined }).place(order),
    ).rejects.toThrow('EXECUTION_WRITE_DISABLED')
    expect(fetcher).not.toHaveBeenCalled()
    const prepared = await adapter(fetcher).prepare(baseIntent)
    fetcher.mockClear()
    await expect(
      adapter(fetcher, {
        ...options,
        credentials: { ...options.credentials, key: 'another-account-key' },
      }).broadcast(prepared),
    ).rejects.toThrow('EXECUTION_ACCOUNT_MISMATCH')
    await expect(adapter(fetcher, options, () => now + 60_000).broadcast(prepared)).rejects.toThrow(
      'EXECUTION_QUOTE_EXPIRED',
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not retry a timeout or duplicate client ID and only classifies definitive refusals as rejected', async () => {
    const timeout = vi.fn<typeof fetch>().mockRejectedValue(new Error('private remote error'))
    await expect(adapter(timeout).place(order)).rejects.toBeInstanceOf(FundingOrderUnknown)
    expect(timeout).toHaveBeenCalledTimes(1)
    const duplicate = transport(() => response({}, 10014))
    await expect(adapter(duplicate).place(order)).rejects.toBeInstanceOf(FundingOrderUnknown)
    expect(duplicate).toHaveBeenCalledTimes(1)
    const badSize = transport(() => response({}, 10001))
    await expect(adapter(badSize).place(order)).rejects.toBeInstanceOf(ExecutionRejected)
  })

  it('reconciles all pages of fills and accounts for base-coin fees before sizing the hedge', async () => {
    const fetcher = transport((url) => {
      if (url.pathname !== '/v5/execution/list') return
      return url.searchParams.has('cursor')
        ? {
            list: [
              {
                ...fill,
                execId: 'fill-2',
                execQty: '0.0006',
                execValue: '6.0006',
                execFee: '0.0000006',
              },
            ],
          }
        : {
            list: [{ ...fill, execQty: '0.0004', execValue: '4.0004', execFee: '0.0000004' }],
            nextPageCursor: 'next',
          }
    })
    const prepared = await adapter(fetcher).prepare(baseIntent)
    const result = await adapter(fetcher).lookup(prepared)
    expect(result).toMatchObject({
      status: 'filled',
      filledQuantity: '0.001',
      grossQuote: '10.001',
      baseFee: '0.000001',
      quoteFee: '0',
    })
    expect(units(result!.filledQuantity) - units(result!.baseFee)).toBe(units('0.000999'))
  })

  it('does not expose partial IOC fills until they are final and fully reconciled', async () => {
    const fetcher = transport((url) =>
      url.pathname === '/v5/order/realtime'
        ? {
            list: [
              {
                ...orderRecord,
                orderStatus: 'PartiallyFilled',
                cumExecQty: '0.0004',
                cumExecValue: '4.0004',
              },
            ],
          }
        : undefined,
    )
    const prepared = await adapter(fetcher).prepare(baseIntent)
    expect(await adapter(fetcher).lookup(prepared)).toMatchObject({
      status: 'pending',
      filledQuantity: '0',
      grossQuote: '0',
      baseFee: '0',
    })
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/v5/execution/list'))).toBe(
      false,
    )
  })

  it('reconciles terminal partial cancellation and keeps negative maker rebates signed', async () => {
    const fetcher = transport((url) => {
      if (url.pathname === '/v5/order/realtime')
        return {
          list: [
            {
              ...orderRecord,
              orderStatus: 'PartiallyFilledCanceled',
              cumExecQty: '0.0004',
              cumExecValue: '4.0004',
            },
          ],
        }
      if (url.pathname === '/v5/execution/list')
        return {
          list: [
            {
              ...fill,
              execQty: '0.0004',
              execValue: '4.0004',
              execFee: '-0.001',
              feeCurrency: 'USDT',
            },
          ],
        }
    })
    const prepared = await adapter(fetcher).prepare(baseIntent)
    expect(await adapter(fetcher).lookup(prepared)).toMatchObject({
      status: 'cancelled',
      filledQuantity: '0.0004',
      grossQuote: '4.0004',
      quoteFee: '-0.001',
    })
  })

  it('rejects missing executions, duplicate fills and mismatched reduceOnly echoes', async () => {
    for (const list of [[], [fill, fill], [{ ...fill, feeCurrency: 'UNKNOWN' }]]) {
      const fetcher = transport((url) =>
        url.pathname === '/v5/execution/list' ? { list } : undefined,
      )
      await expect(adapter(fetcher).order(order)).rejects.toThrow()
    }
    const mismatch = transport((url) =>
      url.pathname === '/v5/order/realtime'
        ? { list: [{ ...orderRecord, positionIdx: 0, reduceOnly: false }] }
        : undefined,
    )
    await expect(
      adapter(mismatch).order({ ...order, market: 'perp', intent: 'close' }),
    ).rejects.toThrow('EXECUTION_ORDER_MISMATCH')
  })

  it('looks in order history without resubmitting when real-time data is absent', async () => {
    const fetcher = transport((url) =>
      url.pathname === '/v5/order/realtime' ? { list: [] } : undefined,
    )
    expect(await adapter(fetcher).order(order)).toBeNull()
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v5/order/realtime',
      '/v5/order/history',
    ])
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })

  it('requests cancellation only for the persisted ID and requires subsequent reconciliation', async () => {
    const fetcher = transport()
    const prepared = await adapter(fetcher).prepare(baseIntent)
    fetcher.mockClear()
    await adapter(fetcher).cancel(prepared)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      category: 'spot',
      symbol: 'BTCUSDT',
      orderLinkId: baseIntent.clientId,
    })
  })
})

describe('funding cash reconciliation', () => {
  const event = {
    id: 'fund-1',
    symbol: 'BTCUSDT',
    category: 'linear',
    currency: 'USDT',
    type: 'SETTLEMENT',
    transactionTime: String(now - 1000),
    funding: '0.1',
  }
  it('reads all pages, uses actual cashflow signs and filters unrelated symbols', async () => {
    const fetcher = transport((url) =>
      url.pathname === '/v5/account/transaction-log'
        ? url.searchParams.has('cursor')
          ? {
              list: [
                { ...event, id: 'fund-2', funding: '-0.025', transactionTime: String(now) },
                { ...event, id: 'eth-fund', symbol: 'ETHUSDT' },
              ],
            }
          : { list: [event], nextPageCursor: 'next' }
        : undefined,
    )
    expect(await adapter(fetcher).fundingHistory('BTC-USDT', now - 2000, now)).toEqual([
      { id: 'fund-1', symbol: 'BTC-USDT', at: now - 1000, amount: units('0.1') },
      { id: 'fund-2', symbol: 'BTC-USDT', at: now, amount: units('-0.025') },
    ])
    const query = new URL(String(fetcher.mock.calls[0]![0])).searchParams
    expect(query.get('type')).toBe('SETTLEMENT')
    expect(query.get('currency')).toBe('USDT')
  })

  it('rejects incomplete pagination and out-of-window or duplicate records', async () => {
    const loop = transport(() => ({ list: [], nextPageCursor: 'same' }))
    await expect(adapter(loop).fundingHistory('BTC-USDT', now - 2000, now)).rejects.toThrow(
      'EXECUTION_PAGINATION_INCOMPLETE',
    )
    expect(loop).toHaveBeenCalledTimes(2)
    for (const list of [[event, event], [{ ...event, transactionTime: String(now + 1) }]]) {
      await expect(
        adapter(transport(() => ({ list }))).fundingHistory('BTC-USDT', now - 2000, now),
      ).rejects.toThrow('EXECUTION_HISTORY_INVALID')
    }
  })

  it('limits history windows without calling the exchange', async () => {
    const fetcher = transport()
    await expect(
      adapter(fetcher).fundingHistory('BTC-USDT', now - 8 * 24 * 60 * 60_000, now),
    ).rejects.toThrow('EXECUTION_HISTORY_RANGE')
    await expect(adapter(fetcher).fundingHistory('BTC-USDT', now, now + 1)).rejects.toThrow(
      'EXECUTION_HISTORY_RANGE',
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('public funding discovery', () => {
  it('skips pre-listing empty rates and selects only liquid symbols with matching active spot', async () => {
    const fetcher = transport((url) => {
      if (url.pathname === '/v5/market/instruments-info')
        return {
          list: [
            { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading' },
            {
              symbol: 'ETHUSDT',
              baseCoin: 'ETH',
              quoteCoin: 'USDT',
              status: 'Trading',
              stTag: '1',
            },
            { symbol: 'LTCUSDT', baseCoin: 'LTC', quoteCoin: 'USDT', status: 'Trading' },
          ],
        }
      if (url.pathname === '/v5/market/tickers')
        return {
          list: [
            {
              symbol: 'BTCUSDT',
              fundingRate: '0.0001',
              turnover24h: '20000000',
              nextFundingTime: String(now + 1000),
            },
            {
              symbol: 'BTCUSD',
              fundingRate: '0.001',
              turnover24h: '20000000',
              nextFundingTime: String(now + 1000),
            },
            {
              symbol: 'ETHUSDT',
              fundingRate: '0.001',
              turnover24h: '20000000',
              nextFundingTime: String(now + 1000),
            },
            {
              symbol: 'LTCUSDT',
              fundingRate: '0.001',
              turnover24h: '1000',
              nextFundingTime: String(now + 1000),
            },
            { symbol: 'NEXTUSDT', fundingRate: '', turnover24h: '', nextFundingTime: '' },
          ],
        }
    })
    expect(await adapter(fetcher).discover()).toEqual(['BTC-USDT'])
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !(init?.headers as Record<string, string>)['X-BAPI-API-KEY'],
      ),
    ).toBe(true)
  })

  it('returns past public funding rates for paper and rejects incomplete history', async () => {
    const fetcher = transport(() => ({
      list: [
        { symbol: 'BTCUSDT', fundingRate: '-0.0002', fundingRateTimestamp: String(now - 1000) },
      ],
    }))
    expect(await adapter(fetcher).fundingRates('BTC-USDT', now - 2000, now)).toEqual([
      { at: now - 1000, rate: units('-0.0002') },
    ])
    expect(String(fetcher.mock.calls[0]![0])).toContain('/v5/market/funding/history?')
    const incomplete = transport(() => ({ list: Array.from({ length: 200 }, () => ({})) }))
    await expect(adapter(incomplete).fundingRates('BTC-USDT', now - 2000, now)).rejects.toThrow(
      'EXECUTION_PAGINATION_INCOMPLETE',
    )
  })
})
