import { EARNINGS_POLICY as P, SCOUT_POLICY as S } from '../policy'
import { BPS, cost, decimal, fee, min, proceeds, ratioBps, units } from '../trading/decimal'
import { createVenue } from '../trading/venues'
import {
  exchanges,
  type Book,
  type Market,
  type MarketListing,
  type TradingExchange,
  type TradingSymbol,
} from '../trading/types'
import { screen } from '../trading/universe'

export interface ArbitrageObservation {
  symbol: string
  buyExchange: TradingExchange
  sellExchange: TradingExchange
  ask: string
  bid: string
  grossBps: number
  estimatedNetBps: number
  /** Ranking key: depth-adjusted net when probed, else ticker net minus a local-spread penalty. */
  scoreBps: number
  /** Smaller 24h turnover of the two venues (USDT), for liquidity context. */
  minTurnover: string
  depthChecked: boolean
  /** How much of the sample notional both books could fill; null when depth was not probed. */
  fillableNotional: string | null
  observedAt: string
  identityVerified: false
}
export interface ArbitrageReport {
  fetchedAt: string
  expiresAt: string
  sources: { exchange: TradingExchange; status: 'ok' | 'unavailable'; pairs: number }[]
  pairsCompared: number
  feeBpsPerLeg: number
  slippageBpsPerLeg: number
  sampleNotional: string
  items: ArbitrageObservation[]
}
type Quotes = Partial<Record<TradingExchange, MarketListing[]>>
type Side = { exchange: TradingExchange; row: MarketListing }

/** Walk asks until `notional` USDT is spent; returns filled quote and base qty. */
export function walkAsks(book: Book, notional: bigint, levels: number) {
  let remaining = notional
  let spent = 0n
  let qty = 0n
  for (const [price, size] of book.asks.slice(0, levels)) {
    if (remaining <= 0n || price <= 0n || size <= 0n) break
    const levelCost = cost(size, price)
    if (levelCost >= remaining) {
      // Floor qty for the leftover notional; count the leftover as spent so fillable==sample.
      const take = (remaining * units('1')) / price
      if (take <= 0n) break
      qty += take
      spent += remaining
      remaining = 0n
      break
    }
    qty += size
    spent += levelCost
    remaining -= levelCost
  }
  return { spent, qty, remaining }
}

/** Walk bids until `qty` base is sold; returns quote proceeds. */
export function walkBids(book: Book, qty: bigint, levels: number) {
  let left = qty
  let earned = 0n
  for (const [price, size] of book.bids.slice(0, levels)) {
    if (left <= 0n || price <= 0n || size <= 0n) break
    const take = size < left ? size : left
    earned += proceeds(take, price)
    left -= take
  }
  return { earned, remaining: left }
}

function tickerNet(buyAsk: bigint, sellBid: bigint) {
  const entry = buyAsk * (BPS + BigInt(P.feeBpsPerLeg + P.slippageBpsPerLeg))
  const exit = sellBid * (BPS - BigInt(P.feeBpsPerLeg + P.slippageBpsPerLeg))
  return ratioBps(exit - entry, entry)
}

function localSpreadPenalty(row: MarketListing) {
  // Wide local books already show up in ask/bid; still demote noisy venues in the score.
  const spread = ratioBps(row.ask - row.bid, row.bid)
  return Math.min(40, Math.max(0, Math.floor(spread / 2)))
}

function rank(a: ArbitrageObservation, b: ArbitrageObservation) {
  if (b.scoreBps !== a.scoreBps) return b.scoreBps - a.scoreBps
  const turn = units(b.minTurnover) - units(a.minTurnover)
  if (turn !== 0n) return turn > 0n ? 1 : -1
  return a.symbol.localeCompare(b.symbol)
}

function observation(symbol: string, buy: Side, sell: Side): ArbitrageObservation {
  const net = tickerNet(buy.row.ask, sell.row.bid)
  const penalty = localSpreadPenalty(buy.row) + localSpreadPenalty(sell.row)
  const turnover = min(buy.row.turnover, sell.row.turnover)
  return {
    symbol,
    buyExchange: buy.exchange,
    sellExchange: sell.exchange,
    ask: decimal(buy.row.ask),
    bid: decimal(sell.row.bid),
    grossBps: ratioBps(sell.row.bid - buy.row.ask, buy.row.ask),
    estimatedNetBps: net,
    scoreBps: net - penalty,
    minTurnover: decimal(turnover),
    depthChecked: false,
    fillableNotional: null,
    observedAt: new Date(Math.min(buy.row.at, sell.row.at)).toISOString(),
    identityVerified: false,
  }
}

