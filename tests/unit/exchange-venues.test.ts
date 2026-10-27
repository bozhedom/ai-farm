import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../core/config'
import { BybitVenue } from '../../core/trading/bybit'
import { BinanceVenue } from '../../core/trading/binance'
import { BitgetVenue } from '../../core/trading/bitget'
import { decimal, units } from '../../core/trading/decimal'
import { responseJson } from '../../core/trading/wire'
import type { OrderRequest } from '../../core/trading/types'

const order: OrderRequest = {
  clientId: 'a1b2c3',
  symbol: 'BTC-USDT',
  side: 'buy',
  qty: units('0.0001'),
  price: units('80000'),
}
const original = { ...config() }
const adapters = { bybit: BybitVenue, binance: BinanceVenue, bitget: BitgetVenue }
const response = (data: unknown) => new Response(JSON.stringify(data))
function wrap(exchange: keyof typeof adapters, data: unknown, code = 0) {
  return response(
    exchange === 'bybit'
      ? { retCode: code, result: data }
      : exchange === 'bitget'
        ? { code: code ? String(code) : '00000', requestTime: Date.now(), data }
        : code
          ? { code }
          : data,
  )
}
function configure() {
  for (const e of Object.keys(adapters))
    for (const mode of ['DEMO', 'LIVE'])
      Object.assign(config(), {
        [`${e.toUpperCase()}_${mode}_API_KEY`]: `${e}-${mode}-key`,
        [`${e.toUpperCase()}_${mode}_SECRET`]: `${e}-${mode}-secret`,
        ...(e === 'bitget' ? { [`BITGET_${mode}_PASSPHRASE`]: 'passphrase' } : {}),
      })
  config().TRADING_LIVE_ENABLED = true
}
afterEach(() => {
  Object.assign(config(), original)
  vi.restoreAllMocks()
})

