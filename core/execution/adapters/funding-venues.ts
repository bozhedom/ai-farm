import { createHash, createHmac } from 'node:crypto'
import { EXECUTION_POLICY as P } from '../../policy'
import { units } from '../../trading/decimal'
import type { TradingSymbol } from '../../trading/types'
import { BybitFundingAdapter, type BybitFundingOptions, type FundingMarket } from './bybit-funding'
import type { ExecutionAdapter, ExecutionExchange, ExecutionIntent, ExecutionReceipt, PreparedExecution } from '../types'

export type FundingCredentials = { key: string; secret: string; passphrase?: string }
export type FundingVenueOptions = {
  mode: 'demo' | 'live'
  exchange: ExecutionExchange
  credentials: FundingCredentials
  liveEnabled?: boolean
  authorizeWrite?: () => boolean | Promise<boolean>
}

/** Public + private surface the funding driver already expects from Bybit. */
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
        authorizeWrite: options.authorizeWrite
          ? async () => options.authorizeWrite!()
          : undefined,
      } satisfies BybitFundingOptions,
      fetchImpl,
      now,
    )
  }
  return new RestFundingAdapter(options, fetchImpl, now)
}

class RestFundingAdapter implements FundingVenueClient {
  constructor(
    private readonly options: FundingVenueOptions,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number,
  ) {}

  private host() {
    const { exchange, mode } = this.options
    if (exchange === 'okx') return mode === 'demo' ? 'https://www.okx.com' : 'https://www.okx.com'
    if (exchange === 'binance')
      return mode === 'demo' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com'
    return 'https://api.bitget.com'
  }

  private sign(method: string, path: string, body: string, timestamp: string) {
    const { exchange, credentials } = this.options
    if (exchange === 'okx') {
      return createHmac('sha256', credentials.secret)
        .update(timestamp + method + path + body)
        .digest('base64')
    }
    if (exchange === 'binance') {
      return createHmac('sha256', credentials.secret).update(body || path.split('?')[1] || '').digest('hex')
    }
    return createHmac('sha256', credentials.secret)
      .update(timestamp + method + path + body)
      .digest('base64')
  }

  async request(method: string, path: string, body?: unknown, signed = false) {
    const payload = body ? JSON.stringify(body) : ''
    const timestamp = this.options.exchange === 'okx' ? new Date(this.now()).toISOString() : String(this.now())
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (payload) headers['Content-Type'] = 'application/json'
    if (signed) {
      const { key, passphrase } = this.options.credentials
      const sign = this.sign(method, path, payload, timestamp)
      if (this.options.exchange === 'okx') {
        Object.assign(headers, {
          'OK-ACCESS-KEY': key,
          'OK-ACCESS-PASSPHRASE': passphrase || '',
          'OK-ACCESS-TIMESTAMP': timestamp,
          'OK-ACCESS-SIGN': sign,
        })
        if (this.options.mode === 'demo') headers['x-simulated-trading'] = '1'
      } else if (this.options.exchange === 'binance') {
        headers['X-MBX-APIKEY'] = key
      } else {
        Object.assign(headers, {
          'ACCESS-KEY': key,
          'ACCESS-PASSPHRASE': passphrase || '',
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-SIGN': sign,
        })
      }
    }
    const response = await this.fetchImpl(this.host() + path, {
      method,
      headers,
      body: payload || undefined,
      signal: AbortSignal.timeout(7000),
    })
    if (!response.ok) throw new Error('EXECUTION_CONNECTION_FAILED')
    return response.json()
  }

  async discover(): Promise<TradingSymbol[]> {
    return ['BTC-USDT', 'ETH-USDT']
  }

  async market(symbol: TradingSymbol): Promise<FundingMarket> {
    void symbol
    throw new Error('EXECUTION_MARKET_UNAVAILABLE')
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
  async fundingRates(_symbol: TradingSymbol, _from: number, _to: number) {
    return [] as { at: number; rate: bigint }[]
  }
  async prepare(_intent: ExecutionIntent): Promise<PreparedExecution> {
    throw new Error('EXECUTION_CREDENTIALS_REQUIRED')
  }
  async broadcast(_prepared: PreparedExecution) {
    if (this.options.mode === 'live' && !this.options.liveEnabled) throw new Error('EXECUTION_LIVE_DISABLED')
    if (this.options.authorizeWrite && !(await this.options.authorizeWrite()))
      throw new Error('EXECUTION_WRITE_FORBIDDEN')
  }
  async lookup(): Promise<ExecutionReceipt | null> {
    return null
  }
  async cancel() {}
}

export function fundingEnvPrefix(exchange: ExecutionExchange, mode: 'demo' | 'live') {
  return `FUNDING_${exchange.toUpperCase()}_${mode.toUpperCase()}`
}

export function parsePositive(value: string) {
  const amount = units(value)
  if (amount <= 0n) throw new Error('EXECUTION_DECIMAL_INVALID')
  return amount
}
