import { constants, createHash, createPrivateKey, sign } from 'node:crypto'
import { z } from 'zod'
import { abs, decimal, SCALE, units } from '../../trading/decimal'
import {
  ExecutionRejected,
  type ExecutionAdapter,
  type ExecutionIntent,
  type ExecutionReceipt,
  type Json,
  type PreparedExecution,
} from '../types'

export type KalshiMode = 'demo' | 'live'
export type KalshiOutcome = 'yes' | 'no'
export type KalshiAction = 'buy' | 'sell'

export interface KalshiSettings {
  mode: KalshiMode
  keyId: string
  privateKey: string
  /** Real member/user ID supplied by the owner, subsequently verified against orders. */
  accountId: string
  liveEnabled: boolean
  eligibilityConfirmed: boolean
  subaccount: number
  maxQuoteAgeMs: number
  requestTimeoutMs: number
  maxPages: number
}

export interface KalshiOrderIntent {
  /** Durable execution-step ID, generated before any request is sent. */
  id: string
  ticker: string
  outcome: KalshiOutcome
  action: KalshiAction
  quantity: string
  limitPrice: string
  maxSpend: string
  feeReserve: string
  /** Locally reconciled contracts owned by this program, not the whole account. */
  ownedQuantity: string
}

export interface KalshiOrderBody {
  ticker: string
  client_order_id: string
  side: 'bid' | 'ask'
  count: string
  price: string
  time_in_force: 'immediate_or_cancel'
  self_trade_prevention_type: 'taker_at_cross'
  cancel_order_on_pause: true
  reduce_only: boolean
  subaccount: number
}

export interface KalshiPreparedOrder {
  version: 1
  mode: KalshiMode
  accountId: string
  clientOrderId: string
  preparedAt: number
  expiresAt: number
  intent: KalshiOrderIntent
  body: KalshiOrderBody
}

export interface KalshiOrderSnapshot {
  clientOrderId: string
  orderId: string | null
  state: 'unknown' | 'pending' | 'filled' | 'canceled' | 'rejected'
  quantity: string
  filledQuantity: string
  grossAmount: string
  feeAmount: string
  cashDelta: string
  fills: KalshiFill[]
}

export interface KalshiFill {
  id: string
  quantity: string
  price: string
  amount: string
  fee: string
  at: string
}

export interface KalshiPosition {
  ticker: string
  signedQuantity: string
  exposure: string
  realizedPnl: string
  feesPaid: string
  updatedAt: string
}

export interface KalshiSettlement {
  id: string
  ticker: string
  result: 'yes' | 'no' | 'scalar'
  yesQuantity: string
  noQuantity: string
  cost: string
  revenue: string
  fees: string
  settledAt: string
}

const ticker = z.string().regex(/^[A-Z0-9][A-Z0-9_.:-]{0,199}$/)
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const amount = z.string().regex(/^\d{1,24}(?:\.\d{1,6})?$/)
const signedAmount = z.string().regex(/^-?\d{1,24}(?:\.\d{1,6})?$/)
const count = z.string().regex(/^\d{1,24}(?:\.\d{1,2})?$/)
const signedCount = z.string().regex(/^-?\d{1,24}(?:\.\d{1,2})?$/)
const quote = z.string().regex(/^\d(?:\.\d{1,4})?$/)
const date = z.string().refine((v) => Number.isFinite(Date.parse(v)))
const range = z.object({ start: quote, end: quote, step: quote })
const marketSchema = z.object({
  ticker,
  event_ticker: ticker,
  market_type: z.literal('binary'),
  status: z.string(),
  open_time: date,
  close_time: date,
  notional_value_dollars: amount,
  price_ranges: z.array(range).min(1).max(100),
  result: z.enum(['yes', 'no', 'scalar', '']).optional(),
  settlement_value_dollars: amount.nullable().optional(),
})
const level = z.tuple([quote, count])
const bookSchema = z.object({
  orderbook_fp: z.object({
    yes_dollars: z.array(level).max(100),
    no_dollars: z.array(level).max(100),
  }),
})
const orderSchema = z.object({
  order_id: identifier,
  user_id: identifier,
  client_order_id: identifier,
  ticker,
  book_side: z.enum(['bid', 'ask']),
  status: z.enum(['resting', 'canceled', 'executed']),
  yes_price_dollars: amount,
  no_price_dollars: amount,
  fill_count_fp: count,
  remaining_count_fp: count,
  initial_count_fp: count,
  taker_fees_dollars: amount,
  maker_fees_dollars: amount,
  subaccount_number: z.number().int().nonnegative(),
})
const fillSchema = z.object({
  fill_id: identifier,
  order_id: identifier,
  ticker,
  book_side: z.enum(['bid', 'ask']),
  count_fp: count,
  yes_price_dollars: amount,
  no_price_dollars: amount,
  fee_cost: amount,
  created_time: date,
  subaccount_number: z.number().int().nonnegative(),
})
const positionSchema = z.object({
  ticker,
  position_fp: signedCount,
  market_exposure_dollars: signedAmount,
  realized_pnl_dollars: signedAmount,
  fees_paid_dollars: amount,
  last_updated_ts: date,
})
const settlementSchema = z.object({
  ticker,
  exchange_index: z.number().int().nonnegative(),
  market_result: z.enum(['yes', 'no', 'scalar']),
  yes_count_fp: count,
  no_count_fp: count,
  yes_total_cost_dollars: amount,
  no_total_cost_dollars: amount,
  revenue: z.number().int().nonnegative().refine(Number.isSafeInteger),
  fee_cost: amount,
  settled_time: date,
})

