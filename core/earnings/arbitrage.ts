import { EARNINGS_POLICY as P, SCOUT_POLICY as S } from '../policy'
import { BPS, decimal, ratioBps } from '../trading/decimal'
import { createVenue } from '../trading/venues'
import { exchanges, type MarketListing, type TradingExchange } from '../trading/types'
import { screen } from '../trading/universe'

export interface ArbitrageObservation {
  symbol: string
  buyExchange: TradingExchange
  sellExchange: TradingExchange
  ask: string
  bid: string
  grossBps: number
  estimatedNetBps: number
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
  items: ArbitrageObservation[]
}
type Quotes = Partial<Record<TradingExchange, MarketListing[]>>

/** A ticker comparison is not executable arbitrage: token identity and depth are unverified. */
export function compareQuotes(quotes: Quotes, now = Date.now()): ArbitrageReport {
  const grouped = new Map<string, { exchange: TradingExchange; row: MarketListing }[]>()
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
        const entry = buy.row.ask * (BPS + BigInt(P.feeBpsPerLeg + P.slippageBpsPerLeg))
        const exit = sell.row.bid * (BPS - BigInt(P.feeBpsPerLeg + P.slippageBpsPerLeg))
        const observation: ArbitrageObservation = {
          symbol,
          buyExchange: buy.exchange,
          sellExchange: sell.exchange,
          ask: decimal(buy.row.ask),
          bid: decimal(sell.row.bid),
          grossBps: ratioBps(sell.row.bid - buy.row.ask, buy.row.ask),
          estimatedNetBps: ratioBps(exit - entry, entry),
          observedAt: new Date(Math.min(buy.row.at, sell.row.at)).toISOString(),
          identityVerified: false,
        }
        if (!best || observation.estimatedNetBps > best.estimatedNetBps) best = observation
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
    items: observations
      .sort((a, b) => b.estimatedNetBps - a.estimatedNetBps || a.symbol.localeCompare(b.symbol))
      .slice(0, P.maxComparisons),
  }
}

export async function fetchArbitrageResearch(
  discover: (exchange: TradingExchange) => Promise<MarketListing[]> = (exchange) =>
    createVenue({ exchange, mode: 'paper' }).discover(),
): Promise<ArbitrageReport> {
  const results = await Promise.allSettled(exchanges.map(discover))
  const quotes: Quotes = {}
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') quotes[exchanges[i]!] = result.value
  })
  return compareQuotes(quotes)
}
