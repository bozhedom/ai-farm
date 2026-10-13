import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import { EXECUTION_POLICY as P, RESEARCH_POLICY as R } from '../../policy'
import { abs, BPS, ceilDiv, cost, decimal, fee, SCALE, units } from '../../trading/decimal'
import type {
  Balances,
  Market,
  OrderRequest,
  OrderResult,
  TradingSymbol,
} from '../../trading/types'
import { ExecutionRejected } from '../types'
import type {
  ExecutionAdapter,
  ExecutionIntent,
  ExecutionReceipt,
  PreparedExecution,
} from '../types'

export type FundingOrder = OrderRequest & {
  market: 'spot' | 'perp'
  intent: 'open' | 'close' | 'compensate'
}
export type FundingMarket = {
  spot: Market
  perp: Market
  spotMaxQty: bigint
  perpMaxQty: bigint
  fundingRate: bigint
  fundingIntervalMinutes: number
  nextFundingAt: number
  at: number
}
export type FundingPosition = {
  symbol: TradingSymbol
  qty: bigint
  entryPrice: bigint
  markPrice: bigint
  liquidationPrice: bigint | null
  unrealizedPnl: bigint
  margin: bigint
}
export type FundingCashflow = {
  id: string
  symbol: TradingSymbol
  at: number
  amount: bigint
}
export type FundingAccount = {
  identity: string
  balances: Balances
  availableMargin: bigint
  positions: FundingPosition[]
  feeBps: { spot: number; perp: number } | null
}
export type BybitFundingOptions = {
  mode: 'demo' | 'live'
  credentials: { key: string; secret: string }
  liveEnabled?: boolean
  /** Demo has no documented fee-rate endpoint; reserve this cap, then book actual fills. */
  demoFeeBps?: { spot: number; perp: number }
  /** The execution engine checks its durable reservation and stop immediately before each write. */
  authorizeWrite?: (order: FundingOrder, action: 'place' | 'cancel') => boolean | Promise<boolean>
}

const str = z.string()
const amount = str.transform((value, context) => {
  try {
    return units(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'EXECUTION_DECIMAL_INVALID' })
    return z.NEVER
  }
})
const positive = amount.refine((value) => value > 0n)
const nonnegative = amount.refine((value) => value >= 0n)
const stamp = str
  .regex(/^\d{10,16}$/)
  .transform(Number)
  .refine(Number.isSafeInteger)
const page = z.object({ list: z.array(z.unknown()), nextPageCursor: str.optional() })
const record = z.object({
  orderId: str.min(1),
  orderLinkId: str,
  symbol: str,
  side: z.enum(['Buy', 'Sell']),
  orderType: z.literal('Limit'),
  timeInForce: z.literal('IOC'),
  qty: positive,
  price: positive,
  cumExecQty: nonnegative,
  cumExecValue: nonnegative,
  orderStatus: str,
  isLeverage: str.optional(),
  positionIdx: z.number().int().optional(),
  reduceOnly: z.boolean().optional(),
})

class ApiError extends Error {
  constructor(readonly code: number) {
    super('EXECUTION_BYBIT_API_ERROR')
  }
}
export class FundingOrderUnknown extends Error {
  constructor() {
    super('EXECUTION_ORDER_UNKNOWN')
  }
}
export class FundingOrderRejected extends ExecutionRejected {
  constructor() {
    super('EXECUTION_ORDER_REJECTED')
  }
}

function symbolCode(symbol: string) {
  if (!/^[A-Z0-9]{1,32}-USDT$/.test(symbol) || symbol === 'USDT-USDT')
    throw new Error('EXECUTION_SYMBOL_INVALID')
  return symbol.replace('-', '')
}
function tradingSymbol(code: string): TradingSymbol {
  const symbol = `${code.slice(0, -4)}-USDT` as TradingSymbol
  if (!code.endsWith('USDT') || symbolCode(symbol) !== code)
    throw new Error('EXECUTION_SYMBOL_INVALID')
  return symbol
}
function validateOrder(order: FundingOrder) {
  symbolCode(order.symbol)
  if (
    !/^[A-Za-z0-9_-]{1,36}$/.test(order.clientId) ||
    order.qty <= 0n ||
    order.price <= 0n ||
    !['spot', 'perp'].includes(order.market) ||
    !['open', 'close', 'compensate'].includes(order.intent) ||
    order.side !==
      (order.market === 'spot'
        ? order.intent === 'open'
          ? 'buy'
          : 'sell'
        : order.intent === 'open'
          ? 'sell'
          : 'buy')
  )
    throw new Error('EXECUTION_ORDER_INVALID')
}

