/** Server-owned execution plans. Never passed to a model or accepted directly from the browser. */
export const executionTracks = ['arbitrage', 'funding', 'defi', 'prediction'] as const
export type ExecutionTrack = (typeof executionTracks)[number]
export type ExecutionMode = 'paper' | 'demo' | 'live'
export type ExecutionVenue =
  'okx' | 'bybit' | 'binance' | 'bitget' | 'bybit-funding' | 'aave' | 'kalshi'
export type ExecutionAction =
  'buy' | 'sell' | 'short' | 'cover' | 'approve' | 'revoke' | 'supply' | 'withdraw'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** All decimal strings are exact values, compatible with trading/decimal (18 places). */
export interface ExecutionIntent {
  clientId: string
  venue: ExecutionVenue
  action: ExecutionAction
  symbol: string
  quantity: string
  limitPrice: string
  quoteBudget: string
  positionQuantity: string
  outcome?: 'yes' | 'no'
  expiresAt: number
}

/** Persist before broadcast. Payload may contain a signed transaction; never expose it in a DTO. */
export interface PreparedExecution {
  intent: ExecutionIntent
  payload: { [key: string]: Json }
  externalId: string | null
}

/** Cumulative confirmed effects, not the acknowledgement of an asynchronous submit. */
export interface ExecutionReceipt {
  status: 'pending' | 'filled' | 'cancelled' | 'rejected' | 'unknown'
  externalId: string | null
  filledQuantity: string
  grossQuote: string
  quoteFee: string
  baseFee: string
  networkFee?: { asset: string; amount: string }
}

export interface ExecutionAdapter {
  prepare(intent: ExecutionIntent): Promise<PreparedExecution>
  broadcast(prepared: PreparedExecution): Promise<void>
  lookup(prepared: PreparedExecution): Promise<ExecutionReceipt | null>
  cancel?(prepared: PreparedExecution): Promise<void>
}

/** Only use when no order/transaction was accepted. Any other submit error is indeterminate. */
export class ExecutionRejected extends Error {
  constructor(code: string) {
    super(code)
    this.name = 'ExecutionRejected'
  }
}

export type ExecutionStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'attention'
export interface ExecutionSettings {
  buyExchange: 'okx' | 'bybit' | 'binance' | 'bitget'
  sellExchange: 'okx' | 'bybit' | 'binance' | 'bitget'
  symbols: string[]
  minEdgeBps: number
  minFundingBps: number
  maxHoldHours: number
  predictionTicker: string
  probabilityBps: number
  outcome: 'yes' | 'no'
}

export interface ExecutionPortfolio {
  track: ExecutionTrack
  mode: ExecutionMode
  status: ExecutionStatus
  capital: string
  cash: string
  equity: string
  realized: string
  fees: string
  peak: string
  day_equity: string
  risk_day: string
  settings: ExecutionSettings
  reason: string
  heartbeat: Date | null
  last_scan: Date | null
  started_at: Date | null
  close_requested: boolean
}

export interface ExecutionOperation {
  id: string
  track: ExecutionTrack
  mode: ExecutionMode
  status: 'opening' | 'open' | 'closing' | 'closed' | 'attention'
  reserve: string
  plan: ExecutionPlan
  pnl: string
  fees: string
  created_at: Date
  closed_at: Date | null
}
export interface ExecutionPlan {
  /** Engine-owned settings hash. Legacy operations and unaccepted driver proposals omit it. */
  configuration?: string
  symbol: string
  quantity: string
  entryPrice: string
  hedgePrice: string
  buyVenue: ExecutionVenue
  sellVenue: ExecutionVenue
  outcome: 'yes' | 'no'
  rate: string
  nextPaymentAt: number
  intervalMs: number
}
export interface ExecutionLeg {
  id: string
  operation_id: string
  sequence: number
  role: string
  state: 'prepared' | 'submitted' | 'terminal' | 'unknown'
  prepared: PreparedExecution
  receipt: ExecutionReceipt | null
  created_at: Date
}
export interface ExecutionFlow {
  externalId: string
  kind: 'funding' | 'settlement'
  amount: string
  at: number
}
export type ExecutionDecision =
  | { type: 'leg'; role: string; intent: ExecutionIntent }
  | { type: 'hold'; pnl: string; fees: string; flows?: ExecutionFlow[] }
  | { type: 'close'; pnl: string; fees: string; flows?: ExecutionFlow[] }
  | { type: 'attention'; reason: string }

export interface ExecutionDriver {
  /** Account validation and account identities. Never starts or changes an account. */
  accounts(
    p: ExecutionPortfolio,
  ): Promise<{ identity: string; venue: ExecutionVenue; snapshot?: Json }[]>
  /** Current total equity, including prefunded inventory, when account marks are required. */
  equity?(p: ExecutionPortfolio): Promise<string>
  plan(p: ExecutionPortfolio): Promise<{ plan: ExecutionPlan; reserve: string } | null>
  decide(
    p: ExecutionPortfolio,
    op: ExecutionOperation,
    legs: ExecutionLeg[],
  ): Promise<ExecutionDecision>
  adapter(venue: ExecutionVenue): ExecutionAdapter
}
