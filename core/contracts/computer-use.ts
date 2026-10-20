import type {
  DocumentKind,
  OpportunityDecision,
  OpportunityKind,
  ToolCall,
} from '../computer-use/schema'

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
  /** Self-assessment; `skip` is forced by the server when the job forbids AI. */
  decision: OpportunityDecision
  fit: number
  aiForbidden: boolean
  /** Integer minor units of `estimatedCurrency`, or null. */
  estimatedValueMinor: number | null
  estimatedCurrency: string | null
  reason: string
  platformDomain: string
}
export interface ComputerProposalView {
  id: string
  taskId: string
  platformDomain: string
  opportunityUrl: string
  opportunityTitle: string
  text: string
  priceAmount: number | null
  priceCurrency: string | null
  status: 'draft' | 'sent' | 'failed' | 'expired'
  demo: boolean
  sentUrl: string
  createdAt: string
  sentAt: string | null
}
export interface ComputerDocumentView {
  id: string
  taskId: string
  title: string
  brief: string
  kind: DocumentKind
  text: string
  demo: boolean
  createdAt: string
}
export interface ComputerPlatformView {
  domain: string
  loggedIn: boolean
  proposalsToday: number
  sentToday: number
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
    /** Autonomous sending on logged-in platforms: the office switch and the env gate. */
    autoProposals: boolean
    autoProposalsAllowed: boolean
    proposalsPerDay: number
    /** The owner's remote-control lease, if active. */
    manualUntil: string | null
  }
  current: ComputerTaskView | null
  approvals: ComputerApprovalView[]
  history: ComputerTaskView[]
  opportunities: ComputerOpportunityView[]
  proposals: ComputerProposalView[]
  documents: ComputerDocumentView[]
  platforms: ComputerPlatformView[]
}