/** Separate account, credentials and order IDs; deliberately does not read the spot-trading config. */
export class BybitFundingAdapter implements ExecutionAdapter {
  readonly host: string
  constructor(
    private readonly options: BybitFundingOptions,
    private readonly transport: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!['demo', 'live'].includes(options.mode)) throw new Error('EXECUTION_MODE_INVALID')
    this.host = options.mode === 'demo' ? 'api-demo.bybit.com' : 'api.bybit.com'
  }

  private intentOrder(intent: ExecutionIntent): FundingOrder {
    if (
      intent.venue !== 'bybit-funding' ||
      !['buy', 'sell', 'short', 'cover'].includes(intent.action)
    )
      throw new Error('EXECUTION_INTENT_INVALID')
    const order: FundingOrder = {
      clientId: intent.clientId,
      symbol: intent.symbol as TradingSymbol,
      qty: units(intent.quantity),
      price: units(intent.limitPrice),
      market: ['buy', 'sell'].includes(intent.action) ? 'spot' : 'perp',
      side: ['buy', 'cover'].includes(intent.action) ? 'buy' : 'sell',
      intent: ['buy', 'short'].includes(intent.action) ? 'open' : 'close',
    }
    validateOrder(order)
    return order
  }

  private scope() {
    return createHash('sha256')
      .update(`funding:${this.options.mode}:${this.host}:${this.options.credentials.key}`)
      .digest('hex')
  }

  async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
    const order = this.intentOrder(intent)
    if (!Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= this.now())
      throw new ExecutionRejected('EXECUTION_QUOTE_EXPIRED')
    const budget = units(intent.quoteBudget),
      owned = units(intent.positionQuantity)
    if (budget < 0n || owned < 0n) throw new ExecutionRejected('EXECUTION_BUDGET_INVALID')
    const market = await this.market(order.symbol)
    const instrument = market[order.market].instrument
    const notional = cost(order.qty, order.price)
    if (
      order.qty % instrument.lot ||
      order.price % instrument.tick ||
      order.qty < instrument.minQty ||
      order.qty > (order.market === 'spot' ? market.spotMaxQty : market.perpMaxQty) ||
      (intent.action !== 'cover' && notional < instrument.minNotional!)
    )
      throw new ExecutionRejected('EXECUTION_ORDER_SIZE')
    const account = await this.account(order.symbol)
    const fees = account.feeBps ||
      this.options.demoFeeBps || { spot: P.maxFeeBps, perp: P.maxFeeBps }
    if (
      Object.values(fees).some((bps) => !Number.isSafeInteger(bps) || bps < 0 || bps > P.maxFeeBps)
    )
      throw new ExecutionRejected('EXECUTION_FEE_INVALID')
    if (
      ['buy', 'short'].includes(intent.action) &&
      (notional + fee(notional, fees[order.market]) * (intent.action === 'short' ? 3n : 1n) >
        budget ||
        budget > account.availableMargin)
    )
      throw new ExecutionRejected('EXECUTION_INSUFFICIENT_BALANCE')
    if (account.positions.some((position) => position.symbol !== order.symbol))
      throw new ExecutionRejected('EXECUTION_FOREIGN_POSITION')
    const short = account.positions.reduce((total, position) => total + position.qty, 0n)
    const base = account.balances[order.symbol.slice(0, -5)]?.available || 0n
    if (
      (intent.action === 'short' && (order.qty > owned || order.qty + short > base)) ||
      (intent.action === 'sell' && (order.qty > owned || order.qty > base)) ||
      (intent.action === 'cover' && (order.qty > owned || order.qty > short))
    )
      throw new ExecutionRejected('EXECUTION_POSITION_MISMATCH')
    if (intent.expiresAt <= this.now()) throw new ExecutionRejected('EXECUTION_QUOTE_EXPIRED')
    return {
      intent,
      payload: { mode: this.options.mode, scope: this.scope(), accountIdentity: account.identity },
      externalId: null,
    }
  }

  private preparedOrder(prepared: PreparedExecution) {
    if (prepared.payload.mode !== this.options.mode || prepared.payload.scope !== this.scope())
      throw new Error('EXECUTION_ACCOUNT_MISMATCH')
    return this.intentOrder(prepared.intent)
  }

  async broadcast(prepared: PreparedExecution) {
    const order = this.preparedOrder(prepared)
    if (prepared.intent.expiresAt <= this.now())
      throw new ExecutionRejected('EXECUTION_QUOTE_EXPIRED')
    await this.place(order)
  }

  async lookup(prepared: PreparedExecution): Promise<ExecutionReceipt | null> {
    const result = await this.order(this.preparedOrder(prepared))
    if (!result) return null
    return {
      status:
        result.state === 'filled'
          ? 'filled'
          : result.state === 'canceled'
            ? 'cancelled'
            : 'pending',
      externalId: result.exchangeId,
      // Pending partial fills cannot be used to size a hedge before the IOC becomes terminal.
      filledQuantity: ['filled', 'canceled'].includes(result.state)
        ? decimal(result.filledQty)
        : '0',
      grossQuote: decimal(result.quote),
      quoteFee: decimal(-result.quoteFee),
      baseFee: decimal(-result.baseFee),
    }
  }

  async cancel(prepared: PreparedExecution) {
    await this.cancelOrder(this.preparedOrder(prepared))
  }

  private async request(
    path: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
    privateCall = false,
  ): Promise<unknown> {
    const query = new URLSearchParams(params).toString()
    const payload = body ? JSON.stringify(body) : query
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (privateCall) {
      const { key, secret } = this.options.credentials
      if (!key || !secret) throw new Error('EXECUTION_CREDENTIALS_REQUIRED')
      const timestamp = String(this.now())
      Object.assign(headers, {
        'X-BAPI-API-KEY': key,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': '5000',
        'X-BAPI-SIGN': createHmac('sha256', secret)
          .update(timestamp + key + '5000' + payload)
          .digest('hex'),
      })
    }
    let response: Response
    try {
      response = await this.transport(`https://${this.host}${path}${query ? '?' + query : ''}`, {
        method: body ? 'POST' : 'GET',
        headers,
        ...(body ? { body: payload } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(7000),
      })
    } catch {
      throw new Error('EXECUTION_NETWORK_UNAVAILABLE')
    }
    if (response.status === 429) throw new Error('EXECUTION_RATE_LIMIT')
    if ([403, 451].includes(response.status)) throw new Error('EXECUTION_REGION_UNAVAILABLE')
    if (!response.ok) throw new Error('EXECUTION_NETWORK_UNAVAILABLE')
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      throw new Error('EXECUTION_RESPONSE_INVALID')
    }
    const parsed = z.object({ retCode: z.number().int(), result: z.unknown() }).safeParse(raw)
    if (!parsed.success) throw new Error('EXECUTION_RESPONSE_INVALID')
    if (parsed.data.retCode) throw new ApiError(parsed.data.retCode)
    return parsed.data.result
  }

  private async pages(path: string, params: Record<string, string>) {
    const rows: unknown[] = []
    const cursors = new Set<string>()
    let cursor = ''
    for (let index = 0; index < 20; index++) {
      const result = page.parse(
        await this.request(path, { ...params, ...(cursor ? { cursor } : {}) }, undefined, true),
      )
      rows.push(...result.list)
      cursor = result.nextPageCursor || ''
      if (!cursor) return rows
      if (cursors.has(cursor)) throw new Error('EXECUTION_PAGINATION_INCOMPLETE')
      cursors.add(cursor)
    }
    throw new Error('EXECUTION_PAGINATION_INCOMPLETE')
  }

  async discover(): Promise<TradingSymbol[]> {
    const spot = page.parse(
      await this.request('/v5/market/instruments-info', { category: 'spot' }),
    ).list
    const pairs = new Set(
      spot.flatMap((raw) => {
        const result = z
          .object({
            symbol: str,
            baseCoin: str,
            quoteCoin: str,
            status: str,
            stTag: str.optional(),
            symbolType: str.optional(),
          })
          .safeParse(raw)
        if (!result.success) return []
        const ins = result.data
        if (
          ins.quoteCoin !== 'USDT' ||
          ins.status !== 'Trading' ||
          ins.stTag === '1' ||
          ['xstocks', 'adventure'].includes(ins.symbolType || '') ||
          ins.symbol !== ins.baseCoin + 'USDT' ||
          !/^[A-Z0-9]{1,32}$/.test(ins.baseCoin) ||
          ins.baseCoin === 'USDT'
        )
          return []
        return [ins.symbol]
      }),
    )
    const rows = page.parse(await this.request('/v5/market/tickers', { category: 'linear' })).list
    return rows
      .flatMap((raw) => {
        const parsed = z
          .object({
            symbol: str,
            fundingRate: amount,
            turnover24h: nonnegative,
            nextFundingTime: stamp,
          })
          .safeParse(raw)
        if (!parsed.success) return []
        const ticker = parsed.data
        if (
          !pairs.has(ticker.symbol) ||
          ticker.fundingRate <= 0n ||
          abs(ticker.fundingRate) > units(R.maxAbsFundingRate) ||
          ticker.turnover24h < units(R.minFundingTurnoverUsd) ||
          ticker.nextFundingTime <= this.now() ||
          ticker.nextFundingTime > this.now() + R.fundingMaxFutureMs
        )
          return []
        return [{ symbol: tradingSymbol(ticker.symbol), rate: ticker.fundingRate }]
      })
      .sort((a, b) =>
        a.rate === b.rate ? a.symbol.localeCompare(b.symbol) : a.rate > b.rate ? -1 : 1,
      )
      .slice(0, P.maxSymbols)
      .map((row) => row.symbol)
  }

  /** Public settled rates are only used to simulate paper cashflows; they are not account income. */
  async fundingRates(
    symbol: TradingSymbol,
    startTime: number,
    endTime: number,
  ): Promise<{ at: number; rate: bigint }[]> {
    const code = symbolCode(symbol)
    if (
      !Number.isSafeInteger(startTime) ||
      !Number.isSafeInteger(endTime) ||
      startTime < 0 ||
      endTime < startTime ||
      endTime - startTime > 7 * 24 * 60 * 60_000 ||
      endTime > this.now()
    )
      throw new Error('EXECUTION_HISTORY_RANGE')
    const rows = page.parse(
      await this.request('/v5/market/funding/history', {
        category: 'linear',
        symbol: code,
        startTime: String(startTime),
        endTime: String(endTime),
        limit: '200',
      }),
    ).list
    // Never count an incomplete response as the complete accrual window.
    if (rows.length >= 200) throw new Error('EXECUTION_PAGINATION_INCOMPLETE')
    const seen = new Set<number>()
    return rows
      .map((raw) => {
        const row = z
          .object({ symbol: z.literal(code), fundingRate: amount, fundingRateTimestamp: stamp })
          .parse(raw)
        if (
          seen.has(row.fundingRateTimestamp) ||
          row.fundingRateTimestamp < startTime ||
          row.fundingRateTimestamp > endTime ||
          abs(row.fundingRate) > units(R.maxAbsFundingRate)
        )
          throw new Error('EXECUTION_HISTORY_INVALID')
        seen.add(row.fundingRateTimestamp)
        return { at: row.fundingRateTimestamp, rate: row.fundingRate }
      })
      .sort((a, b) => a.at - b.at)
  }

  async market(symbol: TradingSymbol): Promise<FundingMarket> {
    const code = symbolCode(symbol)
    const snapshots: Partial<Record<'spot' | 'perp', Market>> = {}
    const limits = { spot: 0n, perp: 0n }
    let fundingIntervalMinutes = 0
    for (const market of ['spot', 'perp'] as const) {
      const category = market === 'spot' ? 'spot' : 'linear'
      const result = page.parse(
        await this.request('/v5/market/instruments-info', { category, symbol: code }),
      )
      if (result.list.length !== 1) throw new Error('EXECUTION_INSTRUMENT_INVALID')
      const common = z.object({
        symbol: z.literal(code),
        baseCoin: z.literal(symbol.slice(0, -5)),
        quoteCoin: z.literal('USDT'),
        status: z.literal('Trading'),
        priceFilter: z.object({ tickSize: positive }),
      })
      let lot: bigint, minQty: bigint, minNotional: bigint
      const tick = common.parse(result.list[0]).priceFilter.tickSize
      if (market === 'spot') {
        const ins = common
          .extend({
            stTag: str.optional(),
            symbolType: str.optional(),
            lotSizeFilter: z.object({
              basePrecision: positive,
              minOrderAmt: positive,
              maxLimitOrderQty: positive,
            }),
          })
          .parse(result.list[0])
        if (ins.stTag === '1' || ['xstocks', 'adventure'].includes(ins.symbolType || ''))
          throw new Error('EXECUTION_INSTRUMENT_INVALID')
        lot = minQty = ins.lotSizeFilter.basePrecision
        minNotional = ins.lotSizeFilter.minOrderAmt
        limits.spot = ins.lotSizeFilter.maxLimitOrderQty
      } else {
        const ins = common
          .extend({
            contractType: z.literal('LinearPerpetual'),
            settleCoin: z.literal('USDT'),
            isPreListing: z.literal(false),
            fundingInterval: z.number().int().positive().max(1440),
            lotSizeFilter: z.object({
              qtyStep: positive,
              minOrderQty: positive,
              minNotionalValue: positive,
              maxOrderQty: positive,
            }),
          })
          .parse(result.list[0])
        lot = ins.lotSizeFilter.qtyStep
        minQty = ins.lotSizeFilter.minOrderQty
        minNotional = ins.lotSizeFilter.minNotionalValue
        limits.perp = ins.lotSizeFilter.maxOrderQty
        fundingIntervalMinutes = ins.fundingInterval
      }
      const book = z
        .object({
          s: z.literal(code),
          ts: z.number().int().safe(),
          b: z.array(z.tuple([positive, positive])).min(1),
          a: z.array(z.tuple([positive, positive])).min(1),
        })
        .parse(await this.request('/v5/market/orderbook', { category, symbol: code, limit: '50' }))
      if (
        this.now() - book.ts > P.quoteMaxAgeMs ||
        book.ts > this.now() + 2000 ||
        book.b[0]![0] >= book.a[0]![0]
      )
        throw new Error('EXECUTION_BOOK_INVALID')
      snapshots[market] = {
        instrument: { symbol, lot, minQty, minNotional, tick },
        book: { symbol, at: book.ts, bids: book.b, asks: book.a },
        candles: [],
      }
    }
    const tickerRows = page.parse(
      await this.request('/v5/market/tickers', { category: 'linear', symbol: code }),
    ).list
    if (tickerRows.length !== 1) throw new Error('EXECUTION_INSTRUMENT_INVALID')
    const ticker = z
      .object({ symbol: z.literal(code), fundingRate: amount, nextFundingTime: stamp })
      .parse(tickerRows[0])
    if (
      ticker.nextFundingTime <= this.now() ||
      ticker.nextFundingTime > this.now() + 25 * 60 * 60_000 ||
      abs(ticker.fundingRate) > SCALE
    )
      throw new Error('EXECUTION_FUNDING_INVALID')
    return {
      spot: snapshots.spot!,
      perp: snapshots.perp!,
      spotMaxQty: limits.spot,
      perpMaxQty: limits.perp,
      fundingRate: ticker.fundingRate,
      fundingIntervalMinutes,
      nextFundingAt: ticker.nextFundingTime,
      at: this.now(),
    }
  }

  async positions(symbol?: TradingSymbol): Promise<FundingPosition[]> {
    const rows = await this.pages('/v5/position/list', {
      category: 'linear',
      ...(symbol ? { symbol: symbolCode(symbol) } : { settleCoin: 'USDT' }),
      limit: '200',
    })
    const seen = new Set<string>()
    return rows.flatMap((raw) => {
      const position = z
        .object({
          symbol: str,
          positionIdx: z.literal(0),
          side: z.enum(['', 'Sell']),
          size: nonnegative,
          leverage: positive,
          autoAddMargin: z.literal(0),
          positionStatus: z.literal('Normal'),
          avgPrice: str,
          markPrice: str,
          liqPrice: str,
          unrealisedPnl: str,
          positionIM: str,
        })
        .parse(raw)
      const parsedSymbol = tradingSymbol(position.symbol)
      if (
        (symbol && parsedSymbol !== symbol) ||
        seen.has(parsedSymbol) ||
        position.leverage !== SCALE
      )
        throw new Error('EXECUTION_POSITION_INVALID')
      seen.add(parsedSymbol)
      if (!position.size) return []
      if (position.side !== 'Sell') throw new Error('EXECUTION_POSITION_INVALID')
      return [
        {
          symbol: parsedSymbol,
          qty: position.size,
          entryPrice: positive.parse(position.avgPrice),
          markPrice: positive.parse(position.markPrice),
          liquidationPrice: position.liqPrice ? positive.parse(position.liqPrice) : null,
          unrealizedPnl: amount.parse(position.unrealisedPnl),
          margin: nonnegative.parse(position.positionIM),
        },
      ]
    })
  }

  async account(symbol: TradingSymbol): Promise<FundingAccount> {
    symbolCode(symbol)
    const time = z
      .object({ timeSecond: str.regex(/^\d+$/) })
      .parse(await this.request('/v5/market/time'))
    if (Math.abs(Number(time.timeSecond) * 1000 - this.now()) > 4000)
      throw new Error('EXECUTION_CLOCK_SKEW')
    let uid = `demo-key:${this.options.credentials.key}`
    if (this.options.mode === 'live') {
      const key = z
        .object({
          userID: z.union([str.min(1), z.number().int().safe().transform(String)]),
          readOnly: z.literal(0),
          ips: z.array(str),
          permissions: z.record(str, z.array(str)),
        })
        .parse(await this.request('/v5/user/query-api', {}, undefined, true))
      const permitted: Record<string, string[]> = {
        Spot: ['SpotTrade'],
        ContractTrade: ['Order', 'Position'],
      }
      if (
        !key.permissions.Spot?.includes('SpotTrade') ||
        !key.permissions.ContractTrade?.includes('Order') ||
        Object.entries(key.permissions).some(([name, values]) =>
          values.some((value) => !permitted[name]?.includes(value)),
        )
      )
        throw new Error('EXECUTION_KEY_PERMISSIONS')
      if (
        !key.ips.length ||
        key.ips.some(
          (ip) => !ip.trim() || ['*', '0.0.0.0', '0.0.0.0/0', '::/0'].includes(ip.trim()),
        )
      )
        throw new Error('EXECUTION_IP_REQUIRED')
      uid = key.userID
    }
    const account = z
      .object({
        unifiedMarginStatus: z.union([z.literal(5), z.literal(6)]),
        marginMode: z.literal('ISOLATED_MARGIN'),
        spotHedgingStatus: z.literal('OFF'),
      })
      .safeParse(await this.request('/v5/account/info', {}, undefined, true))
    if (!account.success) throw new Error('EXECUTION_ACCOUNT_MODE')
    const wallets = page.parse(
      await this.request('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, undefined, true),
    ).list
    if (wallets.length !== 1) throw new Error('EXECUTION_ACCOUNT_INVALID')
    const wallet = z
      .object({
        accountType: z.literal('UNIFIED'),
        coin: z.array(
          z.object({
            coin: str.regex(/^[A-Z0-9]{1,32}$/),
            walletBalance: nonnegative,
            locked: nonnegative,
            borrowAmount: amount,
            accruedInterest: amount,
            spotBorrow: amount.optional(),
            spotHedgingQty: amount.optional(),
            bonus: amount.optional(),
            totalPositionIM: nonnegative,
            totalOrderIM: nonnegative,
          }),
        ),
      })
      .parse(wallets[0])
    const balances: Balances = { USDT: { total: 0n, available: 0n } }
    const seen = new Set<string>()
    for (const coin of wallet.coin) {
      if (seen.has(coin.coin)) throw new Error('EXECUTION_ACCOUNT_INVALID')
      seen.add(coin.coin)
      if (
        [
          coin.borrowAmount,
          coin.accruedInterest,
          coin.spotBorrow || 0n,
          coin.spotHedgingQty || 0n,
          coin.bonus || 0n,
        ].some((value) => value !== 0n)
      )
        throw new Error('EXECUTION_DEBT_FORBIDDEN')
      const available = coin.walletBalance - coin.locked - coin.totalPositionIM - coin.totalOrderIM
      if (available < 0n) throw new Error('EXECUTION_BALANCE_INVALID')
      Object.defineProperty(balances, coin.coin, {
        value: { total: coin.walletBalance, available },
        enumerable: true,
      })
    }
    const positions = await this.positions()
    // Empty position rows carry the configured leverage/mode of the next short as well.
    if (!positions.some((position) => position.symbol === symbol)) await this.positions(symbol)
    const feeBps: FundingAccount['feeBps'] =
      this.options.mode === 'demo' ? null : { spot: 0, perp: 0 }
    if (feeBps) {
      for (const market of ['spot', 'perp'] as const) {
        const rows = page.parse(
          await this.request(
            '/v5/account/fee-rate',
            { category: market === 'spot' ? 'spot' : 'linear', symbol: symbolCode(symbol) },
            undefined,
            true,
          ),
        ).list
        if (rows.length !== 1) throw new Error('EXECUTION_FEE_UNKNOWN')
        const rate = z
          .object({ symbol: z.literal(symbolCode(symbol)), takerFeeRate: amount })
          .parse(rows[0]).takerFeeRate
        const bps = Number(ceilDiv(abs(rate) * BPS, SCALE))
        if (bps > P.maxFeeBps) throw new Error('EXECUTION_FEE_TOO_HIGH')
        feeBps[market] = bps
      }
    }
    return {
      identity: createHash('sha256')
        .update(`bybit:${this.options.mode}:${this.host}:${uid}`)
        .digest('hex'),
      balances,
      availableMargin: balances.USDT.available,
      positions,
      feeBps,
    }
  }

  async pending() {
    const result: { market: 'spot' | 'perp'; clientId: string; symbol: TradingSymbol }[] = []
    for (const market of ['spot', 'perp'] as const) {
      const rows = await this.pages('/v5/order/realtime', {
        category: market === 'spot' ? 'spot' : 'linear',
        ...(market === 'perp' ? { settleCoin: 'USDT' } : {}),
        openOnly: '0',
        limit: '50',
      })
      for (const row of rows) {
        const order = z.object({ orderLinkId: str, symbol: str }).parse(row)
        result.push({ market, clientId: order.orderLinkId, symbol: tradingSymbol(order.symbol) })
      }
    }
    return result
  }

  private async authorize(order: FundingOrder, action: 'place' | 'cancel') {
    validateOrder(order)
    if (this.options.mode === 'live' && !this.options.liveEnabled)
      throw new ExecutionRejected('EXECUTION_LIVE_DISABLED')
    if (!this.options.credentials.key || !this.options.credentials.secret)
      throw new ExecutionRejected('EXECUTION_CREDENTIALS_REQUIRED')
    try {
      if (!this.options.authorizeWrite || !(await this.options.authorizeWrite(order, action)))
        throw new Error('EXECUTION_WRITE_DISABLED')
    } catch (error) {
      throw new ExecutionRejected(
        error instanceof Error && /^EXECUTION_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'EXECUTION_WRITE_DISABLED',
      )
    }
  }

  async place(order: FundingOrder): Promise<{ exchangeId: string }> {
    await this.authorize(order, 'place')
    try {
      const accepted = z
        .object({ orderId: str.min(1), orderLinkId: z.literal(order.clientId) })
        .parse(
          await this.request(
            '/v5/order/create',
            {},
            {
              category: order.market === 'spot' ? 'spot' : 'linear',
              symbol: symbolCode(order.symbol),
              side: order.side === 'buy' ? 'Buy' : 'Sell',
              orderType: 'Limit',
              qty: decimal(order.qty),
              price: decimal(order.price),
              timeInForce: 'IOC',
              orderLinkId: order.clientId,
              ...(order.market === 'spot'
                ? { isLeverage: 0, orderFilter: 'Order' }
                : { positionIdx: 0, reduceOnly: order.intent !== 'open' }),
            },
            true,
          ),
        )
      return { exchangeId: accepted.orderId }
    } catch (error) {
      // Duplicate IDs, timeouts and malformed acknowledgements may have placed an order.
      if (error instanceof ApiError && [10001, 110007, 110012].includes(error.code))
        throw new FundingOrderRejected()
      throw new FundingOrderUnknown()
    }
  }

  async order(
    order: FundingOrder,
  ): Promise<(OrderResult & Pick<FundingOrder, 'market' | 'intent'>) | null> {
    validateOrder(order)
    const category = order.market === 'spot' ? 'spot' : 'linear'
    const params = {
      category,
      symbol: symbolCode(order.symbol),
      orderLinkId: order.clientId,
      limit: '50',
    }
    let rows = page.parse(await this.request('/v5/order/realtime', params, undefined, true)).list
    if (!rows.length)
      rows = page.parse(await this.request('/v5/order/history', params, undefined, true)).list
    if (!rows.length) return null
    if (rows.length !== 1) throw new Error('EXECUTION_ORDER_MISMATCH')
    const r = record.parse(rows[0])
    if (
      r.orderLinkId !== order.clientId ||
      r.symbol !== params.symbol ||
      r.side !== (order.side === 'buy' ? 'Buy' : 'Sell') ||
      r.qty !== order.qty ||
      r.price !== order.price ||
      r.cumExecQty > order.qty ||
      (order.market === 'spot'
        ? r.isLeverage !== '0'
        : r.positionIdx !== 0 || r.reduceOnly !== (order.intent !== 'open'))
    )
      throw new Error('EXECUTION_ORDER_MISMATCH')
    const states: Record<string, OrderResult['state']> = {
      New: 'live',
      PartiallyFilled: 'partially_filled',
      Filled: 'filled',
      Cancelled: 'canceled',
      PartiallyFilledCanceled: 'canceled',
      Rejected: 'canceled',
    }
    const state = states[r.orderStatus]
    if (!state) throw new FundingOrderUnknown()
    if ((state === 'filled' && r.cumExecQty !== order.qty) || (!r.cumExecQty && r.cumExecValue))
      throw new Error('EXECUTION_ORDER_MISMATCH')
    let quote = 0n,
      filled = 0n,
      baseFee = 0n,
      quoteFee = 0n
    if (r.cumExecQty && ['filled', 'canceled'].includes(state)) {
      const executions = await this.pages('/v5/execution/list', {
        category,
        orderId: r.orderId,
        symbol: params.symbol,
        limit: '100',
      })
      const seen = new Set<string>()
      for (const raw of executions) {
        const f = z
          .object({
            orderId: z.literal(r.orderId),
            orderLinkId: z.literal(order.clientId),
            symbol: z.literal(params.symbol),
            side: z.literal(r.side),
            execId: str.min(1),
            execType: z.literal('Trade'),
            execQty: positive,
            execValue: positive,
            execPrice: positive,
            execFee: amount,
            feeCurrency: str,
            extraFees: z.unknown().optional(),
          })
          .parse(raw)
        if (seen.has(f.execId)) throw new Error('EXECUTION_FILL_INVALID')
        if (order.side === 'buy' ? f.execPrice > order.price : f.execPrice < order.price)
          throw new Error('EXECUTION_FILL_INVALID')
        if (f.extraFees && (!Array.isArray(f.extraFees) || f.extraFees.length))
          throw new Error('EXECUTION_FEE_UNKNOWN')
        seen.add(f.execId)
        quote += f.execValue
        filled += f.execQty
        if (f.feeCurrency === 'USDT') quoteFee -= f.execFee
        else if (order.market === 'spot' && f.feeCurrency === order.symbol.slice(0, -5))
          baseFee -= f.execFee
        else if (f.execFee) throw new Error('EXECUTION_FEE_CURRENCY')
      }
      if (
        filled !== r.cumExecQty ||
        quote !== r.cumExecValue ||
        (order.side === 'buy' && filled + baseFee <= 0n)
      )
        throw new Error('EXECUTION_FILLS_INCOMPLETE')
    }
    return {
      ...order,
      exchangeId: r.orderId,
      state,
      filledQty: r.cumExecQty,
      quote,
      baseFee,
      quoteFee,
    }
  }

  async cancelOrder(order: FundingOrder) {
    await this.authorize(order, 'cancel')
    const result = await this.request(
      '/v5/order/cancel',
      {},
      {
        category: order.market === 'spot' ? 'spot' : 'linear',
        symbol: symbolCode(order.symbol),
        orderLinkId: order.clientId,
      },
      true,
    )
    z.object({ orderId: str.min(1), orderLinkId: z.literal(order.clientId) }).parse(result)
  }

  async fundingHistory(
    symbol: TradingSymbol,
    startTime: number,
    endTime: number,
  ): Promise<FundingCashflow[]> {
    const code = symbolCode(symbol)
    if (
      !Number.isSafeInteger(startTime) ||
      !Number.isSafeInteger(endTime) ||
      startTime < 0 ||
      endTime < startTime ||
      endTime - startTime > 7 * 24 * 60 * 60_000 ||
      endTime > this.now()
    )
      throw new Error('EXECUTION_HISTORY_RANGE')
    const rows = await this.pages('/v5/account/transaction-log', {
      accountType: 'UNIFIED',
      category: 'linear',
      currency: 'USDT',
      type: 'SETTLEMENT',
      startTime: String(startTime),
      endTime: String(endTime),
      limit: '50',
    })
    const seen = new Set<string>()
    return rows
      .flatMap((raw) => {
        const event = z
          .object({
            id: str.min(1),
            symbol: str,
            category: z.literal('linear'),
            currency: z.literal('USDT'),
            type: z.literal('SETTLEMENT'),
            transactionTime: stamp,
            funding: amount,
          })
          .parse(raw)
        if (
          seen.has(event.id) ||
          event.transactionTime < startTime ||
          event.transactionTime > endTime
        )
          throw new Error('EXECUTION_HISTORY_INVALID')
        seen.add(event.id)
        if (event.symbol !== code) return []
        return [{ id: event.id, symbol, at: event.transactionTime, amount: event.funding }]
      })
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  }
}
