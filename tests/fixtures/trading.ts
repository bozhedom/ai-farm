import { units } from '../../core/trading/decimal'
import type { AgentRow, Market, TradingSymbol } from '../../core/trading/types'

export function market(
  symbol: TradingSymbol = 'BTC-USDT',
  price = '100',
  reference = '102',
): Market {
  const now = Date.now()
  const minute = Math.floor(now / 60_000) * 60_000
  return {
    instrument: { symbol, lot: units('0.00000001'), minQty: units('0.00001'), tick: units('0.01') },
    book: {
      symbol,
      at: now,
      bids: [[units(price) - units('0.01'), units('100')]],
      asks: [[units(price), units('100')]],
    },
    candles: Array.from({ length: 120 }, (_, i) => ({
      at: minute - (120 - i) * 60_000,
      close: units(reference),
    })),
  }
}

export function agent(override: Partial<AgentRow> = {}): AgentRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    mode: 'paper',
    name: 'Прилив',
    symbol: 'BTC-USDT',
    kind: 'reversion',
    params: { lookback: 60, entryBps: 60, takeProfitBps: 100 },
    status: 'active',
    parent_id: null,
    generation: 1,
    initial_cash: units('25').toString(),
    cash: units('25').toString(),
    base: '0',
    basis: '0',
    realized: '0',
    fees: '0',
    peak: units('25').toString(),
    max_drawdown_bps: 0,
    round_trips: 0,
    last_order_at: null,
    created_at: new Date(),
    last_signal: 'WAITING_MARKET',
    ...override,
  }
}