function read<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new Error('EXECUTION_KALSHI_RESPONSE_INVALID')
  return parsed.data
}

function fail(code: string): never {
  throw new Error(`EXECUTION_KALSHI_${code}`)
}

function fixed(value: bigint, digits: number) {
  if (value < 0n || value % (SCALE / 10n ** BigInt(digits))) fail('PRECISION_INVALID')
  const [whole, fraction = ''] = decimal(value).split('.')
  return `${whole}.${fraction.padEnd(digits, '0')}`
}

function positive(value: string, schema: z.ZodType<string>) {
  const n = units(read(schema, value))
  if (n <= 0n) fail('AMOUNT_INVALID')
  return n
}

/** Stable across crashes and retries; an uncertain request must be looked up, never recreated. */
export function kalshiClientOrderId(mode: KalshiMode, stepId: string) {
  if (!stepId || stepId.length > 200) fail('INTENT_INVALID')
  const hash = createHash('sha256').update(`kalshi:${mode}:${stepId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** Query parameters and request bodies are deliberately excluded by the Kalshi protocol. */
export function kalshiSignature(
  privateKey: string,
  timestamp: string,
  method: string,
  path: string,
) {
  try {
    const key = createPrivateKey(privateKey)
    const payload = Buffer.from(timestamp + method.toUpperCase() + path.split('?')[0])
    if (key.asymmetricKeyType === 'ed25519') return sign(null, payload, key).toString('base64')
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048)
      return fail('KEY_INVALID')
    return sign('sha256', payload, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64')
  } catch {
    return fail('KEY_INVALID')
  }
}

function orderBody(intent: KalshiOrderIntent, settings: KalshiSettings): KalshiOrderBody {
  read(ticker, intent.ticker)
  const quantity = positive(intent.quantity, count)
  const price = positive(intent.limitPrice, quote)
  if (price >= SCALE) fail('PRICE_INVALID')
  if (!['yes', 'no'].includes(intent.outcome) || !['buy', 'sell'].includes(intent.action))
    fail('INTENT_INVALID')
  const yesPrice = intent.outcome === 'yes' ? price : SCALE - price
  return {
    ticker: intent.ticker,
    client_order_id: kalshiClientOrderId(settings.mode, intent.id),
    side: (intent.outcome === 'yes') === (intent.action === 'buy') ? 'bid' : 'ask',
    count: fixed(quantity, 2),
    price: fixed(yesPrice, 4),
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross',
    cancel_order_on_pause: true,
    reduce_only: intent.action === 'sell',
    subaccount: settings.subaccount,
  }
}

export class KalshiExecutionVenue {
  constructor(
    private readonly settings: KalshiSettings,
    private readonly transport: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !['demo', 'live'].includes(settings.mode) ||
      !Number.isInteger(settings.subaccount) ||
      settings.subaccount < 0 ||
      settings.subaccount > 63 ||
      !Number.isInteger(settings.maxPages) ||
      settings.maxPages < 1 ||
      settings.maxPages > 100 ||
      !Number.isInteger(settings.maxQuoteAgeMs) ||
      settings.maxQuoteAgeMs < 1 ||
      settings.maxQuoteAgeMs > 30_000 ||
      !Number.isInteger(settings.requestTimeoutMs) ||
      settings.requestTimeoutMs < 1 ||
      settings.requestTimeoutMs > 30_000
    )
      fail('SETTINGS_INVALID')
  }

  private assertWrite() {
    if (this.settings.mode === 'live') {
      if (!this.settings.liveEnabled) fail('LIVE_DISABLED')
      if (!this.settings.eligibilityConfirmed) fail('ELIGIBILITY_REQUIRED')
    }
  }

  private async request(path: string, options: { private?: boolean; body?: KalshiOrderBody } = {}) {
    const method = options.body ? 'POST' : 'GET'
    if (options.body) this.assertWrite()
    const fullPath = `/trade-api/v2${path}`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.private) {
      if (!this.settings.keyId || !this.settings.privateKey) fail('CREDENTIALS_REQUIRED')
      const timestamp = String(this.now())
      headers['KALSHI-ACCESS-KEY'] = this.settings.keyId
      headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp
      headers['KALSHI-ACCESS-SIGNATURE'] = kalshiSignature(
        this.settings.privateKey,
        timestamp,
        method,
        fullPath,
      )
    }
    if (options.body) headers['Content-Type'] = 'application/json'
    const host =
      this.settings.mode === 'demo' ? 'external-api.demo.kalshi.co' : 'external-api.kalshi.com'
    let response: Response
    try {
      response = await this.transport(`https://${host}${fullPath}`, {
        method,
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
      })
    } catch {
      return fail(options.body ? 'SUBMISSION_UNKNOWN' : 'UNAVAILABLE')
    }
    if (response.status === 403 || response.status === 451) fail('ACCESS_RESTRICTED')
    if (response.status === 401) fail('AUTH_FAILED')
    if (response.status === 404) fail('NOT_FOUND')
    if (options.body && response.status === 400) fail('ORDER_REJECTED')
    if (options.body && (response.status === 409 || response.status >= 500))
      fail('SUBMISSION_UNKNOWN')
    if (response.status === 429) fail(options.body ? 'SUBMISSION_UNKNOWN' : 'RATE_LIMIT')
    if (!response.ok) fail(options.body ? 'SUBMISSION_UNKNOWN' : 'UNAVAILABLE')
    try {
      return (await response.json()) as unknown
    } catch {
      return fail(options.body ? 'SUBMISSION_UNKNOWN' : 'RESPONSE_INVALID')
    }
  }

  private async pages(path: string, key: string) {
    let cursor = ''
    const rows: unknown[] = []
    const cursors = new Set<string>()
    for (let page = 0; page < this.settings.maxPages; page++) {
      const separator = path.includes('?') ? '&' : '?'
      const query = new URLSearchParams({
        limit: '100',
        subaccount: String(this.settings.subaccount),
      })
      if (cursor) query.set('cursor', cursor)
      const data = read(
        z.record(z.string(), z.unknown()),
        await this.request(`${path}${separator}${query}`, { private: true }),
      )
      rows.push(...read(z.array(z.unknown()).max(100), data[key]))
      cursor = read(z.string().max(4096).optional(), data.cursor) || ''
      if (!cursor) return rows
      if (cursors.has(cursor)) fail('PAGINATION_INVALID')
      cursors.add(cursor)
    }
    return fail('HISTORY_INCOMPLETE')
  }

  async market(marketTicker: string) {
    read(ticker, marketTicker)
    const value = read(
      z.object({ market: marketSchema }),
      await this.request(`/markets/${encodeURIComponent(marketTicker)}`),
    ).market
    if (value.ticker !== marketTicker || units(value.notional_value_dollars) !== SCALE)
      fail('MARKET_INVALID')
    for (const band of value.price_ranges) {
      const start = units(band.start),
        end = units(band.end),
        step = units(band.step)
      if (start < 0n || end > SCALE || end <= start || step <= 0n || step > end - start)
        fail('MARKET_INVALID')
    }
    return value
  }

  async orderbook(marketTicker: string) {
    read(ticker, marketTicker)
    const at = this.now()
    const data = read(
      bookSchema,
      await this.request(`/markets/${encodeURIComponent(marketTicker)}/orderbook?depth=100`),
    ).orderbook_fp
    const parse = (levels: [string, string][]) => {
      const seen = new Set<string>()
      return levels
        .map(([price, quantity]) => {
          const p = units(price),
            q = positive(quantity, count)
          if (p <= 0n || p >= SCALE || seen.has(p.toString())) fail('BOOK_INVALID')
          seen.add(p.toString())
          return { price: decimal(p), quantity: decimal(q) }
        })
        .sort((a, b) => (units(a.price) > units(b.price) ? -1 : 1))
    }
    const yesBids = parse(data.yes_dollars),
      noBids = parse(data.no_dollars)
    if (yesBids[0] && noBids[0] && units(yesBids[0].price) + units(noBids[0].price) >= SCALE)
      fail('BOOK_CROSSED')
    return { at, yesBids, noBids }
  }

  async balance() {
    const data = read(
      z.object({ balance_dollars: amount }),
      await this.request(`/portfolio/balance?subaccount=${this.settings.subaccount}`, {
        private: true,
      }),
    )
    return decimal(units(data.balance_dollars))
  }

  async account() {
    if (!this.settings.accountId || this.settings.subaccount < 1) fail('DEDICATED_ACCOUNT_REQUIRED')
    read(identifier, this.settings.accountId)
    const data = read(
      z.object({
        api_keys: z.array(
          z.object({
            api_key_id: z.string(),
            scopes: z.array(z.string()),
            subaccount: z.number().int().nullable().optional(),
            fcm_subtrader_id: z.string().nullable().optional(),
          }),
        ),
        api_key_region_expiration_ts: z.number().int().nullable().optional(),
      }),
      await this.request('/api_keys', { private: true }),
    )
    const key = data.api_keys.find((k) => k.api_key_id === this.settings.keyId)
    if (
      !key ||
      key.subaccount !== this.settings.subaccount ||
      key.fcm_subtrader_id ||
      !key.scopes.includes('read') ||
      !key.scopes.includes('write::trade') ||
      key.scopes.some((scope) => scope !== 'read' && scope !== 'write::trade')
    )
      fail('KEY_PERMISSIONS_INVALID')
    if (
      this.settings.mode === 'live' &&
      (!data.api_key_region_expiration_ts || data.api_key_region_expiration_ts * 1000 <= this.now())
    )
      fail('LOCATION_ATTESTATION_REQUIRED')
    const response = read(
      z.object({ orders: z.array(orderSchema).max(100) }),
      await this.request(`/portfolio/orders?limit=100&subaccount=${this.settings.subaccount}`, {
        private: true,
      }),
    )
    if (
      response.orders.some(
        (o) =>
          o.user_id !== this.settings.accountId || o.subaccount_number !== this.settings.subaccount,
      )
    )
      fail('ACCOUNT_MISMATCH')
    return {
      identity: createHash('sha256')
        .update(
          `kalshi:${this.settings.mode}:${this.settings.accountId}:${this.settings.subaccount}`,
        )
        .digest('hex'),
      accountId: this.settings.accountId,
      subaccount: this.settings.subaccount,
      source: response.orders.length ? ('orders' as const) : ('owner_configuration' as const),
      balance: await this.balance(),
    }
  }

  async allPositions(): Promise<KalshiPosition[]> {
    const rows = await this.pages('/portfolio/positions', 'market_positions')
    return rows.map((row) => {
      const p = read(positionSchema, row)
      return {
        ticker: p.ticker,
        signedQuantity: decimal(units(p.position_fp)),
        exposure: decimal(units(p.market_exposure_dollars)),
        realizedPnl: decimal(units(p.realized_pnl_dollars)),
        feesPaid: decimal(units(p.fees_paid_dollars)),
        updatedAt: p.last_updated_ts,
      }
    })
  }

  async restingOrders() {
    const rows = await this.pages('/portfolio/orders?status=resting', 'orders')
    return rows.map((row) => {
      const o = read(orderSchema, row)
      if (o.user_id !== this.settings.accountId || o.subaccount_number !== this.settings.subaccount)
        fail('ACCOUNT_MISMATCH')
      return { id: o.order_id, ticker: o.ticker, quantity: decimal(units(o.remaining_count_fp)) }
    })
  }

  async positions(marketTicker: string, historical = false): Promise<KalshiPosition[]> {
    read(ticker, marketTicker)
    const rows = await this.pages(
      `${historical ? '/historical' : '/portfolio'}/positions?ticker=${encodeURIComponent(marketTicker)}`,
      'market_positions',
    )
    return rows.map((row) => {
      const p = read(positionSchema, row)
      if (p.ticker !== marketTicker) fail('POSITION_MISMATCH')
      return {
        ticker: p.ticker,
        signedQuantity: decimal(units(p.position_fp)),
        exposure: decimal(units(p.market_exposure_dollars)),
        realizedPnl: decimal(units(p.realized_pnl_dollars)),
        feesPaid: decimal(units(p.fees_paid_dollars)),
        updatedAt: p.last_updated_ts,
      }
    })
  }

  async settlements(marketTicker: string): Promise<KalshiSettlement[]> {
    read(ticker, marketTicker)
    const rows = await this.pages(
      `/portfolio/settlements?ticker=${encodeURIComponent(marketTicker)}`,
      'settlements',
    )
    const seen = new Set<string>()
    return rows.map((row) => {
      const s = read(settlementSchema, row)
      if (s.ticker !== marketTicker) fail('SETTLEMENT_MISMATCH')
      const id = `${s.ticker}:${s.exchange_index}:${s.settled_time}`
      if (seen.has(id)) fail('SETTLEMENT_MISMATCH')
      seen.add(id)
      return {
        id,
        ticker: s.ticker,
        result: s.market_result,
        yesQuantity: decimal(units(s.yes_count_fp)),
        noQuantity: decimal(units(s.no_count_fp)),
        cost: decimal(units(s.yes_total_cost_dollars) + units(s.no_total_cost_dollars)),
        revenue: decimal((BigInt(s.revenue) * SCALE) / 100n),
        fees: decimal(units(s.fee_cost)),
        settledAt: s.settled_time,
      }
    })
  }

  /** Returns an exchange receipt only after the exact isolated holding has settled. */
  async settledPosition(expected: {
    ticker: string
    outcome: KalshiOutcome
    quantity: string
    openedAt: number
  }) {
    const [settlements, positions] = await Promise.all([
      this.settlements(expected.ticker),
      this.positions(expected.ticker),
    ])
    const relevant = settlements.filter((s) => Date.parse(s.settledAt) >= expected.openedAt)
    if (!relevant.length) return null
    if (relevant.length !== 1 || positions.some((p) => units(p.signedQuantity) !== 0n))
      fail('SETTLEMENT_MISMATCH')
    const settlement = relevant[0]!
    const held = expected.outcome === 'yes' ? settlement.yesQuantity : settlement.noQuantity
    const other = expected.outcome === 'yes' ? settlement.noQuantity : settlement.yesQuantity
    if (units(held) !== positive(expected.quantity, count) || units(other) !== 0n)
      fail('SETTLEMENT_MISMATCH')
    return settlement
  }

  async prepare(intent: KalshiOrderIntent): Promise<KalshiPreparedOrder> {
    this.assertWrite()
    if (!this.settings.accountId || this.settings.subaccount < 1) fail('DEDICATED_ACCOUNT_REQUIRED')
    const body = orderBody(intent, this.settings)
    const quantity = units(body.count),
      price = units(intent.limitPrice)
    const maxSpend = positive(intent.maxSpend, amount)
    const reserve = units(read(amount, intent.feeReserve))
    const owned = units(read(count, intent.ownedQuantity))
    const [market, book, account, positions, status] = await Promise.all([
      this.market(intent.ticker),
      this.orderbook(intent.ticker),
      this.account(),
      this.positions(intent.ticker),
      this.request('/exchange/status'),
    ])
    const exchange = read(
      z.object({ exchange_active: z.boolean(), trading_active: z.boolean() }),
      status,
    )
    if (!exchange.exchange_active || !exchange.trading_active) fail('EXCHANGE_PAUSED')
    const now = this.now()
    if (now - book.at > this.settings.maxQuoteAgeMs) fail('QUOTE_STALE')
    if (
      market.status !== 'active' ||
      Date.parse(market.open_time) > now ||
      Date.parse(market.close_time) <= now + this.settings.maxQuoteAgeMs
    )
      fail('MARKET_CLOSED')
    const yesPrice = units(body.price)
    if (
      !market.price_ranges.some(
        (b) =>
          yesPrice >= units(b.start) &&
          yesPrice <= units(b.end) &&
          (yesPrice - units(b.start)) % units(b.step) === 0n,
      )
    )
      fail('OFF_GRID_PRICE')
    if (positions.length > 1) fail('POSITION_MISMATCH')
    const position = units(positions[0]?.signedQuantity || '0')
    if (intent.action === 'sell') {
      if (
        quantity > owned ||
        quantity > abs(position) ||
        position > 0n !== (intent.outcome === 'yes')
      )
        fail('INSUFFICIENT_POSITION')
    } else if (position && position > 0n !== (intent.outcome === 'yes')) fail('OPPOSITE_POSITION')
    const cost = (quantity * price) / SCALE
    if ((intent.action === 'buy' ? cost : 0n) + reserve > maxSpend) fail('BUDGET_EXCEEDED')
    if (units(account.balance) < (intent.action === 'buy' ? cost : 0n) + reserve)
      fail('INSUFFICIENT_BALANCE')
    const levels =
      intent.action === 'sell'
        ? intent.outcome === 'yes'
          ? book.yesBids
          : book.noBids
        : intent.outcome === 'yes'
          ? book.noBids
          : book.yesBids
    const available = levels.reduce((sum, row) => {
      const executablePrice = intent.action === 'sell' ? units(row.price) : SCALE - units(row.price)
      return (
        sum +
        ((intent.action === 'sell' ? executablePrice >= price : executablePrice <= price)
          ? units(row.quantity)
          : 0n)
      )
    }, 0n)
    if (available < quantity) fail('INSUFFICIENT_DEPTH')
    return {
      version: 1,
      mode: this.settings.mode,
      accountId: this.settings.accountId,
      clientOrderId: body.client_order_id,
      preparedAt: now,
      expiresAt: book.at + this.settings.maxQuoteAgeMs,
      intent: { ...intent },
      body,
    }
  }

  private validatePrepared(prepared: KalshiPreparedOrder, fresh: boolean) {
    if (
      prepared.version !== 1 ||
      prepared.mode !== this.settings.mode ||
      prepared.accountId !== this.settings.accountId ||
      prepared.clientOrderId !== kalshiClientOrderId(this.settings.mode, prepared.intent.id) ||
      JSON.stringify(prepared.body) !== JSON.stringify(orderBody(prepared.intent, this.settings))
    )
      fail('PREPARED_MISMATCH')
    if (
      fresh &&
      (prepared.preparedAt > this.now() ||
        prepared.expiresAt <= this.now() ||
        prepared.expiresAt - prepared.preparedAt > this.settings.maxQuoteAgeMs)
    )
      fail('QUOTE_STALE')
  }

  async broadcast(
    prepared: KalshiPreparedOrder,
  ): Promise<{ orderId: string; clientOrderId: string }> {
    this.assertWrite()
    this.validatePrepared(prepared, true)
    const data = await this.request('/portfolio/events/orders', {
      private: true,
      body: prepared.body,
    })
    // A malformed success response is uncertain: it must never turn into a second POST.
    const parsed = z
      .object({
        order_id: identifier,
        client_order_id: identifier.optional(),
        fill_count: count,
        remaining_count: count,
      })
      .safeParse(data)
    if (
      !parsed.success ||
      (parsed.data.client_order_id && parsed.data.client_order_id !== prepared.clientOrderId) ||
      units(parsed.data.fill_count) + units(parsed.data.remaining_count) >
        units(prepared.body.count)
    )
      fail('SUBMISSION_UNKNOWN')
    return { orderId: parsed.data.order_id, clientOrderId: prepared.clientOrderId }
  }

  async lookup(prepared: KalshiPreparedOrder, orderId?: string): Promise<KalshiOrderSnapshot> {
    this.validatePrepared(prepared, false)
    let order: z.infer<typeof orderSchema> | undefined
    if (orderId) {
      read(identifier, orderId)
      try {
        order = read(
          z.object({ order: orderSchema }),
          await this.request(`/portfolio/orders/${encodeURIComponent(orderId)}`, { private: true }),
        ).order
      } catch (e) {
        if (!(e instanceof Error) || e.message !== 'EXECUTION_KALSHI_NOT_FOUND') throw e
      }
    }
    if (!order) {
      const min = Math.max(0, Math.floor(prepared.preparedAt / 1000) - 60)
      const suffix = `?ticker=${encodeURIComponent(prepared.intent.ticker)}&min_ts=${min}`
      for (const path of ['/portfolio/orders', '/historical/orders']) {
        const rows = await this.pages(path + suffix, 'orders')
        for (const row of rows) {
          const parsed = read(orderSchema, row)
          if (parsed.client_order_id !== prepared.clientOrderId) continue
          if (order && order.order_id !== parsed.order_id) fail('ORDER_MISMATCH')
          order = parsed
        }
        if (order) break
      }
    }
    const empty: KalshiOrderSnapshot = {
      clientOrderId: prepared.clientOrderId,
      orderId: order?.order_id || null,
      state: 'unknown',
      quantity: prepared.intent.quantity,
      filledQuantity: '0',
      grossAmount: '0',
      feeAmount: '0',
      cashDelta: '0',
      fills: [],
    }
    if (!order) return empty
    if (
      order.client_order_id !== prepared.clientOrderId ||
      order.user_id !== this.settings.accountId ||
      order.ticker !== prepared.intent.ticker ||
      order.book_side !== prepared.body.side ||
      units(order.initial_count_fp) !== units(prepared.body.count) ||
      order.subaccount_number !== this.settings.subaccount ||
      (orderId && order.order_id !== orderId) ||
      units(order.yes_price_dollars) !== units(prepared.body.price) ||
      units(order.yes_price_dollars) + units(order.no_price_dollars) !== SCALE
    )
      fail('ORDER_MISMATCH')
    const suffix = `?ticker=${encodeURIComponent(prepared.intent.ticker)}&order_id=${encodeURIComponent(order.order_id)}`
    let rows = await this.pages('/portfolio/fills' + suffix, 'fills')
    const hasQuantity = () =>
      rows.reduce<bigint>((sum, row) => sum + units(read(fillSchema, row).count_fp), 0n)
    if (hasQuantity() < units(order.fill_count_fp)) {
      // Historical fills have no order_id filter. Filter strictly before accumulating them.
      const historical = await this.pages(
        `/historical/fills?ticker=${encodeURIComponent(prepared.intent.ticker)}&min_ts=${Math.max(0, Math.floor(prepared.preparedAt / 1000) - 60)}`,
        'fills',
      )
      rows = rows.concat(
        historical.filter((row) => read(fillSchema, row).order_id === order!.order_id),
      )
    }
    const seen = new Map<string, string>()
    const fills: KalshiFill[] = []
    let quantity = 0n,
      gross = 0n,
      fees = 0n
    for (const row of rows) {
      const fill = read(fillSchema, row)
      if (
        fill.order_id !== order.order_id ||
        fill.ticker !== prepared.intent.ticker ||
        fill.book_side !== prepared.body.side ||
        fill.subaccount_number !== this.settings.subaccount ||
        units(fill.yes_price_dollars) + units(fill.no_price_dollars) !== SCALE
      )
        fail('FILL_MISMATCH')
      const fingerprint = JSON.stringify(fill)
      if (seen.has(fill.fill_id)) {
        if (seen.get(fill.fill_id) !== fingerprint) fail('FILL_MISMATCH')
        continue
      }
      seen.set(fill.fill_id, fingerprint)
      const q = positive(fill.count_fp, count)
      const p = units(
        prepared.intent.outcome === 'yes' ? fill.yes_price_dollars : fill.no_price_dollars,
      )
      const limit = units(prepared.intent.limitPrice)
      if (p < 0n || p > SCALE || (prepared.intent.action === 'buy' ? p > limit : p < limit))
        fail('FILL_PRICE_MISMATCH')
      const cost = (q * p) / SCALE
      const fee = units(fill.fee_cost)
      quantity += q
      gross += cost
      fees += fee
      fills.push({
        id: fill.fill_id,
        quantity: decimal(q),
        price: decimal(p),
        amount: decimal(cost),
        fee: decimal(fee),
        at: fill.created_time,
      })
    }
    if (quantity > units(order.fill_count_fp) || quantity > units(prepared.body.count))
      fail('FILL_MISMATCH')
    const effects = {
      filledQuantity: decimal(quantity),
      grossAmount: decimal(gross),
      feeAmount: decimal(fees),
      cashDelta: decimal((prepared.intent.action === 'buy' ? -gross : gross) - fees),
      fills,
    }
    if (
      quantity !== units(order.fill_count_fp) ||
      fees !== units(order.taker_fees_dollars) + units(order.maker_fees_dollars)
    )
      return { ...empty, ...effects, state: 'pending' }
    // Report every confirmed cost, including a fee overrun. The ledger must record
    // actual effects before the engine applies its budget stop.
    if (order.status !== 'resting' && units(order.remaining_count_fp) !== 0n) fail('ORDER_MISMATCH')
    return {
      ...empty,
      state:
        order.status === 'resting'
          ? 'pending'
          : quantity === units(prepared.body.count)
            ? 'filled'
            : 'canceled',
      ...effects,
    }
  }
}

