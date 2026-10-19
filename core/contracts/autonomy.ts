/** Server autopilot and worker loop status, shared by the office API and `autopilot:check`. */
export type AutopilotAction =
  | 'enable_schedule'
  | 'enable_manager'
  | 'start_trading'
  | 'configure_execution'
  | 'start_execution'
  | 'none'

export interface AutopilotDecision {
  /** Stable item id, e.g. `trading:bybit:demo`, `execution:funding:paper`, `manager`. */
  key: string
  action: AutopilotAction
  /** running: already works; started: the autopilot turned it on; blocked: waits for something. */
  status: 'running' | 'started' | 'blocked' | 'failed'
  /** Plain Russian for the owner: what happens and what is missing. */
  text: string
  /** Error code of a failed action, if any. */
  code?: string
}

export interface WorkerLoopView {
  name: string
  label: string
  state: 'ok' | 'failing' | 'stale' | 'stuck' | 'never'
  lastOkAt: string | null
  lastErrorAt: string | null
  error: string
  consecutiveFailures: number
}

export interface PacingView {
  enabled: boolean
  dailyKopecks: number
  daySpentKopecks: number
  outstandingKopecks: number
  /** Hourly share of the remaining day for scouts; other farm work gets less. */
  hourlyAllowanceKopecks: number
  usedThisHourKopecks: number
  managerFloorKopecks: number
}

export interface AutonomyView {
  autopilotEnabled: boolean
  intervalMinutes: number
  checkedAt: string | null
  decisions: AutopilotDecision[]
  loops: WorkerLoopView[]
  pacing: PacingView
}
