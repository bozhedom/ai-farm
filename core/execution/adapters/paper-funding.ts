import { SCALE, units } from '../../trading/decimal'
import type { TradingSymbol } from '../../trading/types'
import { syntheticBook } from './paper-markets'
import type { FundingMarket, FundingPosition, FundingCashflow } from './bybit-funding'
import type { FundingVenueClient } from './funding-venues'

/** Virtual funding venue for Paper on OKX/Binance/Bitget (and tests). No network I/O. */
export function createPaperFundingVenue(
  identity = 'paper-funding:virtual',
  now: () => number = Date.now,
): FundingVenueClient {
  const interval = 8 * 60
  async function market(symbol: TradingSymbol): Promise<FundingMarket> {
    const at = now()
    const spot = syntheticBook(symbol, '100', '10', at)
    const perp = syntheticBook(symbol, '100', '10', at)
    return {
      spot,
      perp,
      spotMaxQty: units('5'),
      perpMaxQty: units('5'),
      fundingRate: SCALE / 100n, // 1% virtual paper rate, not a live quote
      fundingIntervalMinutes: interval,
      nextFundingAt: at + 20 * 60_000,
      at,
    }
  }
  return {
    market,
    async discover() {
      return ['BTC-USDT']
    },
    async account() {
      return {
        identity,
        balances: { USDT: { total: units('100'), available: units('100') } },
        availableMargin: units('100'),
        positions: [] as FundingPosition[],
        feeBps: { spot: 10, perp: 10 },
      }
    },
    async positions() {
      return []
    },
    async pending() {
      return []
    },
    async fundingHistory() {
      return [] as FundingCashflow[]
    },
    async fundingRates(symbol, from, to) {
      void symbol
      const rows: { at: number; rate: bigint }[] = []
      const step = interval * 60_000
      for (let at = from + step; at <= to; at += step) rows.push({ at, rate: SCALE / 100n })
      return rows
    },
    async prepare() {
      throw new Error('EXECUTION_ADAPTER_REQUIRED')
    },
    async broadcast() {},
    async lookup() {
      return null
    },
    async cancel() {},
  }
}
