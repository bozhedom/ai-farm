import type { TradingMode, TradingSymbol, StrategyKind, StrategyParams } from '../trading/types'

export type TradingView = {
  mode: TradingMode
  status: 'idle' | 'running' | 'paused' | 'stopped'
  reason: string
  checkError: string
  checkedAt: string | null
  heartbeat: string | null
  workerAlive: boolean
  generation: number
  evolutionReason: string
  metrics: {
    capital: string
    equity: string
    cash: string
    exposure: string
    pnl: string
    realized: string
    fees: string
    drawdownBps: number
    dailyLossBps: number
    roundTrips: number
  }
  limits: {
    orderUsdt: number
    exposureBps: number
    dailyLossBps: number
    drawdownBps: number
    positionStopBps: number
    maxOrdersPerDay: number
    evaluationDays: number
    evaluationTrips: number
  }
  readiness: {
    keys: boolean
    liveEnabled: boolean
    paperQualified: boolean
    demoVerified: boolean
    connection: boolean
  }
  markets: { symbol: TradingSymbol; bid: string; ask: string; at: string }[]
  agents: {
    id: string
    name: string
    symbol: TradingSymbol
    kind: StrategyKind
    params: StrategyParams
    status: string
    parentId: string | null
    generation: number
    cash: string
    base: string
    equity: string
    pnl: string
    realized: string
    fees: string
    drawdownBps: number
    roundTrips: number
    signal: string
    eligible: boolean
    createdAt: string
  }[]
  orders: {
    id: string
    clientId: string
    agentName: string
    symbol: TradingSymbol
    side: string
    status: string
    qty: string
    price: string
    filledQty: string
    quote: string
    feeBase: string
    feeQuote: string
    reason: string
    createdAt: string
  }[]
  events: { id: string; kind: string; reason: string; at: string }[]
  equity: { at: string; value: string }[]
  unresolvedClientId: string | null
}
