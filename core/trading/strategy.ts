import { z } from 'zod'
import { TRADING_POLICY as P } from '../policy'
import { BPS, SCALE, cost, fee, floorStep, min, proceeds, ratioBps, units } from './decimal'
import type { AgentRow, Market, OrderRequest, StrategyKind, StrategyParams } from './types'

export const paramsSchema = z
  .object({
    lookback: z.number().int().min(15).max(120),
    entryBps: z.number().int().min(30).max(300),
    takeProfitBps: z.number().int().min(50).max(600),
  })
  .strict()

export const seeds: {
  name: string
  symbol: AgentRow['symbol']
  kind: StrategyKind
  params: StrategyParams
}[] = [
  {
    name: 'Прилив',
    symbol: 'BTC-USDT',
    kind: 'reversion',
    params: { lookback: 60, entryBps: 60, takeProfitBps: 100 },
  },
  {
    name: 'Вектор',
    symbol: 'BTC-USDT',
    kind: 'trend',
    params: { lookback: 90, entryBps: 40, takeProfitBps: 150 },
  },
  {
    name: 'Импульс',
    symbol: 'ETH-USDT',
    kind: 'breakout',
    params: { lookback: 60, entryBps: 35, takeProfitBps: 150 },
  },
  {
    name: 'Баланс',
    symbol: 'ETH-USDT',
    kind: 'reversion',
    params: { lookback: 90, entryBps: 80, takeProfitBps: 120 },
  },
]

export function validateMarket(market: Market, now = Date.now()) {
  const { book, instrument, candles } = market
  if (!P.symbols.includes(instrument.symbol) || book.symbol !== instrument.symbol)
    throw new Error('TRADING_SYMBOL_FORBIDDEN')
  if (instrument.lot <= 0n || instrument.minQty < instrument.lot || instrument.tick <= 0n)
    throw new Error('TRADING_INSTRUMENT_INVALID')
  if (!Number.isSafeInteger(book.at) || now - book.at > P.bookMaxAgeMs || book.at - now > 2000)
    throw new Error('TRADING_STALE_MARKET')
  for (const [side, levels] of [
    ['bid', book.bids],
    ['ask', book.asks],
  ] as const) {
    if (!levels.length) throw new Error('TRADING_EMPTY_BOOK')
    for (let i = 0; i < levels.length; i++) {
      const [price, qty] = levels[i]!
      const prev = levels[i - 1]?.[0]
      if (
        price <= 0n ||
        qty <= 0n ||
        (prev !== undefined && (side === 'bid' ? price >= prev : price <= prev))
      )
        throw new Error('TRADING_BOOK_INVALID')
    }
  }
  if (book.bids[0]![0] >= book.asks[0]![0]) throw new Error('TRADING_BOOK_INVALID')
  if (ratioBps(book.asks[0]![0] - book.bids[0]![0], book.bids[0]![0]) > P.maxSpreadBps)
    throw new Error('TRADING_SPREAD_TOO_WIDE')
  const last = candles.at(-1)
  if (!last || now - last.at > 150_000 || last.at + 60_000 > now)
    throw new Error('TRADING_STALE_CANDLES')
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.close <= 0n || (i && candles[i]!.at - candles[i - 1]!.at !== 60_000))
      throw new Error('TRADING_CANDLES_INVALID')
  }
}

/** All decisions use closed candles and executable bid/ask prices, never the last trade. */
export function signal(agent: AgentRow, market: Market, forceExit = false) {
  const params = paramsSchema.parse(agent.params)
  const base = BigInt(agent.base)
  const basis = BigInt(agent.basis)
  const bid = market.book.bids[0]![0]
  const ask = market.book.asks[0]![0]
  const value = proceeds(base, bid)
  if (base >= market.instrument.minQty) {
    if (forceExit) return { side: 'sell' as const, reason: 'RISK_EXIT' }
    if (value * BPS <= basis * (BPS - BigInt(P.positionStopBps)))
      return { side: 'sell' as const, reason: 'POSITION_STOP' }
    const net = value - fee(value, P.maxFeeBps)
    if (net * BPS >= basis * (BPS + BigInt(params.takeProfitBps)))
      return { side: 'sell' as const, reason: 'TAKE_PROFIT' }
    return { side: null, reason: 'HOLDING_POSITION' }
  }
  if (forceExit) return { side: null, reason: 'ENTRIES_PAUSED' }
  const candles = market.candles.slice(-params.lookback)
  if (candles.length < params.lookback) return { side: null, reason: 'WARMING_UP' }
  const mean = candles.reduce((sum, c) => sum + c.close, 0n) / BigInt(candles.length)
  let enter = false
  if (agent.kind === 'reversion') enter = ask * BPS <= mean * (BPS - BigInt(params.entryBps))
  if (agent.kind === 'trend') {
    const fast = candles.slice(-10).reduce((sum, c) => sum + c.close, 0n) / 10n
    enter = fast * BPS >= mean * (BPS + BigInt(params.entryBps)) && ask >= fast
  }
  if (agent.kind === 'breakout') {
    const peak = candles.slice(0, -1).reduce((n, c) => (c.close > n ? c.close : n), 0n)
    enter = candles.at(-1)!.close * BPS >= peak * (BPS + BigInt(params.entryBps))
  }
  return enter
    ? { side: 'buy' as const, reason: 'STRATEGY_ENTRY' }
    : { side: null, reason: 'WAITING_SIGNAL' }
}

export function sizeOrder(
  agent: AgentRow,
  market: Market,
  side: 'buy' | 'sell',
  clientId: string,
): OrderRequest | null {
  const { tick, lot, minQty, symbol } = market.instrument
  // Round inward: the rounded limit never exceeds the configured slippage cap.
  const price =
    side === 'buy'
      ? floorStep((market.book.asks[0]![0] * (BPS + BigInt(P.slippageBps))) / BPS, tick)
      : (((market.book.bids[0]![0] * (BPS - BigInt(P.slippageBps))) / BPS + tick - 1n) / tick) *
        tick
  const budget = min(units(String(P.orderUsdt)), BigInt(agent.cash))
  const qty =
    side === 'buy'
      ? floorStep((((budget * BPS) / (BPS + BigInt(P.maxFeeBps))) * SCALE) / price, lot)
      : floorStep(BigInt(agent.base), lot)
  if (qty < minQty || (side === 'buy' && cost(qty, price) < units(String(P.minOrderUsdt))))
    return null
  return { clientId, symbol, side, qty, price }
}

export function eligible(agent: AgentRow, now = Date.now()) {
  return (
    now - new Date(agent.created_at).getTime() >= P.minEvaluationDays * 86_400_000 &&
    agent.round_trips >= P.minRoundTrips &&
    agent.max_drawdown_bps <= P.maxAgentDrawdownBps &&
    BigInt(agent.realized) > 0n
  )
}

export function fitness(agent: AgentRow) {
  return ratioBps(BigInt(agent.realized), BigInt(agent.initial_cash)) - agent.max_drawdown_bps
}

export function mutate(params: StrategyParams, generation: number): StrategyParams {
  return paramsSchema.parse({
    ...params,
    entryBps: Math.max(30, Math.min(300, params.entryBps + (generation % 2 ? 10 : -10))),
  })
}
