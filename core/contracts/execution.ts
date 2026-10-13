import type {
  ExecutionMode,
  ExecutionSettings,
  ExecutionStatus,
  ExecutionTrack,
} from '../execution/types'

export interface ExecutionView {
  track: ExecutionTrack
  mode: ExecutionMode
  status: ExecutionStatus
  currency: 'USDT' | 'USDC' | 'USD'
  capital: string
  available: string
  equity: string
  realized: string
  fees: string
  networkFees: { asset: string; amount: string }[]
  settings: ExecutionSettings
  activated: boolean
  reason: string
  readiness: string
  workerAlive: boolean
  heartbeat: string | null
  closeRequested: boolean
  operations: {
    id: string
    status: string
    symbol: string
    quantity: string
    pnl: string
    fees: string
    createdAt: string
    closedAt: string | null
  }[]
  legs: {
    id: string
    operationId: string
    venue: string
    action: string
    symbol: string
    state: string
    quantity: string
    filled: string
    price: string
    quote: string
    fee: string
    externalId: string | null
    at: string
  }[]
  events: { id: string; code: string; at: string }[]
}
