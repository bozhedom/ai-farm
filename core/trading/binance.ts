import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { listing } from './universe'
import { decimal, max, units } from './decimal'
import {
  allowPlace,
  checkClock,
  compactSymbol,
  emptyBalances,
  ExchangeError,
  feeBps,
  id,
  identity,
  keys,
  levels,
  OrderRejected,
  responseJson,
  setBalance,
  str,
} from './wire'
import type {
  Account,
  Market,
  OrderRequest,
  OrderResult,
  TradingMode,
  TradingSymbol,
  TradingVenue,
} from './types'

export class BinanceVenue implements TradingVenue {
  constructor(
    readonly mode: TradingMode,
    private transport: typeof fetch = fetch,
  ) {}
  private get host() {
    return this.mode === 'demo' ? 'testnet.binance.vision' : 'api.binance.com'
  }
  private async request(
    path: string,
    params: Record<string, string> = {},
    method = 'GET',
    privateCall = false,
  ) {
    const p = new URLSearchParams(params),
      headers: Record<string, string> = {}
    if (privateCall) {
      const c = keys('binance', this.mode)
      p.set('timestamp', String(Date.now()))
      p.set('recvWindow', '5000')
      p.set('signature', createHmac('sha256', c.secret).update(p.toString()).digest('hex'))
      headers['X-MBX-APIKEY'] = c.key
    }
    const raw = await responseJson(
      this.transport,
      `https://${this.host}${path}${p.size ? '?' + p.toString() : ''}`,
      { method, headers },
    )
    const error = z.object({ code: z.number().int() }).safeParse(raw)
    if (error.success && error.data.code !== 0) throw new ExchangeError(String(error.data.code))
    return raw
  }
  async discover() {
    const instruments = z
      .object({
        symbols: z.array(
          z.object({
            symbol: str,
            baseAsset: str,
            quoteAsset: str,
            status: str,
            isSpotTradingAllowed: z.boolean(),
          }),
        ),
      })
      .parse(await this.request('/api/v3/exchangeInfo', { permissions: 'SPOT' })).symbols
    const at = Date.now()
    const rows = z
      .array(z.object({ symbol: str }).passthrough())
      .parse(await this.request('/api/v3/ticker/24hr'))
    const tickers = new Map(rows.map((r) => [r.symbol, r]))
    const schema = z.object({
      bidPrice: str,
      askPrice: str,
      lastPrice: str,
      openPrice: str,
      highPrice: str,
      lowPrice: str,
      quoteVolume: str,
      closeTime: z.number().int(),
    })
    return instruments.flatMap((ins) => {
      const parsed = schema.safeParse(tickers.get(ins.symbol))
      const t = parsed.success ? parsed.data : null
      return listing(
        ins.baseAsset,
        ins.quoteAsset,
        ins.symbol,
        { active: ins.status === 'TRADING' && ins.isSpotTradingAllowed },
        t
          ? {
              at: Math.min(at, t.closeTime),
              bid: t.bidPrice,
              ask: t.askPrice,
              last: t.lastPrice,
              open: t.openPrice,
              high: t.highPrice,
              low: t.lowPrice,
              turnover: t.quoteVolume,
            }
          : undefined,
      )
    })
  }
  async market(symbol: TradingSymbol): Promise<Market> {
    const code = compactSymbol(symbol)
    const r = z
      .object({ symbols: z.array(z.unknown()) })
      .parse(await this.request('/api/v3/exchangeInfo', { symbol: code }))
    const ins = z
      .object({
        symbol: str,
        status: z.literal('TRADING'),
        baseAsset: str,
        quoteAsset: z.literal('USDT'),
        isSpotTradingAllowed: z.literal(true),
        filters: z.array(z.object({ filterType: str }).passthrough()),
      })
      .parse(r.symbols[0])
    if (ins.symbol !== code || ins.baseAsset !== symbol.split('-')[0])
      throw new Error('TRADING_INSTRUMENT_INVALID')
    const lot = z
      .object({ stepSize: str, minQty: str })
      .parse(ins.filters.find((f) => f.filterType === 'LOT_SIZE'))
    const price = z
      .object({ tickSize: str })
      .parse(ins.filters.find((f) => f.filterType === 'PRICE_FILTER'))
    const minimum = z
      .object({ minNotional: str })
      .parse(
        ins.filters.find((f) => f.filterType === 'NOTIONAL') ||
          ins.filters.find((f) => f.filterType === 'MIN_NOTIONAL'),
      )
    const candles = z
      .array(
        z.tuple([z.number().int(), str, str, str, str, str, z.number().int()]).rest(z.unknown()),
      )
      .parse(await this.request('/api/v3/klines', { symbol: code, interval: '1m', limit: '121' }))
      .filter((row) => row[6] < Date.now())
      .map((row) => ({ at: row[0], close: units(row[4]) }))
    // Binance REST depth has an update ID, no event timestamp. Bound snapshot age from
    // request start, not response receipt, and independently verify the exchange clock.
    const at = Date.now()
    const b = z
      .object({ lastUpdateId: id, bids: levels, asks: levels })
      .parse(await this.request('/api/v3/depth', { symbol: code, limit: '20' }))
    return {
      instrument: {
        symbol,
        lot: units(lot.stepSize),
        minQty: units(lot.minQty),
        tick: units(price.tickSize),
        minNotional: units(minimum.minNotional),
      },
      book: {
        symbol,
        at,
        bids: b.bids.map((r) => [units(r[0]!), units(r[1]!)]),
        asks: b.asks.map((r) => [units(r[0]!), units(r[1]!)]),
      },
      candles,
    }
  }
  async account(symbols: readonly TradingSymbol[]): Promise<Account> {
    keys('binance', this.mode)
    checkClock(
      z.object({ serverTime: z.number().int() }).parse(await this.request('/api/v3/time'))
        .serverTime,
    )
    // Spot Testnet intentionally has no /sapi endpoints. On live, verify the key's scope/IP.
    if (this.mode === 'live') {
      const p = z
        .object({
          ipRestrict: z.boolean(),
          enableReading: z.boolean(),
          enableSpotAndMarginTrading: z.boolean(),
          enableWithdrawals: z.boolean(),
          enableMargin: z.boolean(),
          enableFutures: z.boolean(),
          enablePortfolioMarginTrading: z.boolean().optional(),
          enableVanillaOptions: z.boolean().optional(),
          enableInternalTransfer: z.boolean().optional(),
          permitsUniversalTransfer: z.boolean().optional(),
        })
        .parse(await this.request('/sapi/v1/account/apiRestrictions', {}, 'GET', true))
      if (!p.ipRestrict) throw new Error('TRADING_IP_REQUIRED')
      if (
        !p.enableReading ||
        !p.enableSpotAndMarginTrading ||
        p.enableWithdrawals ||
        p.enableMargin ||
        p.enableFutures ||
        p.enablePortfolioMarginTrading ||
        p.enableVanillaOptions ||
        p.enableInternalTransfer ||
        p.permitsUniversalTransfer
      )
        throw new Error('TRADING_KEY_PERMISSIONS')
    }
    const a = z
      .object({
        uid: id,
        accountType: z.literal('SPOT'),
        canTrade: z.literal(true),
        permissions: z.array(str),
        balances: z.array(z.object({ asset: str, free: str, locked: str })),
      })
      .parse(await this.request('/api/v3/account', {}, 'GET', true))
    if (!a.permissions.includes('SPOT')) throw new Error('TRADING_KEY_PERMISSIONS')
    const balances = emptyBalances()
    for (const b of a.balances)
      setBalance(balances, b.asset, decimal(units(b.free) + units(b.locked)), b.free)
    const fees = {} as Account['feeBps']
    const rate = z.object({ taker: str, buyer: str, seller: str })
    for (const symbol of new Set(symbols)) {
      const c = z
        .object({
          symbol: str,
          standardCommission: rate,
          specialCommission: rate,
          taxCommission: rate,
          discount: z.object({ enabledForAccount: z.boolean(), enabledForSymbol: z.boolean() }),
        })
        .parse(
          await this.request(
            '/api/v3/account/commission',
            { symbol: compactSymbol(symbol) },
            'GET',
            true,
          ),
        )
      if (c.symbol !== compactSymbol(symbol)) throw new Error('TRADING_FEE_UNKNOWN')
      if (c.discount.enabledForAccount && c.discount.enabledForSymbol)
        throw new Error('TRADING_FEE_TOKEN_ENABLED')
      const total = [c.standardCommission, c.specialCommission, c.taxCommission].reduce(
        (sum, r) => sum + units(r.taker) + max(units(r.buyer), units(r.seller)),
        0n,
      )
      fees[symbol] = feeBps(total)
    }
    return { identity: identity('binance', this.mode, this.host, a.uid), balances, feeBps: fees }
  }
  async pending() {
    return z
      .array(z.object({ clientOrderId: str }))
      .parse(await this.request('/api/v3/openOrders', {}, 'GET', true))
      .map((o) => ({ clientId: o.clientOrderId }))
  }
  async place(order: OrderRequest) {
    allowPlace(this.mode)
    try {
      const r = z.object({ orderId: id, clientOrderId: str, symbol: str }).parse(
        await this.request(
          '/api/v3/order',
          {
            symbol: compactSymbol(order.symbol),
            side: order.side.toUpperCase(),
            type: 'LIMIT',
            timeInForce: 'IOC',
            quantity: decimal(order.qty),
            price: decimal(order.price),
            newClientOrderId: order.clientId,
            newOrderRespType: 'ACK',
          },
          'POST',
          true,
        ),
      )
      if (r.clientOrderId !== order.clientId || r.symbol !== compactSymbol(order.symbol))
        throw new Error('TRADING_ORDER_UNKNOWN')
    } catch (e) {
      // -2010 may mean a duplicate client ID, so it is deliberately not a definitive rejection.
      if (e instanceof ExchangeError && ['-1013', '-1100', '-1102', '-1111'].includes(e.code))
        throw new OrderRejected()
      throw new Error('TRADING_ORDER_UNKNOWN')
    }
  }
  async order(order: OrderRequest): Promise<OrderResult | null> {
    let raw: unknown
    try {
      raw = await this.request(
        '/api/v3/order',
        { symbol: compactSymbol(order.symbol), origClientOrderId: order.clientId },
        'GET',
        true,
      )
    } catch (e) {
      if (e instanceof ExchangeError && e.code === '-2013') return null
      throw e
    }
    const o = z
      .object({
        symbol: str,
        orderId: id,
        clientOrderId: str,
        price: str,
        origQty: str,
        executedQty: str,
        cummulativeQuoteQty: str,
        status: str,
        timeInForce: z.literal('IOC'),
        type: z.literal('LIMIT'),
        side: str,
      })
      .parse(raw)
    if (
      o.symbol !== compactSymbol(order.symbol) ||
      o.clientOrderId !== order.clientId ||
      o.side !== order.side.toUpperCase() ||
      units(o.origQty) !== order.qty ||
      units(o.price) !== order.price
    )
      throw new Error('TRADING_ORDER_MISMATCH')
    const states: Record<string, OrderResult['state']> = {
      NEW: 'live',
      PENDING_NEW: 'live',
      PARTIALLY_FILLED: 'partially_filled',
      FILLED: 'filled',
      CANCELED: 'canceled',
      EXPIRED: 'canceled',
      EXPIRED_IN_MATCH: 'canceled',
      REJECTED: 'canceled',
    }
    const state = states[o.status]
    if (!state) throw new Error('TRADING_ORDER_UNKNOWN')
    const filledQty = units(o.executedQty)
    let quote = 0n,
      baseFee = 0n,
      quoteFee = 0n,
      sum = 0n
    if (filledQty && ['filled', 'canceled'].includes(state)) {
      const fills = z
        .array(
          z.object({
            id,
            orderId: id,
            symbol: str,
            qty: str,
            quoteQty: str,
            commission: str,
            commissionAsset: str,
            isBuyer: z.boolean(),
          }),
        )
        .parse(
          await this.request(
            '/api/v3/myTrades',
            { symbol: o.symbol, orderId: o.orderId, limit: '1000' },
            'GET',
            true,
          ),
        )
      const seen = new Set<string>()
      for (const f of fills) {
        if (
          f.orderId !== o.orderId ||
          f.symbol !== o.symbol ||
          f.isBuyer !== (order.side === 'buy') ||
          seen.has(f.id) ||
          units(f.qty) <= 0n ||
          units(f.quoteQty) <= 0n
        )
          throw new Error('TRADING_FILL_INVALID')
        seen.add(f.id)
        sum += units(f.qty)
        quote += units(f.quoteQty)
        const charge = -units(f.commission)
        if (f.commissionAsset === 'USDT') quoteFee += charge
        else if (f.commissionAsset === order.symbol.split('-')[0]) baseFee += charge
        else if (charge) throw new Error('TRADING_FEE_CURRENCY')
      }
      if (sum !== filledQty || quote !== units(o.cummulativeQuoteQty))
        throw new Error('TRADING_FILLS_INCOMPLETE')
    }
    return { ...order, exchangeId: o.orderId, state, filledQty, quote, baseFee, quoteFee }
  }
  async cancel(order: OrderRequest) {
    await this.request(
      '/api/v3/order',
      { symbol: compactSymbol(order.symbol), origClientOrderId: order.clientId },
      'DELETE',
      true,
    )
  }
}