describe('exchange request isolation', () => {
  for (const exchange of Object.keys(adapters) as (keyof typeof adapters)[]) {
    it(`${exchange}: signs exact IOC bytes and isolates demo credentials`, async () => {
      configure()
      const transport = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          wrap(
            exchange,
            exchange === 'bybit'
              ? { orderId: '123', orderLinkId: order.clientId }
              : exchange === 'binance'
                ? { orderId: 123, clientOrderId: order.clientId, symbol: 'BTCUSDT' }
                : { orderId: '123', clientOid: order.clientId },
          ),
        )
      await new adapters[exchange]('demo', transport).place(order)
      const [raw, options] = transport.mock.calls[0]!,
        url = new URL(String(raw)),
        h = options!.headers as Record<string, string>
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' })
      if (exchange === 'bybit') {
        expect(url.host).toBe('api-demo.bybit.com')
        expect(h['X-BAPI-API-KEY']).toBe('bybit-DEMO-key')
        expect(h['X-BAPI-SIGN']).toBe(
          createHmac('sha256', 'bybit-DEMO-secret')
            .update(h['X-BAPI-TIMESTAMP']! + 'bybit-DEMO-key5000' + options!.body)
            .digest('hex'),
        )
        expect(JSON.parse(String(options!.body))).toMatchObject({
          category: 'spot',
          orderType: 'Limit',
          timeInForce: 'IOC',
          isLeverage: 0,
          qty: '0.0001',
          price: '80000',
        })
      } else if (exchange === 'binance') {
        expect(url.host).toBe('testnet.binance.vision')
        expect(h['X-MBX-APIKEY']).toBe('binance-DEMO-key')
        const signature = url.searchParams.get('signature')
        url.searchParams.delete('signature')
        expect(signature).toBe(
          createHmac('sha256', 'binance-DEMO-secret')
            .update(url.searchParams.toString())
            .digest('hex'),
        )
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
          type: 'LIMIT',
          timeInForce: 'IOC',
          quantity: '0.0001',
          price: '80000',
          newClientOrderId: order.clientId,
        })
      } else {
        expect(url.host).toBe('api.bitget.com')
        expect(h).toMatchObject({
          'ACCESS-KEY': 'bitget-DEMO-key',
          paptrading: '1',
          'ACCESS-PASSPHRASE': 'passphrase',
        })
        expect(h['ACCESS-SIGN']).toBe(
          createHmac('sha256', 'bitget-DEMO-secret')
            .update(h['ACCESS-TIMESTAMP']! + 'POST' + url.pathname + options!.body)
            .digest('base64'),
        )
        expect(JSON.parse(String(options!.body))).toMatchObject({
          category: 'SPOT',
          timeInForce: 'ioc',
          autoBorrow: 'no',
          pxAmendType: 'no',
          qty: '0.0001',
        })
      }
      await new adapters[exchange]('live', transport).place(order)
      const liveUrl = new URL(String(transport.mock.calls[1]![0])),
        liveHeaders = transport.mock.calls[1]![1]!.headers as Record<string, string>
      expect(liveUrl.host).toBe(
        exchange === 'bybit'
          ? 'api.bybit.com'
          : exchange === 'binance'
            ? 'api.binance.com'
            : 'api.bitget.com',
      )
      expect(Object.values(liveHeaders)).toContain(`${exchange}-LIVE-key`)
      expect(liveHeaders.paptrading).toBeUndefined()
      Object.assign(config(), { [`${exchange.toUpperCase()}_DEMO_API_KEY`]: '' })
      await expect(new adapters[exchange]('demo', transport).place(order)).rejects.toThrow(
        'TRADING_ORDER_UNKNOWN',
      )
      config().TRADING_LIVE_ENABLED = false
      await expect(new adapters[exchange]('live', transport).place(order)).rejects.toThrow(
        'TRADING_LIVE_DISABLED',
      )
      await expect(new adapters[exchange]('paper', transport).place(order)).rejects.toThrow(
        'TRADING_PAPER_ONLY',
      )
      expect(transport).toHaveBeenCalledTimes(2)
    })
    it(`${exchange}: never treats a timeout or duplicate ID as a safe retry`, async () => {
      configure()
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('secret returned by remote', { status: 503 }))
      await expect(new adapters[exchange]('demo', transport).place(order)).rejects.toThrow(
        'TRADING_ORDER_UNKNOWN',
      )
      transport.mockImplementation(async () =>
        wrap(exchange, {}, exchange === 'bybit' ? 10014 : exchange === 'binance' ? -2010 : 25212),
      )
      await expect(new adapters[exchange]('demo', transport).place(order)).rejects.toThrow(
        'TRADING_ORDER_UNKNOWN',
      )
      expect(transport).toHaveBeenCalledTimes(2)
    })
  }
  it('preserves Bitget numeric JSON tokens including exponents without floating point conversion', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          '{"requestTime":123,"data":{"a":[[80000.100000000000000001,1e-8]],"b":[[79999.99,0.000100000000000001]]}}',
        ),
      )
    const r = (await responseJson(transport, 'https://api.bitget.com', {}, true)) as {
      requestTime: number
      data: { a: string[][]; b: string[][] }
    }
    expect(r.requestTime).toBe(123)
    expect(r.data.a[0]).toEqual(['80000.100000000000000001', '0.00000001'])
    expect(decimal(units(r.data.b[0]![1]!))).toBe('0.000100000000000001')
  })
})

