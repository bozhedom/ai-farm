import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { TRADING_POLICY as P } from '../policy'
import { decimal, units } from './decimal'
import {
  allowPlace,
  boundIp,
  checkClock,
  compactSymbol,
  emptyBalances,
  ExchangeError,
  feeBps,
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

const precision = str
  .regex(/^\d{1,2}$/)
  .transform(Number)
  .refine((n) => n <= 18)
export class BitgetVenue implements TradingVenue {
  constructor(
    readonly mode: TradingMode,
    private transport: typeof fetch = fetch,
  ) {}
  private async request(
    path: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
    privateCall = false,
  ) {
    const query = new URLSearchParams(
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    ).toString()
    const target = path + (query ? '?' + query : ''),
      payload = body ? JSON.stringify(body) : '',
      method = body ? 'POST' : 'GET'
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // This header is required on public market requests too, to use the demo order book.
    if (this.mode === 'demo') headers.paptrading = '1'
    if (privateCall) {
      const c = keys('bitget', this.mode),
        stamp = String(Date.now())
      Object.assign(headers, {
        'ACCESS-KEY': c.key,
        'ACCESS-PASSPHRASE': c.passphrase,
        'ACCESS-TIMESTAMP': stamp,
        'ACCESS-SIGN': createHmac('sha256', c.secret)
          .update(stamp + method + target + payload)
          .digest('base64'),
      })
    }
    const r = z.object({ code: str, data: z.unknown(), requestTime: z.number().int() }).parse(
      await responseJson(
        this.transport,
        'https://api.bitget.com' + target,
        {
          method,
          headers,
          ...(body ? { body: payload } : {}),
        },
        true,
      ),
    )
    if (r.code !== '00000') throw new ExchangeError(r.code)
    if (privateCall) checkClock(r.requestTime)
    return r.data
  }
  async market(symbol: TradingSymbol): Promise<Market> {
    const code = compactSymbol(symbol),
      params = { category: 'SPOT', symbol: code }
    const instruments = z
      .array(
        z.object({
          symbol: str,
          baseCoin: str,
          quoteCoin: z.literal('USDT'),
          status: z.literal('online'),
          pricePrecision: precision,
          quantityPrecision: precision,
          minOrderQty: str,
          minOrderAmount: str,
        }),
      )
      .parse(await this.request('/api/v3/market/instruments', params))
    const ins = instruments.find((i) => i.symbol === code)
    if (!ins || ins.baseCoin !== symbol.split('-')[0]) throw new Error('TRADING_INSTRUMENT_INVALID')
    const candles = z
      .array(z.array(str).min(5))
      .parse(
        await this.request('/api/v3/market/candles', { ...params, interval: '1m', limit: '121' }),
      )
      .filter((c) => Number(c[0]) + 60_000 <= Date.now())
      .map((c) => ({ at: Number(c[0]), close: units(c[4]!) }))
      .sort((a, b) => a.at - b.at)
    const b = z
      .object({ a: levels, b: levels, ts: str })
      .parse(await this.request('/api/v3/market/orderbook', { ...params, limit: '50' }))
    return {
      instrument: {
        symbol,
        lot: 10n ** BigInt(18 - ins.quantityPrecision),
        minQty: units(ins.minOrderQty),
        tick: 10n ** BigInt(18 - ins.pricePrecision),
        minNotional: units(ins.minOrderAmount),
      },
      book: {
        symbol,
        at: Number(b.ts),
        bids: b.b.map((r) => [units(r[0]!), units(r[1]!)]),
        asks: b.a.map((r) => [units(r[0]!), units(r[1]!)]),
      },
      candles,
    }
  }
  async account(): Promise<Account> {
    const info = z
      .object({ userId: str.min(1), ips: str, permType: str, permissions: z.array(str) })
      .parse(await this.request('/api/v3/account/info', {}, undefined, true))
    if (
      info.permType !== 'read-and-write' ||
      !info.permissions.includes('uta_trade') ||
      !info.permissions.includes('uta_mgt') ||
      info.permissions.some((p) => !['uta_trade', 'uta_mgt'].includes(p))
    )
      throw new Error('TRADING_KEY_PERMISSIONS')
    if (this.mode === 'live') boundIp(info.ips.split(','))
    const settings = z
      .object({ uid: str, accountMode: str, accountLevel: str, deltaSwitch: str })
      .parse(await this.request('/api/v3/account/settings', {}, undefined, true))
    if (
      settings.uid !== info.userId ||
      !['unified', 'hybrid'].includes(settings.accountMode) ||
      settings.accountLevel !== 'basic' ||
      settings.deltaSwitch !== 'no'
    )
      throw new Error('TRADING_ACCOUNT_MODE')
    if (
      z
        .object({ deduct: str })
        .parse(await this.request('/api/v3/account/deduct-info', {}, undefined, true)).deduct !==
      'off'
    )
      throw new Error('TRADING_FEE_TOKEN_ENABLED')
    const a = z
      .object({
        unrealisedPnl: str,
        mmr: str,
        imr: str,
        positionValue: str,
        assets: z.array(
          z.object({
            coin: str,
            balance: str,
            equity: str,
            available: str,
            debt: str,
            interestBase: str,
            bonus: str.optional(),
          }),
        ),
      })
      .parse(await this.request('/api/v3/account/assets', {}, undefined, true))
    if ([a.unrealisedPnl, a.mmr, a.imr, a.positionValue].some((v) => units(v) !== 0n))
      throw new Error('TRADING_POSITIONS_EXIST')
    const balances = emptyBalances()
    for (const b of a.assets) {
      if (units(b.debt) || units(b.interestBase)) throw new Error('TRADING_DEBT_FORBIDDEN')
      if (units(b.balance) !== units(b.equity) || units(b.bonus || '0'))
        throw new Error('TRADING_BALANCE_INVALID')
      setBalance(balances, b.coin, b.balance, b.available)
    }
    const fees = {} as Account['feeBps']
    for (const symbol of P.symbols) {
      const r = z
        .object({ takerFeeRate: str })
        .parse(
          await this.request(
            '/api/v3/account/fee-rate',
            { category: 'SPOT', symbol: compactSymbol(symbol) },
            undefined,
            true,
          ),
        )
      fees[symbol] = feeBps(units(r.takerFeeRate))
    }
    return {
      identity: identity('bitget', this.mode, 'api.bitget.com', info.userId),
      balances,
      feeBps: fees,
    }
  }
  async pending() {
    const r = z
      .object({ list: z.array(z.object({ clientOid: str })) })
      .parse(await this.request('/api/v3/trade/unfilled-orders', { limit: '100' }, undefined, true))
    return r.list.map((o) => ({ clientId: o.clientOid }))
  }
  async place(order: OrderRequest) {
    allowPlace(this.mode)
    try {
      const r = z.object({ orderId: str.min(1), clientOid: str }).parse(
        await this.request(
          '/api/v3/trade/place-order',
          {},
          {
            category: 'SPOT',
            symbol: compactSymbol(order.symbol),
            side: order.side,
            orderType: 'limit',
            timeInForce: 'ioc',
            autoBorrow: 'no',
            pxAmendType: 'no',
            qty: decimal(order.qty),
            price: decimal(order.price),
            clientOid: order.clientId,
          },
          true,
        ),
      )
      if (r.clientOid !== order.clientId) throw new Error('TRADING_ORDER_UNKNOWN')
    } catch (e) {
      if (
        e instanceof ExchangeError &&
        ['25200', '25202', '25205', '25206', '25207', '25208', '25610', '25611'].includes(e.code)
      )
        throw new OrderRejected()
      throw new Error('TRADING_ORDER_UNKNOWN')
    }
  }
  async order(order: OrderRequest): Promise<OrderResult | null> {
    let raw: unknown
    try {
      raw = await this.request(
        '/api/v3/trade/order-info',
        { clientOid: order.clientId },
        undefined,
        true,
      )
    } catch (e) {
      if (e instanceof ExchangeError && e.code === '25204') return null
      throw e
    }
    if (raw === null) return null
    const o = z
      .object({
        orderId: str.min(1),
        clientOid: str,
        category: z.literal('SPOT'),
        symbol: str,
        side: str,
        orderType: z.literal('limit'),
        timeInForce: z.literal('ioc'),
        qty: str,
        price: str,
        cumExecQty: str,
        cumExecValue: str,
        orderStatus: str,
        feeDetail: z.array(z.object({ feeCoin: str.nullable(), fee: str.nullable() })),
      })
      .parse(raw)
    if (
      o.clientOid !== order.clientId ||
      o.symbol !== compactSymbol(order.symbol) ||
      o.side !== order.side ||
      units(o.qty) !== order.qty ||
      units(o.price) !== order.price
    )
      throw new Error('TRADING_ORDER_MISMATCH')
    const states: Record<string, OrderResult['state']> = {
      live: 'live',
      new: 'live',
      partially_filled: 'partially_filled',
      filled: 'filled',
      cancelled: 'canceled',
    }
    const state = states[o.orderStatus]
    if (!state) throw new Error('TRADING_ORDER_UNKNOWN')
    const filledQty = units(o.cumExecQty),
      quote = units(o.cumExecValue)
    let baseFee = 0n,
      quoteFee = 0n
    if (filledQty && ['filled', 'canceled'].includes(state)) {
      if (!o.feeDetail.length) throw new Error('TRADING_FEE_UNKNOWN')
      for (const f of o.feeDetail) {
        if (f.fee === null || !f.feeCoin) throw new Error('TRADING_FEE_UNKNOWN')
        const charge = -units(f.fee)
        if (f.feeCoin === 'USDT') quoteFee += charge
        else if (f.feeCoin === order.symbol.split('-')[0]) baseFee += charge
        else if (charge) throw new Error('TRADING_FEE_CURRENCY')
      }
    }
    return { ...order, exchangeId: o.orderId, state, filledQty, quote, baseFee, quoteFee }
  }
  async cancel(order: OrderRequest) {
    await this.request(
      '/api/v3/trade/cancel-order',
      {},
      { category: 'SPOT', symbol: compactSymbol(order.symbol), clientOid: order.clientId },
      true,
    )
  }
}
