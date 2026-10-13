import type { StrategyKind, StrategyParams, TradingExchange } from '../trading/types'

export type ManagerTaskStatus = 'queued' | 'observing' | 'completed' | 'rejected' | 'expired'
export interface ManagerOutcome {
  verdict: 'positive' | 'negative' | 'insufficient' | 'interrupted'
  pnlUsdt: string | null
  feesUsdt: string
  roundTrips: number
  drawdownBps: number
  evaluatedAt: string
}
export interface ManagerTaskView {
  id: string
  demo: boolean
  exchange: TradingExchange
  status: ManagerTaskStatus
  reason: string
  hypothesis: string
  rationale: string
  kind: StrategyKind
  params: StrategyParams
  sourceAgentId: string
  agentId: string | null
  createdAt: string
  appliedAt: string | null
  evaluateAt: string | null
  expiresAt: string
  outcome: ManagerOutcome | null
}
export interface ManagerView {
  state: {
    enabled: boolean
    thinking: boolean
    requested: boolean
    workerAlive: boolean
    nextReviewAt: string | null
    blocked: string[]
    lastError: string
    intervalHours: number
    manualCooldownMinutes: number
    minEvaluationHours: number
    minRoundTrips: number
    maxObservationDays: number
    maxDailyRuns: number
    runsToday: number
    provider: string
    model: string
    demo: boolean
    spentKopecks: number
    reservedKopecks: number
    dailyLimitKopecks: number
  }
  runs: {
    id: string
    status: 'running' | 'completed' | 'failed' | 'discarded'
    summary: string
    error: string
    createdAt: string
    finishedAt: string | null
    demo: boolean
    costKopecks: number
  }[]
  tasks: ManagerTaskView[]
}