function fillTransport(
  exchange: keyof typeof adapters,
  feeCoin = 'BTC',
  partial = false,
  incomplete = false,
) {
  return vi.fn<typeof fetch>().mockImplementation(async (raw) => {
    const url = new URL(String(raw))
    if (exchange === 'bybit') {
      if (url.pathname.includes('/execution/'))
        return wrap(exchange, {
          list: [
            {
              orderId: '1',
              orderLinkId: order.clientId,
              symbol: 'BTCUSDT',
              side: 'Buy',
              execId: 'fill1',
              execType: 'Trade',
              execQty: incomplete ? '0.00001' : '0.00005',
              execValue: '4',
              execFee: '0.00000005',
              feeCurrency: feeCoin,
              extraFees: '',
            },
          ],
          nextPageCursor: 'opaque-even-on-last-page',
        })
      return wrap(exchange, {
        list: [
          {
            orderId: '1',
            orderLinkId: order.clientId,
            symbol: 'BTCUSDT',
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'IOC',
            qty: '0.0001',
            price: '80000',
            cumExecQty: '0.00005',
            cumExecValue: '4',
            orderStatus: partial ? 'PartiallyFilledCanceled' : 'Filled',
            isLeverage: '0',
          },
        ],
      })
    }
    if (exchange === 'binance') {
      if (url.pathname.includes('/myTrades'))
        return wrap(exchange, [
          {
            id: 99,
            orderId: 1,
            symbol: 'BTCUSDT',
            qty: incomplete ? '0.00001' : '0.00005',
            quoteQty: '4',
            commission: '0.00000005',
            commissionAsset: feeCoin,
            isBuyer: true,
          },
        ])
      return wrap(exchange, {
        orderId: 1,
        clientOrderId: order.clientId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        timeInForce: 'IOC',
        origQty: '0.0001',
        price: '80000',
        executedQty: '0.00005',
        cummulativeQuoteQty: '4',
        status: partial ? 'EXPIRED' : 'FILLED',
      })
    }
    return wrap(exchange, {
      orderId: '1',
      clientOid: order.clientId,
      category: 'SPOT',
      symbol: 'BTCUSDT',
      side: 'buy',
      orderType: 'limit',
      timeInForce: 'ioc',
      qty: '0.0001',
      price: '80000',
      cumExecQty: '0.00005',
      cumExecValue: '4',
      orderStatus: partial ? 'cancelled' : 'filled',
      feeDetail: [{ feeCoin, fee: incomplete ? null : '0.00000005' }],
    })
  })
}
describe('native fill accounting', () => {
  for (const exchange of Object.keys(adapters) as (keyof typeof adapters)[]) {
    it(`${exchange}: accounts for partial IOC fees in the charged currency`, async () => {
      configure()
      const result = await new adapters[exchange](
        'demo',
        fillTransport(exchange, 'BTC', true),
      ).order(order)
      expect(result).toMatchObject({
        clientId: order.clientId,
        exchangeId: '1',
        state: 'canceled',
        filledQty: units('0.00005'),
        quote: units('4'),
        baseFee: units('-0.00000005'),
        quoteFee: 0n,
      })
      const sale = { ...order, side: 'sell' as const }
      await expect(
        new adapters[exchange]('demo', fillTransport(exchange)).order(sale),
      ).rejects.toThrow('TRADING_ORDER_MISMATCH')
      await expect(
        new adapters[exchange]('demo', fillTransport(exchange, 'BNB')).order(order),
      ).rejects.toThrow('TRADING_FEE_CURRENCY')
      await expect(
        new adapters[exchange]('demo', fillTransport(exchange, 'BTC', true, true)).order(order),
      ).rejects.toThrow(exchange === 'bitget' ? 'TRADING_FEE_UNKNOWN' : 'TRADING_FILLS_INCOMPLETE')
    })
  }
  it('only recognizes documented not-found errors as an absent order', async () => {
    configure()
    for (const [Venue, exchange, code] of [
      [BinanceVenue, 'binance', -2013],
      [BitgetVenue, 'bitget', 25204],
    ] as const) {
      expect(
        await new Venue('demo', async () => wrap(exchange, null, code)).order(order),
      ).toBeNull()
      await expect(
        new Venue('demo', async () => wrap(exchange, null, 40009)).order(order),
      ).rejects.toThrow('TRADING_EXCHANGE_ERROR')
    }
  })
})

