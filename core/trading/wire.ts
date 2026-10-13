import { createHash } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config'
import { TRADING_POLICY as P } from '../policy'
import { abs, BPS, ceilDiv, SCALE, units } from './decimal'
import { exchangeCatalog } from './catalog'
import type { Balances, TradingExchange, TradingMode, TradingScope, TradingSymbol } from './types'
import { assertSymbol } from './universe'

export class OrderRejected extends Error {
  constructor() {
    super('TRADING_ORDER_REJECTED')
  }
}
export class ExchangeError extends Error {
  constructor(readonly code: string) {
    super('TRADING_EXCHANGE_ERROR')
  }
}
/** An isolated execution account can reuse transport without borrowing spot credentials. */
export interface VenueAccess {
  credentials: { key: string; secret: string; passphrase: string }
  authorize: () => void
}
// Monetary values must be decimal strings. Numeric IDs are accepted only without precision loss.
export const id = z.union([
  z.string().min(1),
  z.number().int().refine(Number.isSafeInteger).transform(String),
])
export const str = z.string()
export const levels = z.array(z.array(str).min(2)).min(1)
export function keys(exchange: TradingExchange, mode: TradingMode) {
  if (mode === 'paper') throw new Error('TRADING_CREDENTIALS_REQUIRED')
  const c = config(),
    prefix = `${exchange.toUpperCase()}_${mode.toUpperCase()}`
  const read = (suffix: string) => String(c[`${prefix}_${suffix}` as keyof typeof c] || '')
  const result = { key: read('API_KEY'), secret: read('SECRET'), passphrase: read('PASSPHRASE') }
  if (!result.key || !result.secret || (exchangeCatalog[exchange].passphrase && !result.passphrase))
    throw new Error('TRADING_CREDENTIALS_REQUIRED')
  return result
}
export function hasKeys(s: TradingScope) {
  if (s.mode === 'paper') return true
  try {
    keys(s.exchange, s.mode)
    return true
  } catch {
    return false
  }
}
export function identity(exchange: TradingExchange, mode: TradingMode, host: string, uid: string) {
  return createHash('sha256').update(`${exchange}:${mode}:${host}:${uid}`).digest('hex')
}
export function emptyBalances(): Balances {
  return {
    USDT: { total: 0n, available: 0n },
    BTC: { total: 0n, available: 0n },
    ETH: { total: 0n, available: 0n },
  }
}
export function setBalance(b: Balances, coin: string, total: string, available: string) {
  const t = units(total),
    a = units(available)
  if (t < 0n || a < 0n || a > t) throw new Error('TRADING_BALANCE_INVALID')
  // Never ignore foreign holdings, even when the asset cannot be selected for trading.
  if (!/^[A-Za-z0-9_]{1,40}$/.test(coin)) {
    if (t || a) throw new Error('TRADING_BALANCE_INVALID')
    return
  }
  Object.defineProperty(b, coin, {
    value: { total: t, available: a },
    enumerable: true,
    writable: true,
    configurable: true,
  })
}
export function feeBps(rate: bigint) {
  const n = Number(ceilDiv(abs(rate) * BPS, SCALE))
  if (n > P.maxFeeBps) throw new Error('TRADING_FEE_TOO_HIGH')
  return n
}
export function compactSymbol(symbol: TradingSymbol) {
  assertSymbol(symbol)
  return symbol.replace('-', '')
}
export function checkClock(stamp: number) {
  if (!Number.isSafeInteger(stamp) || Math.abs(Date.now() - stamp) > 4000)
    throw new Error('TRADING_CLOCK_SKEW')
}
export function boundIp(values: string[]) {
  if (
    !values.length ||
    values.some((ip) => !ip.trim() || ['*', '0.0.0.0', '0.0.0.0/0', '::/0'].includes(ip.trim()))
  )
    throw new Error('TRADING_IP_REQUIRED')
}
export async function responseJson(
  transport: typeof fetch,
  url: string,
  options: RequestInit = {},
  exactArrayNumbers = false,
) {
  let response: Response
  try {
    response = await transport(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
    })
  } catch {
    throw new Error('TRADING_NETWORK_UNAVAILABLE')
  }
  if (response.status === 429) throw new Error('TRADING_RATE_LIMIT')
  if (response.status === 403 || response.status === 451)
    throw new Error('TRADING_REGION_UNAVAILABLE')
  if (response.status >= 500) throw new Error('TRADING_NETWORK_UNAVAILABLE')
  try {
    if (!exactArrayNumbers) return (await response.json()) as unknown
    // Bitget depth encodes prices/quantities as JSON numbers. Node 24 exposes the
    // original token to the reviver: never round a monetary value through Number.
    return JSON.parse(await response.text(), function (key, value, context?: { source?: string }) {
      if (Array.isArray(this) && typeof value === 'number') {
        if (!context?.source) throw new Error('TRADING_PRECISION_UNSUPPORTED')
        return exactNumberToken(context.source)
      }
      return value
    }) as unknown
  } catch {
    throw new Error('TRADING_RESPONSE_INVALID')
  }
}

function exactNumberToken(source: string) {
  if (!/[eE]/.test(source)) return source
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d{1,2})$/.exec(source)
  if (!m) throw new Error('TRADING_PRECISION_UNSUPPORTED')
  const digits = m[2]! + (m[3] || ''),
    point = m[2]!.length + Number(m[4])
  if (Math.abs(point) > 36) throw new Error('TRADING_PRECISION_UNSUPPORTED')
  return (
    m[1] +
    (point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point))
  )
}
export function allowPlace(mode: TradingMode, access?: VenueAccess) {
  if (mode === 'paper') throw new Error('TRADING_PAPER_ONLY')
  if (access) return access.authorize()
  if (mode === 'live' && !config().TRADING_LIVE_ENABLED) throw new Error('TRADING_LIVE_DISABLED')
}
