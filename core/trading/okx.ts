import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config'
import { TRADING_POLICY as P } from '../policy'
import { BPS, SCALE, abs, ceilDiv, cost, decimal, units } from './decimal'
import type {
  Account,
  Balances,
  Market,
  OrderRequest,
  OrderResult,
  TradingMode,
  TradingSymbol,
  TradingVenue,
} from './types'

const envelope = z.object({ code: z.string(), data: z.array(z.unknown()) })
const text = z.string()
const instrumentSchema = z.object({
  instId: text,
  instType: z.literal('SPOT'),
  state: z.literal('live'),
  baseCcy: text,
  quoteCcy: z.literal('USDT'),
  lotSz: text,
  minSz: text,
  tickSz: text,
})
const bookSchema = z.object({
  ts: text,
  bids: z.array(z.array(text)).min(1),
  asks: z.array(z.array(text)).min(1),
})
const detailsSchema = z.object({
  instId: text,
  clOrdId: text,
  ordId: text,
  side: z.enum(['buy', 'sell']),
  tdMode: z.literal('cash'),
  ordType: z.literal('ioc'),
  sz: text,
  px: text,
  accFillSz: text,
  state: z.enum(['live', 'partially_filled', 'filled', 'canceled']),
})
const fillSchema = z.object({
  instId: text,
  ordId: text,
  tradeId: text,
  fillPx: text,
  fillSz: text,
  fee: text,
  feeCcy: text,
  side: z.enum(['buy', 'sell']),
})

/** A definitive rejection is different from a timeout or a lost response. */
export class OrderRejected extends Error {
  constructor() {
    super('TRADING_ORDER_REJECTED')
  }
}
class ExchangeError extends Error {
  constructor(readonly code: string) {
    super('TRADING_EXCHANGE_ERROR')
  }
}

export function signature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body = '',
) {
  return createHmac('sha256', secret)
    .update(timestamp + method + path + body)
    .digest('base64')
}

export function credentials(mode: TradingMode) {
  const c = config()
  const prefix = mode === 'live' ? 'OKX_LIVE' : 'OKX_DEMO'
  return {
    key: c[`${prefix}_API_KEY`],
    secret: c[`${prefix}_SECRET`],
    passphrase: c[`${prefix}_PASSPHRASE`],
  }
}

export function hasCredentials(mode: TradingMode) {
  if (mode === 'paper') return true
  return Object.values(credentials(mode)).every(Boolean)
}

/** Narrow adapter: there are no withdrawal, transfer, borrowing or arbitrary URL methods. */
export class OkxVenue implements TradingVenue {
  constructor(
    readonly mode: TradingMode,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private async request(
    path: string,
    options: { private?: boolean; body?: unknown; expires?: boolean } = {},
  ) {
    const method = options.body ? 'POST' : 'GET'
    const payload = options.body ? JSON.stringify(options.body) : ''
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.mode === 'demo') headers['x-simulated-trading'] = '1'
    if (options.private) {
      if (this.mode === 'paper') throw new Error('TRADING_PAPER_PRIVATE_FORBIDDEN')
      const keys = credentials(this.mode)
      if (!Object.values(keys).every(Boolean)) throw new Error('TRADING_KEYS_REQUIRED')
      const timestamp = new Date().toISOString()
      headers['OK-ACCESS-KEY'] = keys.key
      headers['OK-ACCESS-PASSPHRASE'] = keys.passphrase
      headers['OK-ACCESS-TIMESTAMP'] = timestamp
      headers['OK-ACCESS-SIGN'] = signature(keys.secret, timestamp, method, path, payload)
      if (this.mode === 'demo') headers['x-simulated-trading'] = '1'
      if (options.expires) headers.expTime = String(Date.now() + 5000)
    }
    let response: Response
    try {
      response = await this.transport(`https://${config().OKX_API_HOST}${path}`, {
        method,
        headers,
        body: payload || undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(7000),
      })
    } catch {
      throw new Error('TRADING_NETWORK_UNAVAILABLE')
    }
    if (!response.ok) throw new Error('TRADING_NETWORK_UNAVAILABLE')
    let parsed: z.infer<typeof envelope>
    try {
      parsed = envelope.parse(await response.json())
    } catch {
      throw new Error('TRADING_RESPONSE_INVALID')
    }
    // Never propagate remote messages: they can contain account details or request headers.
    if (parsed.code !== '0') throw new ExchangeError(parsed.code)
    return parsed.data
  }

