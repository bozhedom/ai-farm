import { TRADING_POLICY as P, SCOUT_POLICY as S } from '../policy'
import { abs, BPS, decimal, proceeds, ratioBps, units } from './decimal'
import type { Market, MarketListing, StrategyKind, TradingSymbol } from './types'

export function isSymbol(value: string): value is TradingSymbol {
  return /^[A-Z0-9]{1,32}-USDT$/.test(value) && value !== 'USDT-USDT'
}
export function assertSymbol(value: string): asserts value is TradingSymbol {
  if (!isSymbol(value)) throw new Error('TRADING_SYMBOL_FORBIDDEN')
}
export const baseAsset = (symbol: TradingSymbol) => symbol.slice(0, -5)

/** Join exchange metadata to a ticker before admitting a symbol. Missing data is ineligible. */
export function listing(
  base: string,
  quote: string,
  code: string,
  meta: { active: boolean; restricted?: boolean; listedAt?: string },
  ticker:
    | {
        at: number
        bid: string
        ask: string
        last: string
        open: string
        high: string
        low: string
        turnover: string
      }
    | undefined,
): MarketListing[] {
  const symbol = `${base}-${quote}`
  if (!isSymbol(symbol) || ![symbol, base + quote].includes(code)) return []
  const row: MarketListing = {
    symbol,
    active: meta.active,
    restricted: !!meta.restricted,
    listedAt: meta.listedAt && Number(meta.listedAt) > 0 ? Number(meta.listedAt) : null,
    at: 0,
    bid: 0n,
    ask: 0n,
    last: 0n,
    open: 0n,
    high: 0n,
    low: 0n,
    turnover: 0n,
  }
  if (ticker) {
    try {
      Object.assign(row, {
        at: ticker.at,
        bid: units(ticker.bid),
        ask: units(ticker.ask),
        last: units(ticker.last),
        open: units(ticker.open),
        high: units(ticker.high),
        low: units(ticker.low),
        turnover: units(ticker.turnover),
      })
    } catch {
      /* A malformed ticker must not make a different coin tradable. */
    }
  }
  return [row]
}

export type ScoutCoin = {
  symbol: TradingSymbol
  price: string
  turnover: string
  changeBps: number
  rangeBps: number
  spreadBps: number
  movementBps: number
  trendBps: number
  score: number
  reason: string
  eligible: boolean
  inspectedAt: number | null
}
const stableAssets = new Set([
  'USDC',
  'DAI',
  'TUSD',
  'FDUSD',
  'USDE',
  'USD1',
  'USDD',
  'PYUSD',
  'USDG',
  'USDP',
  'RLUSD',
  'EUR',
  'EURC',
  'EURI',
])
export function screen(row: MarketListing, now = Date.now()): ScoutCoin {
  let reason = ''
  const spread = ratioBps(row.ask - row.bid, row.bid)
  const range = ratioBps(row.high - row.low, row.low)
  const change = ratioBps(row.last - row.open, row.open)
  const base = baseAsset(row.symbol)
  if (!isSymbol(row.symbol) || !row.active) reason = 'SCOUT_INACTIVE'
  else if (row.restricted || stableAssets.has(base) || /(?:[235][LS]|BULL|BEAR)$/.test(base))
    reason = 'SCOUT_UNSUITABLE_ASSET'
  else if (!Number.isSafeInteger(row.at) || now - row.at > S.tickerMaxAgeMs || row.at > now + 2000)
    reason = 'SCOUT_NO_DATA'
  else if (
    [row.bid, row.ask, row.last, row.open, row.high, row.low, row.turnover].some((v) => v <= 0n) ||
    row.ask <= row.bid ||
    row.high < row.low
  )
    reason = 'SCOUT_NO_DATA'
  else if (
    row.listedAt !== null &&
    (!Number.isSafeInteger(row.listedAt) || now - row.listedAt < S.minListingAgeMs)
  )
    reason = 'SCOUT_NEW_LISTING'
  else if (row.turnover < units(String(S.minTurnoverUsdt))) reason = 'SCOUT_LOW_VOLUME'
  else if ((row.ask - row.bid) * BPS > row.bid * BigInt(P.maxSpreadBps))
    reason = 'TRADING_SPREAD_TOO_WIDE'
  else if (range > S.maxRangeBps || Math.abs(change) > S.maxChangeBps) reason = 'SCOUT_EXTREME_MOVE'
  else if (range < S.minRangeBps) reason = 'SCOUT_QUIET'
  const liquidity = Math.min(100, Number(row.turnover / units('1000000')))
  return {
    symbol: row.symbol,
    price: decimal(row.last),
    turnover: decimal(row.turnover),
    changeBps: change,
    rangeBps: range,
    spreadBps: spread,
    movementBps: 0,
    trendBps: 0,
    score: reason ? 0 : Math.min(range, 800) + liquidity - spread * 5,
    reason: reason || 'SCOUT_ON_RADAR',
    eligible: false,
    inspectedAt: null,
  }
}

/** Historical movement is an opportunity filter, never a forecast or a purchase signal. */
export function inspectCandidate(coin: ScoutCoin, market: Market) {
  coin.eligible = false
  const bars = market.candles.slice(-120)
  if (bars.length < 120) return 'SCOUT_SHORT_HISTORY'
  const high = bars.reduce((p, c) => (c.close > p ? c.close : p), 0n)
  const low = bars.reduce((p, c) => (c.close < p ? c.close : p), high)
  coin.movementBps = ratioBps(high - low, low)
  coin.trendBps = ratioBps(bars.at(-1)!.close - bars[0]!.close, bars[0]!.close)
  if (coin.movementBps < S.minMovementBps) return 'SCOUT_QUIET'
  if (coin.movementBps > S.maxRecentMovementBps) return 'SCOUT_EXTREME_MOVE'
  if (
    bars.some(
      (c, i) =>
        i &&
        abs(c.close - bars[i - 1]!.close) * BPS > bars[i - 1]!.close * BigInt(S.maxMinuteMoveBps),
    )
  )
    return 'SCOUT_EXTREME_MOVE'
  const { book, instrument } = market
  for (const [levels, buy] of [
    [book.asks, true],
    [book.bids, false],
  ] as const) {
    const best = levels[0]![0]
    const depth = levels
      .filter(([p]) =>
        buy
          ? p * BPS <= best * (BPS + BigInt(P.slippageBps))
          : p * BPS >= best * (BPS - BigInt(P.slippageBps)),
      )
      .reduce((sum, [p, q]) => sum + proceeds(q, p), 0n)
    if (depth < units(String(P.orderUsdt * S.depthOrderMultiplier))) return 'SCOUT_THIN_BOOK'
  }
  const affordable = (units(String(P.orderUsdt)) * BPS) / (BPS + BigInt(P.maxFeeBps))
  if (
    (instrument.minNotional || 0n) > affordable ||
    proceeds(instrument.minQty, book.asks[0]![0]) > affordable
  )
    return 'SCOUT_ORDER_TOO_SMALL'
  coin.score += Math.min(coin.movementBps, 400)
  coin.eligible = true
  return 'SCOUT_READY'
}

export function rankedFor(kind: StrategyKind, coins: ScoutCoin[]) {
  const score = (c: ScoutCoin) =>
    c.score +
    (kind === 'reversion' || kind === 'grid'
      ? Math.max(0, 150 - Math.abs(c.trendBps))
      : Math.max(-200, Math.min(200, c.trendBps)))
  return coins
    .filter((c) => c.eligible)
    .sort((a, b) => score(b) - score(a) || a.symbol.localeCompare(b.symbol))
}
