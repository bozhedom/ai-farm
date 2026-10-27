import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config'
import type { VenueAccess } from './wire'
import { listing } from './universe'
import { decimal, max, units } from './decimal'
import {
  allowPlace,
  boundIp,
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

const list = z.object({ list: z.array(z.unknown()), nextPageCursor: str.optional() })
const details = z.object({
  orderId: str.min(1),
  orderLinkId: str,
  symbol: str,
  side: z.enum(['Buy', 'Sell']),
  orderType: z.literal('Limit'),
  timeInForce: z.literal('IOC'),
  qty: str,
  price: str,
  cumExecQty: str,
  cumExecValue: str,
  orderStatus: str,
  isLeverage: str.optional(),
})

export class BybitVenue implements TradingVenue {
  constructor(
    readonly mode: TradingMode,
    private transport: typeof fetch = fetch,
    private access?: VenueAccess,
  ) {}
  private get host() {
    return this.mode === 'demo' ? 'api-demo.bybit.com' : config().BYBIT_API_HOST
  }
  private async request(
    path: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
    privateCall = false,
  ) {
    const query = new URLSearchParams(params).toString(),
      payload = body ? JSON.stringify(body) : query
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (privateCall) {
      const c = this.access?.credentials || keys('bybit', this.mode),
        stamp = String(Date.now()),
        window = '5000'
      Object.assign(headers, {
        'X-BAPI-API-KEY': c.key,
        'X-BAPI-TIMESTAMP': stamp,
        'X-BAPI-RECV-WINDOW': window,
        'X-BAPI-SIGN': createHmac('sha256', c.secret)
          .update(stamp + c.key + window + payload)
          .digest('hex'),
      })
    }
    const raw = await responseJson(
      this.transport,
      `https://${this.host}${path}${query ? '?' + query : ''}`,
      { method: body ? 'POST' : 'GET', headers, ...(body ? { body: payload } : {}) },
    )
    const result = z.object({ retCode: z.number().int(), result: z.unknown() }).parse(raw)
    if (result.retCode !== 0) throw new ExchangeError(String(result.retCode))
    return result.result
  }
  async discover() {
    // Spot returns the complete list; cursor/limit are not supported for this category.
    const instruments = z
      .array(
        z.object({
          symbol: str,
          baseCoin: str,
          quoteCoin: str,
          status: str,
          stTag: str.optional(),
          symbolType: str.optional(),
        }),
      )
      .parse(
        list.parse(await this.request('/v5/market/instruments-info', { category: 'spot' })).list,
      )
    const at = Date.now()
    const rows = z
      .array(z.object({ symbol: str }).passthrough())
      .parse(list.parse(await this.request('/v5/market/tickers', { category: 'spot' })).list)
    const tickers = new Map(rows.map((r) => [r.symbol, r]))
    const schema = z.object({
      bid1Price: str,
      ask1Price: str,
      lastPrice: str,
      prevPrice24h: str,
      highPrice24h: str,
      lowPrice24h: str,
      turnover24h: str,
    })
    return instruments.flatMap((ins) => {
      const parsed = schema.safeParse(tickers.get(ins.symbol))
      const t = parsed.success ? parsed.data : null
      return listing(
        ins.baseCoin,
        ins.quoteCoin,
        ins.symbol,
        {
          active: ins.status === 'Trading',
          restricted: ins.stTag === '1' || ['xstocks', 'adventure'].includes(ins.symbolType || ''),
        },
        t
          ? {
              at,
              bid: t.bid1Price,
              ask: t.ask1Price,
              last: t.lastPrice,
              open: t.prevPrice24h,
              high: t.highPrice24h,
              low: t.lowPrice24h,
              turnover: t.turnover24h,
            }
          : undefined,
      )
    })
  }
  async market(symbol: TradingSymbol): Promise<Market> {
    const code = compactSymbol(symbol)
    const result = list.parse(
      await this.request('/v5/market/instruments-info', { category: 'spot', symbol: code }),
    )
    const ins = z
      .object({
        symbol: str,
        baseCoin: str,
        quoteCoin: z.literal('USDT'),
        status: z.literal('Trading'),
        lotSizeFilter: z.object({
          basePrecision: str,
          minOrderQty: str,
          minOrderAmt: str,
        }),
        priceFilter: z.object({ tickSize: str }),
      })
      .parse(result.list[0])
    if (ins.symbol !== code || ins.baseCoin !== symbol.split('-')[0])
      throw new Error('TRADING_INSTRUMENT_INVALID')
    const candles = z
      .array(z.array(str))
      .parse(
        list.parse(
          await this.request('/v5/market/kline', {
            category: 'spot',
            symbol: code,
            interval: '1',
            limit: '121',
          }),
        ).list,
      )
      .filter((row) => Number(row[0]) + 60_000 <= Date.now())
      .map((row) => ({ at: Number(row[0]), close: units(row[4]!) }))
      .sort((a, b) => a.at - b.at)
    const b = z
      .object({ s: str, b: levels, a: levels, ts: z.number().int() })
      .parse(
        await this.request('/v5/market/orderbook', { category: 'spot', symbol: code, limit: '50' }),
      )
    if (b.s !== code) throw new Error('TRADING_BOOK_INVALID')
    const lot = units(ins.lotSizeFilter.basePrecision)
    return {
      instrument: {
        symbol,
        lot,
        // basePrecision is the step; minOrderQty is the exchange floor (may be larger).
        minQty: max(lot, units(ins.lotSizeFilter.minOrderQty)),
        minNotional: units(ins.lotSizeFilter.minOrderAmt),
        tick: units(ins.priceFilter.tickSize),
      },
      book: {
        symbol,
        at: b.ts,
        bids: b.b.map((r) => [units(r[0]!), units(r[1]!)]),
        asks: b.a.map((r) => [units(r[0]!), units(r[1]!)]),
      },
      candles,
    }
  }
  async account(symbols: readonly TradingSymbol[]): Promise<Account> {
    const c = this.access?.credentials || keys('bybit', this.mode)
    const time = z.object({ timeSecond: str }).parse(await this.request('/v5/market/time'))
    checkClock(Number(time.timeSecond) * 1000)
    let uid = `demo-key:${c.key}`
    // Query API permissions is outside Bybit's documented demo endpoint set. Demo is fenced
    // by its host/key and must prove trading access through the actual virtual round trip.
    if (this.mode === 'live') {
      const k = z
        .object({
          userID: id,
          readOnly: z.literal(0),
          ips: z.array(str),
          permissions: z.record(str, z.array(str)),
        })
        .parse(await this.request('/v5/user/query-api', {}, undefined, true))
      if (
        !k.permissions.Spot?.includes('SpotTrade') ||
        Object.entries(k.permissions).some(([name, values]) => name !== 'Spot' && values.length > 0)
      )
        throw new Error('TRADING_KEY_PERMISSIONS')
      boundIp(k.ips)
      uid = k.userID
    }
    const info = z
      .object({
        unifiedMarginStatus: z.number().int(),
        marginMode: str,
        spotHedgingStatus: str.optional(),
      })
      .parse(await this.request('/v5/account/info', {}, undefined, true))
    if (
      ![3, 4, 5, 6].includes(info.unifiedMarginStatus) ||
      info.marginMode !== 'REGULAR_MARGIN' ||
      (info.spotHedgingStatus && info.spotHedgingStatus !== 'OFF')
    )
      throw new Error('TRADING_ACCOUNT_MODE')
    const wallet = z
      .object({
        accountType: z.literal('UNIFIED'),
        coin: z.array(
          z.object({
            coin: str,
            walletBalance: str,
            equity: str,
            locked: str,
            borrowAmount: str,
            accruedInterest: str,
            spotBorrow: str.optional(),
            totalPositionIM: str,
            totalOrderIM: str,
            bonus: str.optional(),
            spotHedgingQty: str.optional(),
          }),
        ),
      })
      .parse(
        list.parse(
          await this.request(
            '/v5/account/wallet-balance',
            { accountType: 'UNIFIED' },
            undefined,
            true,
          ),
        ).list[0],
      )
    const balances = emptyBalances()
    for (const coin of wallet.coin) {
      if (
        [coin.borrowAmount, coin.accruedInterest, coin.spotBorrow || '0'].some(
          (v) => units(v) !== 0n,
        )
      )
        throw new Error('TRADING_DEBT_FORBIDDEN')
      if (
        [coin.totalPositionIM, coin.totalOrderIM, coin.spotHedgingQty || '0'].some(
          (v) => !v || units(v) !== 0n,
        ) ||
        units(coin.equity) !== units(coin.walletBalance)
      )
        throw new Error('TRADING_POSITIONS_EXIST')
      if (coin.bonus && units(coin.bonus) !== 0n) throw new Error('TRADING_BALANCE_INVALID')
      setBalance(
        balances,
        coin.coin,
        coin.walletBalance,
        decimal(units(coin.walletBalance) - units(coin.locked)),
      )
    }
    const fees = {} as Account['feeBps']
    for (const symbol of new Set(symbols)) {
      const r = z
        .object({ symbol: str, takerFeeRate: str })
        .parse(
          list.parse(
            await this.request(
              '/v5/account/fee-rate',
              { category: 'spot', symbol: compactSymbol(symbol) },
              undefined,
              true,
            ),
          ).list[0],
        )
      if (r.symbol !== compactSymbol(symbol)) throw new Error('TRADING_FEE_UNKNOWN')
      fees[symbol] = feeBps(units(r.takerFeeRate))
    }
    return { identity: identity('bybit', this.mode, this.host, uid), balances, feeBps: fees }
  }
  async pending() {
    const r = list.parse(
      await this.request(
        '/v5/order/realtime',
        { category: 'spot', openOnly: '0', limit: '50' },
        undefined,
        true,
      ),
    )
    // Any result is sufficient to stop; no need to paginate a nonempty foreign-order list.
    return r.list.map((o) => ({ clientId: z.object({ orderLinkId: str }).parse(o).orderLinkId }))
  }
  async place(order: OrderRequest) {
    allowPlace(this.mode, this.access)
    try {
      const r = z.object({ orderId: str.min(1), orderLinkId: str }).parse(
        await this.request(
          '/v5/order/create',
          {},
          {
            category: 'spot',
            symbol: compactSymbol(order.symbol),
            side: order.side === 'buy' ? 'Buy' : 'Sell',
            orderType: 'Limit',
            qty: decimal(order.qty),
            price: decimal(order.price),
            timeInForce: 'IOC',
            isLeverage: 0,
            orderLinkId: order.clientId,
          },
          true,
        ),
      )
      if (r.orderLinkId !== order.clientId) throw new Error('TRADING_ORDER_UNKNOWN')
    } catch (e) {
      if (e instanceof ExchangeError && e.code === '10001') throw new OrderRejected()
      throw new Error('TRADING_ORDER_UNKNOWN')
    }
  }
  async order(order: OrderRequest): Promise<OrderResult | null> {
    const params = {
      category: 'spot',
      symbol: compactSymbol(order.symbol),
      orderLinkId: order.clientId,
      limit: '50',
    }
    let rows = list.parse(await this.request('/v5/order/realtime', params, undefined, true)).list
    if (!rows.length)
      rows = list.parse(await this.request('/v5/order/history', params, undefined, true)).list
    if (!rows.length) return null
    if (rows.length !== 1) throw new Error('TRADING_ORDER_MISMATCH')
    const o = details.parse(rows[0])
    if (
      o.orderLinkId !== order.clientId ||
      o.symbol !== params.symbol ||
      o.side !== (order.side === 'buy' ? 'Buy' : 'Sell') ||
      units(o.qty) !== order.qty ||
      units(o.price) !== order.price ||
      (o.isLeverage && o.isLeverage !== '0')
    )
      throw new Error('TRADING_ORDER_MISMATCH')
    const states: Record<string, OrderResult['state']> = {
      New: 'live',
      PartiallyFilled: 'partially_filled',
      Filled: 'filled',
      Cancelled: 'canceled',
      PartiallyFilledCanceled: 'canceled',
      Rejected: 'canceled',
    }
    const state = states[o.orderStatus]
    if (!state) throw new Error('TRADING_ORDER_UNKNOWN')
    const filledQty = units(o.cumExecQty)
    let quote = 0n,
      baseFee = 0n,
      quoteFee = 0n,
      sum = 0n
    if (filledQty && ['filled', 'canceled'].includes(state)) {
      const rows = list.parse(
        await this.request(
          '/v5/execution/list',
          { category: 'spot', symbol: params.symbol, orderId: o.orderId, limit: '100' },
          undefined,
          true,
        ),
      )
      const seen = new Set<string>()
      for (const row of rows.list) {
        const f = z
          .object({
            orderId: str,
            orderLinkId: str,
            symbol: str,
            side: str,
            execId: str,
            execType: z.literal('Trade'),
            execQty: str,
            execValue: str,
            execFee: str,
            feeCurrency: str,
            extraFees: z.unknown().optional(),
          })
          .parse(row)
        if (
          f.orderId !== o.orderId ||
          f.orderLinkId !== order.clientId ||
          f.symbol !== params.symbol ||
          f.side !== o.side ||
          seen.has(f.execId) ||
          units(f.execQty) <= 0n ||
          units(f.execValue) <= 0n
        )
          throw new Error('TRADING_FILL_INVALID')
        if (f.extraFees && (!Array.isArray(f.extraFees) || f.extraFees.length))
          throw new Error('TRADING_FEE_UNKNOWN')
        seen.add(f.execId)
        sum += units(f.execQty)
        quote += units(f.execValue)
        const charge = -units(f.execFee)
        if (f.feeCurrency === 'USDT') quoteFee += charge
        else if (f.feeCurrency === order.symbol.split('-')[0]) baseFee += charge
        else if (charge) throw new Error('TRADING_FEE_CURRENCY')
      }
      if (sum !== filledQty || quote !== units(o.cumExecValue))
        throw new Error('TRADING_FILLS_INCOMPLETE')
    }
    return { ...order, exchangeId: o.orderId, state, filledQty, quote, baseFee, quoteFee }
  }
  async cancel(order: OrderRequest) {
    await this.request(
      '/v5/order/cancel',
      {},
      { category: 'spot', symbol: compactSymbol(order.symbol), orderLinkId: order.clientId },
      true,
    )
  }
}