  async market(symbol: TradingSymbol): Promise<Market> {
    if (!P.symbols.includes(symbol)) throw new Error('TRADING_SYMBOL_FORBIDDEN')
    const ins = instrumentSchema.parse(
      (await this.request(`/api/v5/public/instruments?instType=SPOT&instId=${symbol}`))[0],
    )
    if (ins.instId !== symbol || ins.baseCcy !== symbol.split('-')[0])
      throw new Error('TRADING_INSTRUMENT_INVALID')
    const candles = z
      .array(z.array(text))
      .parse(await this.request(`/api/v5/market/candles?instId=${symbol}&bar=1m&limit=121`))
      .filter((row) => row[8] === '1')
      .map((row) => ({ at: Number(row[0]), close: units(row[4]!) }))
      .sort((a, b) => a.at - b.at)
    // Book is fetched last so account checks cannot make it stale before the signal is used.
    const b = bookSchema.parse(
      (await this.request(`/api/v5/market/books?instId=${symbol}&sz=20`))[0],
    )
    return {
      instrument: {
        symbol,
        lot: units(ins.lotSz),
        minQty: units(ins.minSz),
        tick: units(ins.tickSz),
      },
      book: {
        symbol,
        at: Number(b.ts),
        bids: b.bids.map((row) => [units(row[0]!), units(row[1]!)]),
        asks: b.asks.map((row) => [units(row[0]!), units(row[1]!)]),
      },
      candles,
    }
  }

  async account(): Promise<Account> {
    const clock = z.object({ ts: text }).parse((await this.request('/api/v5/public/time'))[0])
    if (!Number.isSafeInteger(Number(clock.ts)) || Math.abs(Date.now() - Number(clock.ts)) > 4000)
      throw new Error('TRADING_CLOCK_SKEW')
    const c = z
      .object({ uid: text.min(1), perm: text, acctLv: text, ip: text.optional() })
      .parse((await this.request('/api/v5/account/config', { private: true }))[0])
    const perms = c.perm.split(',').map((p) => p.trim())
    if (!perms.includes('read_only') || !perms.includes('trade') || perms.includes('withdraw'))
      throw new Error('TRADING_KEY_PERMISSIONS')
    // Cash spot is available in spot and futures account modes. Margin/portfolio modes are refused.
    if (!['1', '2'].includes(c.acctLv)) throw new Error('TRADING_ACCOUNT_MODE')
    if (this.mode === 'live' && !c.ip?.trim()) throw new Error('TRADING_IP_REQUIRED')
    const positions = z
      .array(z.object({ pos: text }))
      .parse(await this.request('/api/v5/account/positions', { private: true }))
    if (positions.some((p) => units(p.pos) !== 0n)) throw new Error('TRADING_POSITIONS_EXIST')
    const account = z
      .object({
        details: z.array(
          z.object({ ccy: text, cashBal: text, availBal: text, liab: text.optional() }),
        ),
      })
      .parse((await this.request('/api/v5/account/balance', { private: true }))[0])
    const balances: Balances = {
      USDT: { total: 0n, available: 0n },
      BTC: { total: 0n, available: 0n },
      ETH: { total: 0n, available: 0n },
    }
    for (const d of account.details) {
      if (d.liab && units(d.liab) !== 0n) throw new Error('TRADING_DEBT_FORBIDDEN')
      if (d.ccy in balances) {
        const total = units(d.cashBal),
          available = units(d.availBal)
        if (total < 0n || available < 0n || available > total)
          throw new Error('TRADING_BALANCE_INVALID')
        balances[d.ccy as keyof Balances] = { total, available }
      }
    }
    const feeBps = {} as Account['feeBps']
    for (const symbol of P.symbols) {
      const rate = z
        .object({ taker: text.optional(), feeGroup: z.array(z.object({ taker: text })).optional() })
        .parse(
          (
            await this.request(`/api/v5/account/trade-fee?instType=SPOT&instId=${symbol}`, {
              private: true,
            })
          )[0],
        )
      const raw = rate.taker || (rate.feeGroup?.length === 1 ? rate.feeGroup[0]!.taker : '')
      if (!raw) throw new Error('TRADING_FEE_UNKNOWN')
      feeBps[symbol] = Number(ceilDiv(abs(units(raw)) * BPS, SCALE))
      if (feeBps[symbol] > P.maxFeeBps) throw new Error('TRADING_FEE_TOO_HIGH')
    }
    return {
      identity: createHash('sha256')
        .update(`${config().OKX_API_HOST}:${this.mode}:${c.uid}`)
        .digest('hex'),
      balances,
      feeBps,
    }
  }

