import type {
  TradingExchange,
  TradingMode,
  TradingSymbol,
  StrategyKind,
  StrategyParams,
  StrategyPreset,
} from '../trading/types'
import type { ScoutCoin } from '../trading/universe'

export type TradingMarketView = {
  exchange: TradingExchange
  mode: TradingMode
  scannedAt: string | null
  attemptedAt: string | null
  fresh: boolean
  error: string
  total: number
  ready: number
  screened: number
  matches: number
  page: number
  pageSize: number
  coins: ScoutCoin[]
  active: { name: string; symbol: string; holding: boolean; since: string }[]
  assignments: {
    id: string
    name: string
    symbol: string
    previous: string | null
    reason: string
    at: string
  }[]
  limits: {
    scanMinutes: number
    idleHours: number
    holdHours: number
    bookDepthUsdt: number
    dailyTurnover: number
    maxSpreadBps: number
    candidates: number
  }
}

export type TradingView = {
  exchange: TradingExchange
  liveConfirmation: string
  allocationEditable: boolean
  mode: TradingMode
  status: 'idle' | 'running' | 'paused' | 'stopped'
  reason: string
  checkError: string
  checkedAt: string | null
  heartbeat: string | null
  workerAlive: boolean
  generation: number
  evolutionReason: string
  strategyPreset: { selected: StrategyPreset; pending: boolean; paperOnlyKinds: StrategyKind[] }
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
    allocated: boolean
    keys: boolean
    liveEnabled: boolean
    paperQualified: boolean
    paperOnlyCandidate: boolean
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

export type TradingOverview = {
  mode: TradingMode
  minimumAllocation: number
  allocated: string
  equity: string
  pnl: string
  connections: {
    exchange: TradingExchange
    status: TradingView['status']
    keys: boolean
    error: string
    workerAlive: boolean
    fresh: boolean
    capital: string
    equity: string
    pnl: string
    activeAgents: number
    allocationEditable: boolean
    liveAllocation: string
  }[]
}
