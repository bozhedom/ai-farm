import { createHash } from 'node:crypto'
import { EXECUTION_POLICY as P } from '../../policy'
import { decimal, units } from '../../trading/decimal'
import type { Market, TradingSymbol } from '../../trading/types'
import { BybitFundingAdapter, type BybitFundingOptions, type FundingMarket } from './bybit-funding'
import {
  ExecutionRejected,
  type ExecutionExchange,
  type ExecutionIntent,
  type ExecutionReceipt,
  type PreparedExecution,
} from '../types'
import {
  alreadyConfigured,
  assertLiveWrite,
  buildRequest,
  compactSymbol,
  okxSpotSymbol,
  okxSwapSymbol,
  requireRetOk,
  sendRequest,
  type RestCredentials,
  type RestKind,
} from './rest'

export type FundingCredentials = RestCredentials
export type FundingVenueOptions = {
  mode: 'demo' | 'live'
  exchange: ExecutionExchange
  credentials: FundingCredentials
  liveEnabled?: boolean
  authorizeWrite?: () => boolean | Promise<boolean>
}

export type FundingVenueClient = Pick<
  BybitFundingAdapter,
  | 'market'
  | 'discover'
  | 'account'
  | 'positions'
  | 'pending'
  | 'fundingHistory'
  | 'fundingRates'
  | 'prepare'
  | 'broadcast'
  | 'lookup'
  | 'cancel'
>

export function createFundingVenue(
  options: FundingVenueOptions,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): FundingVenueClient {
  if (options.exchange === 'bybit') {
    return new BybitFundingAdapter(
      {
        mode: options.mode,
        credentials: { key: options.credentials.key, secret: options.credentials.secret },
        liveEnabled: options.liveEnabled,
        authorizeWrite: options.authorizeWrite ? async () => options.authorizeWrite!() : undefined,
      } satisfies BybitFundingOptions,
      fetchImpl,
      now,
    )
  }
  return new RestFundingAdapter(options, fetchImpl, now)
}

function amount(value: unknown) {
  if (value === undefined || value === null || value === '') return 0n
  return units(String(value))
}

function asMarket(symbol: TradingSymbol, tick: bigint, lot: bigint, minQty: bigint, minNotional: bigint, bid: bigint, ask: bigint, at: number): Market {
  const last = ask || bid
  return {
    instrument: { symbol, lot, minQty, tick, minNotional },
    book: { symbol, at, bids: [[bid || last, units('1')]], asks: [[ask || last, units('1')]] },
    candles: [
      { at: at - 120_000, close: last },
      { at: at - 60_000, close: last },
      { at, close: last },
    ],
  }
}

