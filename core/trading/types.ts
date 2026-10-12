export const exchanges = ['okx', 'bybit', 'binance', 'bitget'] as const
export type TradingExchange = (typeof exchanges)[number]
export type TradingScope = { exchange: TradingExchange; mode: TradingMode }
export type TradingMode = 'paper' | 'demo' | 'live'
export type TradingSymbol = 'BTC-USDT' | 'ETH-USDT'
export type Side = 'buy' | 'sell'
export type StrategyKind = 'reversion' | 'trend' | 'breakout'
export type StrategyParams = { lookback: number; entryBps: number; takeProfitBps: number }
export type Instrument = {
  symbol: TradingSymbol
  lot: bigint
  minQty: bigint
  tick: bigint
  minNotional?: bigint
}
export type Book = {
  symbol: TradingSymbol
  at: number
  bids: [bigint, bigint][]
  asks: [bigint, bigint][]
}
export type Candle = { at: number; close: bigint }
export type Market = { instrument: Instrument; book: Book; candles: Candle[] }
export type Balances = Record<'USDT' | 'BTC' | 'ETH', { total: bigint; available: bigint }>
export type Account = {
  identity: string
  balances: Balances
  feeBps: Record<TradingSymbol, number>
}
export type OrderRequest = {
  clientId: string
  symbol: TradingSymbol
  side: Side
  qty: bigint
  price: bigint
}
export type OrderResult = OrderRequest & {
  exchangeId: string
  state: 'live' | 'partially_filled' | 'filled' | 'canceled'
  filledQty: bigint
  quote: bigint
  baseFee: bigint
  quoteFee: bigint
}
export interface TradingVenue {
  market(symbol: TradingSymbol): Promise<Market>
  account(): Promise<Account>
  pending(): Promise<{ clientId: string }[]>
  place(order: OrderRequest): Promise<void>
  order(order: OrderRequest): Promise<OrderResult | null>
  cancel(order: OrderRequest): Promise<void>
}

export type PortfolioRow = {
  exchange: TradingExchange
  mode: TradingMode
  status: 'idle' | 'running' | 'paused' | 'stopped'
  reason: string
  capital: string
  peak: string
  day_equity: string
  risk_day: string
  account_identity: string | null
  quote_offset: string
  checked_at: Date | null
  check_error: string
  heartbeat: Date | null
  last_tick: Date | null
  started_at: Date | null
  demo_probe: boolean
  generation: number
  evolution_at: Date | null
  evolution_reason: string
}
export type AgentRow = {
  exchange: TradingExchange
  id: string
  mode: TradingMode
  name: string
  symbol: TradingSymbol
  kind: StrategyKind
  params: StrategyParams
  status: 'active' | 'archived'
  parent_id: string | null
  generation: number
  initial_cash: string
  cash: string
  base: string
  basis: string
  realized: string
  fees: string
  peak: string
  max_drawdown_bps: number
  round_trips: number
  last_order_at: Date | null
  created_at: Date
  last_signal: string
}
export type OrderRow = {
  exchange: TradingExchange
  id: string
  mode: TradingMode
  agent_id: string
  client_id: string
  symbol: TradingSymbol
  side: Side
  qty: string
  price: string
  status: 'prepared' | 'submitted' | 'unknown' | 'filled' | 'canceled' | 'rejected'
  reason: string
  exchange_id: string | null
  filled_qty: string
  quote: string
  base_fee: string
  quote_fee: string
  created_at: Date
}
