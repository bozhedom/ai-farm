import { units } from '../../trading/decimal'
import type { Market, TradingSymbol } from '../../trading/types'

/** Deterministic book for Paper unit tests and injected driver venues. Never a live quote. */
export function syntheticBook(
  symbol: TradingSymbol,
  mid: string,
  qty = '10',
  at = Date.now(),
): Market {
  const midPx = units(mid)
  const tick = units('0.01')
  const lot = units('0.001')
  const size = units(qty)
  return {
    instrument: { symbol, lot, minQty: lot, tick, minNotional: units('5') },
    book: {
      symbol,
      at,
      bids: [
        [midPx - tick, size],
        [midPx - tick * 2n, size],
      ],
      asks: [
        [midPx + tick, size],
        [midPx + tick * 2n, size],
      ],
    },
    candles: [
      { at: at - 120_000, close: midPx - tick * 4n },
      { at: at - 60_000, close: midPx - tick * 2n },
      { at, close: midPx },
    ],
  }
}

export function estimatedLiquidation(entry: bigint, leverage: number, side: 'buy' | 'sell') {
  const mm = entry / 200n
  const distance = entry / BigInt(leverage)
  return side === 'buy' ? entry - distance + mm : entry + distance - mm
}