function accountTransport(exchange: keyof typeof adapters, problem = '') {
  return vi.fn<typeof fetch>().mockImplementation(async (raw) => {
    const url = new URL(String(raw)),
      path = url.pathname,
      symbol = url.searchParams.get('symbol') || 'BTCUSDT'
    let data: unknown
    if (exchange === 'bybit') {
      if (path.endsWith('/time')) data = { timeSecond: String(Math.floor(Date.now() / 1000)) }
      else if (path.endsWith('/query-api'))
        data = {
          userID: 123,
          readOnly: 0,
          ips: problem === 'ip' ? [] : ['203.0.113.2'],
          permissions: { Spot: ['SpotTrade'], Wallet: problem === 'withdraw' ? ['Withdraw'] : [] },
        }
      else if (path.endsWith('/info'))
        data = {
          unifiedMarginStatus: 6,
          marginMode: problem === 'margin' ? 'PORTFOLIO_MARGIN' : 'REGULAR_MARGIN',
          spotHedgingStatus: 'OFF',
        }
      else if (path.endsWith('/wallet-balance'))
        data = {
          list: [
            {
              accountType: 'UNIFIED',
              coin: [
                {
                  coin: 'USDT',
                  walletBalance: '100.000000000000000001',
                  equity: '100.000000000000000001',
                  locked: '0',
                  borrowAmount: problem === 'debt' ? '1' : '0',
                  accruedInterest: '0',
                  totalPositionIM: '0',
                  totalOrderIM: '0',
                },
              ],
            },
          ],
        }
      else if (path.endsWith('/fee-rate'))
        data = { list: [{ symbol, takerFeeRate: problem === 'fees' ? '0.003' : '0.001' }] }
      else throw new Error('UNEXPECTED_ENDPOINT')
    } else if (exchange === 'binance') {
      if (path.endsWith('/time')) data = { serverTime: Date.now() }
      else if (path.endsWith('/apiRestrictions'))
        data = {
          ipRestrict: problem !== 'ip',
          enableReading: true,
          enableSpotAndMarginTrading: true,
          enableWithdrawals: problem === 'withdraw',
          enableMargin: problem === 'margin',
          enableFutures: false,
        }
      else if (path.endsWith('/account'))
        data = {
          uid: 123,
          accountType: 'SPOT',
          canTrade: true,
          permissions: ['SPOT'],
          balances: [{ asset: 'USDT', free: '100.000000000000000001', locked: '0' }],
        }
      else if (path.endsWith('/commission'))
        data = {
          symbol,
          standardCommission: {
            taker: problem === 'fees' ? '0.003' : '0.001',
            buyer: '0',
            seller: '0',
          },
          specialCommission: { taker: '0', buyer: '0', seller: '0' },
          taxCommission: { taker: '0', buyer: '0', seller: '0' },
          discount: { enabledForAccount: problem === 'token', enabledForSymbol: true },
        }
      else throw new Error('UNEXPECTED_ENDPOINT')
    } else {
      if (path.endsWith('/info'))
        data = {
          userId: '123',
          ips: problem === 'ip' ? '' : '203.0.113.2',
          permType: 'read-and-write',
          permissions: ['uta_trade', 'uta_mgt', ...(problem === 'withdraw' ? ['withdraw'] : [])],
        }
      else if (path.endsWith('/settings'))
        data = {
          uid: '123',
          accountMode: 'unified',
          accountLevel: problem === 'margin' ? 'advanced' : 'basic',
          deltaSwitch: 'no',
        }
      else if (path.endsWith('/deduct-info')) data = { deduct: problem === 'token' ? 'on' : 'off' }
      else if (path.endsWith('/assets'))
        data = {
          unrealisedPnl: '0',
          mmr: '0',
          imr: '0',
          positionValue: '0',
          assets: [
            {
              coin: 'USDT',
              balance: '100.000000000000000001',
              equity: '100.000000000000000001',
              available: '100.000000000000000001',
              debt: problem === 'debt' ? '1' : '0',
              interestBase: '0',
              bonus: '0',
            },
          ],
        }
      else if (path.endsWith('/fee-rate'))
        data = { takerFeeRate: problem === 'fees' ? '0.003' : '0.001' }
      else throw new Error('UNEXPECTED_ENDPOINT')
    }
    return wrap(exchange, data)
  })
}
describe('account admission', () => {
  for (const exchange of Object.keys(adapters) as (keyof typeof adapters)[]) {
    it(`${exchange}: verifies account scope, fees and exact balances`, async () => {
      configure()
      const venue = new adapters[exchange]('live', accountTransport(exchange)),
        a = await venue.account(['PEPE-USDT', 'SOL-USDT'])
      expect(a.balances.USDT.total).toBe(units('100.000000000000000001'))
      expect(a.feeBps).toEqual({ 'PEPE-USDT': 10, 'SOL-USDT': 10 })
      const demoTransport = accountTransport(exchange),
        demo = await new adapters[exchange]('demo', demoTransport).account([
          'PEPE-USDT',
          'SOL-USDT',
        ])
      expect(demo.identity).not.toBe(a.identity)
      expect(
        demoTransport.mock.calls.some(([url]) => /query-api|apiRestrictions/.test(String(url))),
      ).toBe(false)
      for (const [problem, reason] of [
        ['ip', 'TRADING_IP_REQUIRED'],
        ['withdraw', 'TRADING_KEY_PERMISSIONS'],
        ['margin', exchange === 'binance' ? 'TRADING_KEY_PERMISSIONS' : 'TRADING_ACCOUNT_MODE'],
        ['fees', 'TRADING_FEE_TOO_HIGH'],
        ...(exchange === 'binance' ? [] : [['debt', 'TRADING_DEBT_FORBIDDEN']]),
        ...(exchange === 'bybit' ? [] : [['token', 'TRADING_FEE_TOKEN_ENABLED']]),
      ] as const)
        await expect(
          new adapters[exchange]('live', accountTransport(exchange, problem)).account([
            'PEPE-USDT',
            'SOL-USDT',
          ]),
        ).rejects.toThrow(reason)
    })
  }
})