/** A ticker comparison is not executable arbitrage: token identity and depth are unverified. */
export function compareQuotes(quotes: Quotes, now = Date.now()): ArbitrageReport {
  const grouped = new Map<string, Side[]>()
  const sources = exchanges.map((exchange) => {
    const rows = quotes[exchange]
    const accepted = (rows || []).filter((row) => {
      const reason = screen(row, now).reason
      // Quiet markets can be compared too. Other scout restrictions remain in force.
      return reason === 'SCOUT_ON_RADAR' || reason === 'SCOUT_QUIET'
    })
    for (const row of accepted) {
      const group = grouped.get(row.symbol) || []
      if (!group.some((q) => q.exchange === exchange)) group.push({ exchange, row })
      grouped.set(row.symbol, group)
    }
    return {
      exchange,
      status: rows ? ('ok' as const) : ('unavailable' as const),
      pairs: accepted.length,
    }
  })
  const observations: ArbitrageObservation[] = []
  let pairsCompared = 0
  for (const [symbol, group] of grouped) {
    if (group.length < 2) continue
    let best: ArbitrageObservation | null = null
    for (const buy of group)
      for (const sell of group) {
        if (buy.exchange === sell.exchange || Math.abs(buy.row.at - sell.row.at) > P.quoteSkewMs)
          continue
        if (buy.row.ask <= 0n || sell.row.bid <= 0n || sell.row.bid < buy.row.ask) continue
        const next = observation(symbol, buy, sell)
        if (!best || rank(next, best) < 0) best = next
      }
    if (best) {
      pairsCompared++
      observations.push(best)
    }
  }
  return {
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(
      Math.min(now, ...observations.map((o) => Date.parse(o.observedAt))) + S.tickerMaxAgeMs,
    ).toISOString(),
    sources,
    pairsCompared,
    feeBpsPerLeg: P.feeBpsPerLeg,
    slippageBpsPerLeg: P.slippageBpsPerLeg,
    sampleNotional: P.sampleNotional,
    items: observations.sort(rank).slice(0, P.maxComparisons),
  }
}

function depthNet(buy: Market, sell: Market, sample: bigint) {
  const bought = walkAsks(buy.book, sample, P.depthLevels)
  if (bought.qty <= 0n || bought.spent <= 0n) return null
  const sold = walkBids(sell.book, bought.qty, P.depthLevels)
  const filled = sample - bought.remaining
  const buyCost = bought.spent + fee(bought.spent, P.feeBpsPerLeg)
  const sellProceeds = sold.earned - fee(sold.earned, P.feeBpsPerLeg)
  if (buyCost <= 0n) return null
  return {
    netBps: ratioBps(sellProceeds - buyCost, buyCost),
    fillable: filled,
    incomplete: bought.remaining > 0n || sold.remaining > 0n,
  }
}

export type MarketReader = (exchange: TradingExchange, symbol: TradingSymbol) => Promise<Market>

/** Re-rank top ticker spreads with a bounded public order-book probe (observation only). */
export async function enrichWithDepth(
  report: ArbitrageReport,
  readMarket: MarketReader,
): Promise<ArbitrageReport> {
  const sample = units(P.sampleNotional)
  const candidates = [...report.items]
    .sort((a, b) => b.scoreBps - a.scoreBps || a.symbol.localeCompare(b.symbol))
    .slice(0, P.depthCandidates)
  const enriched = await Promise.all(
    candidates.map(async (item) => {
      try {
        const symbol = item.symbol as TradingSymbol
        const [buy, sell] = await Promise.all([
          readMarket(item.buyExchange, symbol),
          readMarket(item.sellExchange, symbol),
        ])
        const probed = depthNet(buy, sell, sample)
        if (!probed) return item
        // Incomplete depth is still informative but ranks below a full fill of the sample.
        const score = probed.incomplete ? probed.netBps - 25 : probed.netBps
        return {
          ...item,
          estimatedNetBps: probed.netBps,
          scoreBps: score,
          depthChecked: true,
          fillableNotional: decimal(probed.fillable),
          ask: decimal(buy.book.asks[0]?.[0] || units(item.ask)),
          bid: decimal(sell.book.bids[0]?.[0] || units(item.bid)),
          observedAt: new Date(
            Math.min(buy.book.at, sell.book.at, Date.parse(item.observedAt)),
          ).toISOString(),
        }
      } catch {
        return item
      }
    }),
  )
  const byKey = new Map(
    enriched.map((item) => [`${item.symbol}:${item.buyExchange}:${item.sellExchange}`, item]),
  )
  const items = report.items
    .map((item) => byKey.get(`${item.symbol}:${item.buyExchange}:${item.sellExchange}`) || item)
    .sort(rank)
    .slice(0, P.maxComparisons)
  const observed = items.map((o) => Date.parse(o.observedAt))
  return {
    ...report,
    expiresAt: new Date(
      Math.min(Date.parse(report.fetchedAt), ...observed) + S.tickerMaxAgeMs,
    ).toISOString(),
    items,
  }
}

export async function fetchArbitrageResearch(
  discover: (exchange: TradingExchange) => Promise<MarketListing[]> = (exchange) =>
    createVenue({ exchange, mode: 'paper' }).discover(),
  readMarket: MarketReader = (exchange, symbol) =>
    createVenue({ exchange, mode: 'paper' }).market(symbol),
): Promise<ArbitrageReport> {
  const results = await Promise.allSettled(exchanges.map(discover))
  const quotes: Quotes = {}
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') quotes[exchanges[i]!] = result.value
  })
  const tickers = compareQuotes(quotes)
  if (!tickers.items.length) return tickers
  return enrichWithDepth(tickers, readMarket)
}
