import type { OpportunityKind, ToolCall } from '../computer-use/schema'

export type ComputerTaskStatus =
  'queued' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled'
export type ComputerStepDecision =
  'allowed' | 'approval' | 'approved' | 'rejected' | 'blocked' | 'invalid' | 'failed'

export interface ComputerStepView {
  id: string
  stepNo: number
  action: ToolCall | { name: string }
  decision: ComputerStepDecision
  reason: string
  reasoning: string
  urlBefore: string
  urlAfter: string
  title: string
  hasScreenshot: boolean
  createdAt: string
}
export interface ComputerTaskView {
  id: string
  goal: string
  source: 'owner' | 'rotation'
  status: ComputerTaskStatus
  stepCount: number
  stepLimit: number
  costCapMicrousd: number
  spentMicrousd: number
  spentKopecks: number
  demo: boolean
  provider: string
  model: string
  report: string
  error: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Newest first; only the current task carries steps. */
  steps: ComputerStepView[]
  latestScreenshotStepId: string | null
}
export interface ComputerApprovalView {
  id: string
  taskId: string
  goal: string
  stepNo: number
  action: ToolCall
  reason: string
  createdAt: string
}
export interface ComputerOpportunityView {
  id: string
  taskId: string
  title: string
  url: string
  summary: string
  kind: OpportunityKind
  requiresHuman: boolean
  demo: boolean
  status: 'new' | 'saved' | 'dismissed'
  createdAt: string
}
export interface ComputerUseView {
  state: {
    enabled: boolean
    running: boolean
    workerAlive: boolean
    /** Reasons nothing starts right now, as server codes. */
    blocked: string[]
    lastError: string
    provider: string
    model: string
    demo: boolean
    stepLimit: number
    taskCapMicrousd: number
    dailyCapMicrousd: number
    spentTodayMicrousd: number
    spentTodayKopecks: number
    queuedOwnerGoals: number
    failures: number
    rotationGoals: number
  }
  current: ComputerTaskView | null
  approvals: ComputerApprovalView[]
  history: ComputerTaskView[]
  opportunities: ComputerOpportunityView[]
}
