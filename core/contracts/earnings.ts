import type { OpportunityResearch } from '../opportunities/types'
import type { ArbitrageReport } from '../earnings/arbitrage'

export interface EarningsView {
  monitor: {
    enabled: boolean
    pending: boolean
    running: boolean
    workerAlive: boolean
    attemptedAt: string | null
    finishedAt: string | null
    nextAt: string | null
    error: string
    intervalMinutes: number
    /** Cross-exchange quote refresh alone (still observation-only). */
    arbitrageIntervalMinutes: number
  }
  report: OpportunityResearch | null
  arbitrage: ArbitrageReport | null
}