class RestFundingAdapter implements FundingVenueClient {
  constructor(
    private readonly options: FundingVenueOptions,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number,
  ) {}

  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    p: { query?: Record<string, string>; body?: Record<string, unknown>; signed?: boolean; kind?: RestKind } = {},
  ) {
    const built = buildRequest({
      exchange: this.options.exchange,
      mode: this.options.mode,
      kind: p.kind || (path.includes('/fapi/') ? 'futures' : this.options.exchange === 'binance' ? 'spot' : 'futures'),
      method,
      path,
      query: p.query,
      body: p.body,
      credentials: this.options.credentials,
      signed: p.signed,
      now: this.now(),
    })
    const raw = await sendRequest(built, this.fetchImpl)
    try {
      return requireRetOk(this.options.exchange, raw)
    } catch (error) {
      if (alreadyConfigured(this.options.exchange, raw)) return raw
      throw error
    }
  }

  private spotCode(symbol: TradingSymbol) {
    return this.options.exchange === 'okx' ? okxSpotSymbol(symbol) : compactSymbol(symbol)
  }
  private perpCode(symbol: TradingSymbol) {
    return this.options.exchange === 'okx' ? okxSwapSymbol(symbol) : compactSymbol(symbol)
  }

  async discover(): Promise<TradingSymbol[]> {
    return ['BTC-USDT', 'ETH-USDT']
  }

  async market(symbol: TradingSymbol): Promise<FundingMarket> {
    compactSymbol(symbol)
    const at = this.now()
    if (this.options.exchange === 'okx') {
      const inst = (await this.call('GET', '/api/v5/public/instruments', { query: { instType: 'SWAP', instId: this.perpCode(symbol) } })) as {
        tickSz?: string
        lotSz?: string
        minSz?: string
        ctVal?: string
      }[]
      const ctVal = amount(inst?.[0]?.ctVal || '1')
      const spotBooks = (await this.call('GET', '/api/v5/market/books', { query: { instId: this.spotCode(symbol), sz: '1' } })) as {
        ts?: string
        bids?: string[][]
        asks?: string[][]
      }[]
      const perpBooks = (await this.call('GET', '/api/v5/market/books', { query: { instId: this.perpCode(symbol), sz: '1' } })) as {
        ts?: string
        bids?: string[][]
        asks?: string[][]
      }[]
      const rate = (await this.call('GET', '/api/v5/public/funding-rate', { query: { instId: this.perpCode(symbol) } })) as {
        fundingRate?: string
        fundingTime?: string
        nextFundingTime?: string
      }[]
      const fundingRate = amount(rate?.[0]?.fundingRate || '0')
      const nextFundingAt = Number(rate?.[0]?.fundingTime || rate?.[0]?.nextFundingTime || at)
      const tick = amount(inst?.[0]?.tickSz || '0.01')
      return {
        spot: asMarket(symbol, tick, units('0.00001'), units('0.00001'), units('5'), amount(spotBooks?.[0]?.bids?.[0]?.[0]), amount(spotBooks?.[0]?.asks?.[0]?.[0]), Number(spotBooks?.[0]?.ts || at)),
        perp: asMarket(symbol, tick, ctVal, amount(inst?.[0]?.minSz || '1') * ctVal, units('5'), amount(perpBooks?.[0]?.bids?.[0]?.[0]), amount(perpBooks?.[0]?.asks?.[0]?.[0]), Number(perpBooks?.[0]?.ts || at)),
        spotMaxQty: units('100'),
        perpMaxQty: units('100'),
        fundingRate,
        fundingIntervalMinutes: 480,
        nextFundingAt,
        at,
      }
    }
    if (this.options.exchange === 'binance') {
      const depthSpot = (await this.call('GET', '/api/v3/depth', { query: { symbol: this.spotCode(symbol), limit: '5' }, kind: 'spot' })) as {
        bids?: string[][]
        asks?: string[][]
      }
      const depthPerp = (await this.call('GET', '/fapi/v1/depth', { query: { symbol: this.perpCode(symbol), limit: '5' }, kind: 'futures' })) as {
        bids?: string[][]
        asks?: string[][]
      }
      const premium = (await this.call('GET', '/fapi/v1/premiumIndex', { query: { symbol: this.perpCode(symbol) }, kind: 'futures' })) as {
        lastFundingRate?: string
        nextFundingTime?: number
      }
      return {
        spot: asMarket(symbol, units('0.01'), units('0.00001'), units('0.00001'), units('5'), amount(depthSpot.bids?.[0]?.[0]), amount(depthSpot.asks?.[0]?.[0]), at),
        perp: asMarket(symbol, units('0.01'), units('0.001'), units('0.001'), units('5'), amount(depthPerp.bids?.[0]?.[0]), amount(depthPerp.asks?.[0]?.[0]), at),
        spotMaxQty: units('100'),
        perpMaxQty: units('100'),
        fundingRate: amount(premium.lastFundingRate || '0'),
        fundingIntervalMinutes: 480,
        nextFundingAt: Number(premium.nextFundingTime || at),
        at,
      }
    }
    const spot = (await this.call('GET', '/api/v2/spot/market/orderbook', { query: { symbol: this.spotCode(symbol), type: 'step0', limit: '1' }, kind: 'spot' })) as {
      bids?: string[][]
      asks?: string[][]
      ts?: string
    }
    const perp = (await this.call('GET', '/api/v2/mix/market/orderbook', {
      query: { productType: 'USDT-FUTURES', symbol: this.perpCode(symbol), limit: '1' },
    })) as { bids?: string[][]; asks?: string[][]; ts?: string }
    const rate = (await this.call('GET', '/api/v2/mix/market/current-fund-rate', {
      query: { productType: 'USDT-FUTURES', symbol: this.perpCode(symbol) },
    })) as { fundingRate?: string; nextUpdate?: string }[] | { fundingRate?: string; nextUpdate?: string }
    const row = Array.isArray(rate) ? rate[0] : rate
    return {
      spot: asMarket(symbol, units('0.01'), units('0.00001'), units('0.00001'), units('5'), amount(spot.bids?.[0]?.[0]), amount(spot.asks?.[0]?.[0]), Number(spot.ts || at)),
      perp: asMarket(symbol, units('0.01'), units('0.001'), units('0.001'), units('5'), amount(perp.bids?.[0]?.[0]), amount(perp.asks?.[0]?.[0]), Number(perp.ts || at)),
      spotMaxQty: units('100'),
      perpMaxQty: units('100'),
      fundingRate: amount(row?.fundingRate || '0'),
      fundingIntervalMinutes: 480,
      nextFundingAt: Number(row?.nextUpdate || at),
      at,
    }
  }

  async account() {
    return {
      identity: createHash('sha256')
        .update(`${this.options.exchange}:${this.options.mode}:${this.options.credentials.key}`)
        .digest('hex'),
      balances: { USDT: { total: 0n, available: 0n } },
      availableMargin: 0n,
      positions: [],
      feeBps: { spot: P.maxFeeBps, perp: P.maxFeeBps },
    }
  }

  async positions() {
    return []
  }
  async pending() {
    return []
  }
  async fundingHistory(_symbol: TradingSymbol, _from: number, _to: number) {
    return [] as { id: string; symbol: TradingSymbol; at: number; amount: bigint }[]
  }
  async fundingRates(symbol: TradingSymbol, from: number, to: number) {
    if (this.options.exchange === 'okx') {
      const rows = (await this.call('GET', '/api/v5/public/funding-rate-history', {
        query: { instId: this.perpCode(symbol) },
      })) as { fundingRate?: string; fundingTime?: string }[]
      return (rows || [])
        .map((row) => ({ at: Number(row.fundingTime || 0), rate: amount(row.fundingRate) }))
        .filter((row) => row.at >= from && row.at <= to)
    }
    if (this.options.exchange === 'binance') {
      const rows = (await this.call('GET', '/fapi/v1/fundingRate', {
        query: { symbol: this.perpCode(symbol), startTime: String(from), endTime: String(to) },
        kind: 'futures',
      })) as { fundingRate?: string; fundingTime?: number }[]
      return (rows || []).map((row) => ({ at: Number(row.fundingTime || 0), rate: amount(row.fundingRate) }))
    }
    const rows = (await this.call('GET', '/api/v2/mix/market/history-fund-rate', {
      query: { productType: 'USDT-FUTURES', symbol: this.perpCode(symbol) },
    })) as { fundingRate?: string; fundingTime?: string }[]
    return (rows || []).map((row) => ({ at: Number(row.fundingTime || 0), rate: amount(row.fundingRate) }))
  }

  async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
    if (!['buy', 'sell', 'short', 'cover'].includes(intent.action)) throw new Error('EXECUTION_INTENT_INVALID')
    const market = await this.market(intent.symbol as TradingSymbol)
    const qty = units(intent.quantity)
    if (qty <= 0n) throw new ExecutionRejected('EXECUTION_ORDER_SIZE')
    const leg = ['buy', 'sell'].includes(intent.action) ? market.spot : market.perp
    if (qty % leg.instrument.lot) throw new ExecutionRejected('EXECUTION_ORDER_SIZE')
    return { intent, payload: { mode: this.options.mode, exchange: this.options.exchange }, externalId: null }
  }

  async broadcast(prepared: PreparedExecution) {
    assertLiveWrite(this.options.mode, this.options.liveEnabled)
    if (this.options.authorizeWrite && !(await this.options.authorizeWrite())) throw new Error('EXECUTION_WRITE_FORBIDDEN')
    const intent = prepared.intent
    const spot = ['buy', 'sell'].includes(intent.action)
    const side = ['buy', 'cover'].includes(intent.action) ? 'buy' : 'sell'
    if (this.options.exchange === 'okx') {
      if (!spot) {
        await this.call('POST', '/api/v5/account/set-leverage', {
          signed: true,
          body: { instId: this.perpCode(intent.symbol as TradingSymbol), lever: '1', mgnMode: 'isolated' },
        })
      }
      const market = await this.market(intent.symbol as TradingSymbol)
      const sz = spot ? intent.quantity : decimal(units(intent.quantity) / market.perp.instrument.lot).replace(/\.?0+$/, '') || '1'
      await this.call('POST', '/api/v5/trade/order', {
        signed: true,
        body: {
          instId: spot ? this.spotCode(intent.symbol as TradingSymbol) : this.perpCode(intent.symbol as TradingSymbol),
          tdMode: spot ? 'cash' : 'isolated',
          side,
          ordType: 'ioc',
          sz,
          px: intent.limitPrice,
          clOrdId: intent.clientId.replace(/[^0-9A-Za-z]/g, '').slice(0, 32),
          reduceOnly: intent.action === 'cover' ? 'true' : undefined,
        },
      })
      return
    }
    if (this.options.exchange === 'binance') {
      if (spot) {
        await this.call('POST', '/api/v3/order', {
          signed: true,
          kind: 'spot',
          body: {
            symbol: this.spotCode(intent.symbol as TradingSymbol),
            side: side.toUpperCase(),
            type: 'LIMIT',
            timeInForce: 'IOC',
            quantity: intent.quantity,
            price: intent.limitPrice,
            newClientOrderId: intent.clientId,
          },
        })
        return
      }
      await this.call('POST', '/fapi/v1/marginType', {
        signed: true,
        kind: 'futures',
        body: { symbol: this.perpCode(intent.symbol as TradingSymbol), marginType: 'ISOLATED' },
      })
      await this.call('POST', '/fapi/v1/leverage', {
        signed: true,
        kind: 'futures',
        body: { symbol: this.perpCode(intent.symbol as TradingSymbol), leverage: '1' },
      })
      await this.call('POST', '/fapi/v1/order', {
        signed: true,
        kind: 'futures',
        body: {
          symbol: this.perpCode(intent.symbol as TradingSymbol),
          side: side.toUpperCase(),
          type: 'LIMIT',
          timeInForce: 'IOC',
          quantity: intent.quantity,
          price: intent.limitPrice,
          newClientOrderId: intent.clientId,
          reduceOnly: intent.action === 'cover' ? 'true' : undefined,
        },
      })
      return
    }
    if (spot) {
      await this.call('POST', '/api/v2/spot/trade/place-order', {
        signed: true,
        kind: 'spot',
        body: {
          symbol: this.spotCode(intent.symbol as TradingSymbol),
          side,
          orderType: 'limit',
          force: 'ioc',
          size: intent.quantity,
          price: intent.limitPrice,
          clientOid: intent.clientId,
        },
      })
      return
    }
    await this.call('POST', '/api/v2/mix/account/set-margin-mode', {
      signed: true,
      body: { symbol: this.perpCode(intent.symbol as TradingSymbol), productType: 'USDT-FUTURES', marginCoin: 'USDT', marginMode: 'isolated' },
    })
    await this.call('POST', '/api/v2/mix/account/set-leverage', {
      signed: true,
      body: { symbol: this.perpCode(intent.symbol as TradingSymbol), productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage: '1' },
    })
    await this.call('POST', '/api/v2/mix/order/place-order', {
      signed: true,
      body: {
        symbol: this.perpCode(intent.symbol as TradingSymbol),
        productType: 'USDT-FUTURES',
        marginMode: 'isolated',
        marginCoin: 'USDT',
        size: intent.quantity,
        price: intent.limitPrice,
        side,
        orderType: 'limit',
        force: 'ioc',
        clientOid: intent.clientId,
        reduceOnly: intent.action === 'cover' ? 'YES' : 'NO',
      },
    })
  }

  async lookup(): Promise<ExecutionReceipt | null> {
    return {
      status: 'pending',
      externalId: null,
      filledQuantity: '0',
      grossQuote: '0',
      quoteFee: '0',
      baseFee: '0',
    }
  }

  async cancel(prepared?: PreparedExecution) {
    if (!prepared) return
    assertLiveWrite(this.options.mode, this.options.liveEnabled)
    const spot = ['buy', 'sell'].includes(prepared.intent.action)
    if (this.options.exchange === 'okx') {
      await this.call('POST', '/api/v5/trade/cancel-order', {
        signed: true,
        body: {
          instId: spot ? this.spotCode(prepared.intent.symbol as TradingSymbol) : this.perpCode(prepared.intent.symbol as TradingSymbol),
          clOrdId: prepared.intent.clientId.replace(/[^0-9A-Za-z]/g, '').slice(0, 32),
        },
      })
    }
  }
}

export function fundingEnvPrefix(exchange: ExecutionExchange, mode: 'demo' | 'live') {
  return `FUNDING_${exchange.toUpperCase()}_${mode.toUpperCase()}`
}

export function parsePositive(value: string) {
  const amountValue = units(value)
  if (amountValue <= 0n) throw new Error('EXECUTION_DECIMAL_INVALID')
  return amountValue
}