describe('Bybit market rules', () => {
  it('uses minOrderQty as the floor and basePrecision as the lot step', async () => {
    const now = Date.now()
    const minute = Math.floor(now / 60_000) * 60_000
    const transport = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/instruments-info'))
        return wrap('bybit', {
          list: [
            {
              symbol: 'BTCUSDT',
              baseCoin: 'BTC',
              quoteCoin: 'USDT',
              status: 'Trading',
              lotSizeFilter: {
                basePrecision: '0.00000001',
                minOrderQty: '0.00001',
                minOrderAmt: '5',
              },
              priceFilter: { tickSize: '0.01' },
            },
          ],
        })
      if (path.endsWith('/kline'))
        return wrap('bybit', {
          list: [1, 2, 3].map((i) => [
            String(minute - i * 60_000),
            '1',
            '1',
            '1',
            '80000',
            '1',
            '1',
          ]),
        })
      return wrap('bybit', { s: 'BTCUSDT', b: [['79999', '1']], a: [['80001', '1']], ts: now })
    })
    const market = await new BybitVenue('paper', transport).market('BTC-USDT')
    expect(market.instrument.lot).toBe(units('0.00000001'))
    expect(market.instrument.minQty).toBe(units('0.00001'))
    expect(market.instrument.minNotional).toBe(units('5'))
    expect(market.candles).toHaveLength(3)
  })
})

describe('Bitget market rules', () => {
  it('treats a zero quantity minimum as one lot and keeps the amount minimum', async () => {
    const now = Date.now()
    const minute = Math.floor(now / 60_000) * 60_000
    const transport = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/instruments'))
        return wrap('bitget', [
          {
            symbol: 'ZECUSDT',
            baseCoin: 'ZEC',
            quoteCoin: 'USDT',
            status: 'online',
            pricePrecision: '2',
            quantityPrecision: '3',
            minOrderQty: '0',
            minOrderAmount: '1',
          },
        ])
      if (path.endsWith('/candles'))
        return wrap(
          'bitget',
          [1, 2, 3].map((i) => [String(minute - i * 60_000), '1', '1', '1', '300.5', '1']),
        )
      return wrap('bitget', { a: [['300.6', '2']], b: [['300.4', '2']], ts: String(now) })
    })
    const market = await new BitgetVenue('paper', transport).market('ZEC-USDT')
    expect(market.instrument.lot).toBe(units('0.001'))
    expect(market.instrument.minQty).toBe(units('0.001'))
    expect(market.instrument.minNotional).toBe(units('1'))
    expect(market.candles).toHaveLength(3)
  })
})