/** Adapter consumed by the durable execution engine; the venue also exposes read-only evidence. */
export class KalshiExecutionAdapter implements ExecutionAdapter {
  readonly venue: KalshiExecutionVenue

  constructor(
    settings: KalshiSettings,
    transport: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    this.venue = new KalshiExecutionVenue(settings, transport, clock)
  }

  async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
    if (intent.venue !== 'kalshi' || !['buy', 'sell'].includes(intent.action) || !intent.outcome)
      fail('INTENT_INVALID')
    if (!Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= this.clock())
      fail('QUOTE_STALE')
    const principal = (units(intent.quantity) * units(intent.limitPrice)) / SCALE
    const reserve = units(intent.quoteBudget) - (intent.action === 'buy' ? principal : 0n)
    if (reserve < 0n) fail('BUDGET_EXCEEDED')
    const prepared = await this.venue.prepare({
      id: intent.clientId,
      ticker: intent.symbol,
      outcome: intent.outcome,
      action: intent.action as KalshiAction,
      quantity: intent.quantity,
      limitPrice: intent.limitPrice,
      maxSpend: intent.quoteBudget,
      feeReserve: decimal(reserve),
      ownedQuantity: intent.positionQuantity,
    })
    prepared.expiresAt = Math.min(prepared.expiresAt, intent.expiresAt)
    return {
      intent: { ...intent },
      payload: { kalshi: JSON.parse(JSON.stringify(prepared)) as Json },
      externalId: null,
    }
  }

  private payload(prepared: PreparedExecution): KalshiPreparedOrder {
    const schema = z.object({
      version: z.literal(1),
      mode: z.enum(['demo', 'live']),
      accountId: identifier,
      clientOrderId: identifier,
      preparedAt: z.number().int(),
      expiresAt: z.number().int(),
      intent: z.object({
        id: z.string(),
        ticker,
        outcome: z.enum(['yes', 'no']),
        action: z.enum(['buy', 'sell']),
        quantity: count,
        limitPrice: quote,
        maxSpend: amount,
        feeReserve: amount,
        ownedQuantity: count,
      }),
      body: z.object({
        ticker,
        client_order_id: identifier,
        side: z.enum(['bid', 'ask']),
        count,
        price: quote,
        time_in_force: z.literal('immediate_or_cancel'),
        self_trade_prevention_type: z.literal('taker_at_cross'),
        cancel_order_on_pause: z.literal(true),
        reduce_only: z.boolean(),
        subaccount: z.number().int(),
      }),
    })
    const value = read(schema, prepared.payload.kalshi)
    const i = prepared.intent,
      p = value.intent
    if (
      i.venue !== 'kalshi' ||
      i.clientId !== p.id ||
      i.symbol !== p.ticker ||
      i.outcome !== p.outcome ||
      i.action !== p.action ||
      i.quantity !== p.quantity ||
      i.limitPrice !== p.limitPrice ||
      i.quoteBudget !== p.maxSpend ||
      i.positionQuantity !== p.ownedQuantity ||
      value.expiresAt > i.expiresAt
    )
      fail('PREPARED_MISMATCH')
    return value
  }

  async broadcast(prepared: PreparedExecution): Promise<void> {
    try {
      const ack = await this.venue.broadcast(this.payload(prepared))
      // Saving the ID is an optimization. Recovery can always use the durable client ID.
      prepared.externalId = ack.orderId
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'EXECUTION_KALSHI_ORDER_REJECTED',
          'EXECUTION_KALSHI_AUTH_FAILED',
          'EXECUTION_KALSHI_ACCESS_RESTRICTED',
          'EXECUTION_KALSHI_LIVE_DISABLED',
          'EXECUTION_KALSHI_ELIGIBILITY_REQUIRED',
          'EXECUTION_KALSHI_QUOTE_STALE',
          'EXECUTION_KALSHI_PREPARED_MISMATCH',
          'EXECUTION_KALSHI_CREDENTIALS_REQUIRED',
          'EXECUTION_KALSHI_KEY_INVALID',
        ].includes(error.message)
      )
        throw new ExecutionRejected(error.message)
      throw error
    }
  }

  async lookup(prepared: PreparedExecution): Promise<ExecutionReceipt | null> {
    const snapshot = await this.venue.lookup(
      this.payload(prepared),
      prepared.externalId || undefined,
    )
    if (snapshot.state === 'unknown') return null
    return {
      status: snapshot.state === 'canceled' ? 'cancelled' : snapshot.state,
      externalId: snapshot.orderId,
      filledQuantity: snapshot.filledQuantity,
      grossQuote: snapshot.grossAmount,
      quoteFee: snapshot.feeAmount,
      baseFee: '0',
    }
  }
}