  async pending() {
    return z
      .array(z.object({ clOrdId: text }))
      .parse(await this.request('/api/v5/trade/orders-pending?instType=SPOT', { private: true }))
      .map((o) => ({ clientId: o.clOrdId }))
  }

  async place(order: OrderRequest) {
    if (this.mode === 'live' && !config().TRADING_LIVE_ENABLED)
      throw new Error('TRADING_LIVE_DISABLED')
    try {
      const [item] = await this.request('/api/v5/trade/order', {
        private: true,
        expires: true,
        body: {
          instId: order.symbol,
          tdMode: 'cash',
          clOrdId: order.clientId,
          side: order.side,
          ordType: 'ioc',
          sz: decimal(order.qty),
          px: decimal(order.price),
        },
      })
      const result = z.object({ sCode: text, clOrdId: text, ordId: text }).parse(item)
      if (result.sCode !== '0') {
        // Duplicate IDs/timeouts must be reconciled, never treated as a definitely absent order.
        if (['51000', '51008', '51020', '51121'].includes(result.sCode)) throw new OrderRejected()
        throw new Error('TRADING_ORDER_UNKNOWN')
      }
      if (result.clOrdId !== order.clientId || !result.ordId)
        throw new Error('TRADING_ORDER_UNKNOWN')
    } catch (error) {
      if (error instanceof OrderRejected) throw error
      throw new Error('TRADING_ORDER_UNKNOWN')
    }
  }

  async order(order: OrderRequest): Promise<OrderResult | null> {
    let rows: unknown[]
    try {
      rows = await this.request(
        `/api/v5/trade/order?instId=${order.symbol}&clOrdId=${order.clientId}`,
        { private: true },
      )
    } catch (error) {
      if (error instanceof ExchangeError && error.code === '51603') return null
      throw error
    }
    const o = detailsSchema.parse(rows[0])
    if (
      o.instId !== order.symbol ||
      o.clOrdId !== order.clientId ||
      o.side !== order.side ||
      units(o.sz) !== order.qty ||
      units(o.px) !== order.price
    )
      throw new Error('TRADING_ORDER_MISMATCH')
    const filledQty = units(o.accFillSz)
    let quote = 0n,
      baseFee = 0n,
      quoteFee = 0n,
      sum = 0n
    if (filledQty && ['filled', 'canceled'].includes(o.state)) {
      // A bounded $10 IOC should fit in 100 fills. If it does not, hold for review, never guess.
      const fills = z
        .array(fillSchema)
        .parse(
          await this.request(
            `/api/v5/trade/fills?instType=SPOT&instId=${order.symbol}&ordId=${o.ordId}&limit=100`,
            { private: true },
          ),
        )
      const seen = new Set<string>()
      for (const f of fills) {
        if (
          f.ordId !== o.ordId ||
          f.instId !== o.instId ||
          f.side !== o.side ||
          seen.has(f.tradeId)
        )
          throw new Error('TRADING_FILL_INVALID')
        seen.add(f.tradeId)
        const qty = units(f.fillSz),
          price = units(f.fillPx),
          commission = units(f.fee)
        if (qty <= 0n || price <= 0n) throw new Error('TRADING_FILL_INVALID')
        sum += qty
        quote += cost(qty, price)
        if (f.feeCcy === 'USDT') quoteFee += commission
        else if (f.feeCcy === order.symbol.split('-')[0]) baseFee += commission
        else if (commission) throw new Error('TRADING_FEE_CURRENCY')
      }
      if (sum !== filledQty) throw new Error('TRADING_FILLS_INCOMPLETE')
    }
    return { ...order, exchangeId: o.ordId, state: o.state, filledQty, quote, baseFee, quoteFee }
  }

  async cancel(order: OrderRequest) {
    await this.request('/api/v5/trade/cancel-order', {
      private: true,
      body: { instId: order.symbol, clOrdId: order.clientId },
    })
  }
}
