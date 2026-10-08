/**
 * Owner office API contracts (`/api/office/**`). Owner session required.
 * Real revenue and test payments are always separate fields.
 */

export type OfficeMode = 'running' | 'paused' | 'emergency_stop'
export type IdeaStatus = 'new' | 'accepted' | 'needs_human' | 'rejected' | 'productized'
export type CritiqueVerdict = 'PASS' | 'REVISE' | 'BLOCKED'
export type AgentMutation = { param: string; from: unknown; to: unknown }
export type ScoreComponent = 'P' | 'E' | 'U' | 'B' | 'C' | 'D'
export type BudgetCategory = 'research' | 'order' | 'scout' | 'lead' | 'report'

export type OfficeOverview = {
  mode: OfficeMode
  generation: number
  today: {
    ideas: number
    ideasAccepted: number
    productsPublished: number
    ordersDelivered: number
    leadsFound: number
    spentKopecks: number
  }
  totals: {
    ideas: number
    products: number
    publicProducts: number
    orders: number
    realRevenueKopecks: number
    testPayments: number
  }
  worker: { alive: boolean; reason: string; nextAt: string | null }
  feed: { at: string; kind: string; text: string; link: string | null }[]
  needsOwner: { kind: string; text: string; link: string }[]
}
export type OfficeIdea = {
  id: string
  title: string
  category: string
  topic: string
  status: IdeaStatus
  rankScore: number
  farmExecutable: boolean
  suggestedTemplate: string | null
  agent: { id: string; name: string }
  createdAt: string
  isDemo: boolean
  duplicateOf: string | null
  research: {
    audience: string
    problem: string
    demandSignals: { claim: string; url: string }[]
    competitors: string[]
    revenueModel: string
    revenueNote: string
    startupCostRub: number
    monthlyCostRub: number
    risks: string[]
    quickTest: string
    executionNote: string
    launchPlanForHuman: string[]
    uncertainties: string[]
  }
  critique: { verdict: CritiqueVerdict; reason: string }
  checks: {
    hypothesisId: string
    status: string
    productId: string | null
    version: number | null
    critique: string
  }[]
  ownerNote: string
}
export type OfficeIdeaList = {
  items: OfficeIdea[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}
export type OfficeAgent = {
  id: string
  name: string
  status: 'active' | 'archived'
  generation: number
  parentId: string | null
  params: {
    focusCategories: string[]
    evidenceMinimum: 2 | 3
    tone: string
    ideaScope: string
    riskAppetite: string
  }
  mutation: AgentMutation | null
  metrics: {
    ideas: number
    passed: number
    duplicates: number
    builtPassed: number
    delivered: number
    review: number
    costKopecks: number
  }
  score: { total: number; components: Record<ScoreComponent, number | null> } | null
  retired: { at: string; reason: string; roundId: string } | null
}
export type EvolutionStatus = {
  enabled: boolean
  minIdeas: number
  roundsPerDay: number
  roundsToday: number
  ready: boolean
  reason: string
  missing: { agentId: string; need: number }[]
  financial: { decision: 'HOLD' | 'CLOSED'; reason: string; at: string } | null
}
export type EvolutionRound = {
  id: string
  generation: number
  decision: 'HOLD' | 'ROTATED'
  reason: string
  trigger: string
  isDemo: boolean
  at: string
  scores: { agentId: string; name: string; score: number }[]
  archived: string[]
  children: { id: string; parentId: string; mutation: AgentMutation }[]
}
export type OfficeAgents = {
  generation: number
  agents: OfficeAgent[]
  evolution: EvolutionStatus
  rounds: EvolutionRound[]
}
export type OfficeProduct = {
  id: string
  slug: string
  name: string
  template: string
  version: number
  visibility: 'private' | 'public'
  publishedAt: string | null
  priceKopecks: number
  ideaId: string | null
  isDemo: boolean
  needsRefresh: boolean
  publicUrl: string
  stats: { orders: number; delivered: number; leads: number }
}
export type OfficeOrderSummary = {
  id: string
  status: string
  source: 'owner' | 'public'
  paymentMode: string
  isTestPayment: boolean
  priceKopecks: number
  revenueKopecks: number
  product: { name: string; slug: string; version: number }
  createdAt: string
  attention: boolean
}
export type OfficeLead = {
  id: string
  product: { id: string; name: string; slug: string } | null
  template: string
  url: string
  title: string
  snippet: string
  stage: string
  note: string
  replyDraft: string | null
  replyDraftedAt: string | null
  replyError: string | null
  isDemo: boolean
  firstSeenAt: string
  lastSeenAt: string
}
export type OfficeMoney = {
  daySpentKopecks: number
  monthSpentKopecks: number
  outstandingKopecks: number
  limits: { dailyKopecks: number; monthlyKopecks: number }
  byCategory: Record<BudgetCategory, number>
  testPayments: { count: number; kopecks: number }
  realRevenueKopecks: number
  openai: { spentMicrousd: number; limitMicrousd: number } | null
}
export type OfficeReport = {
  id: string
  kind: 'daily' | 'weekly'
  periodStart: string
  periodEnd: string
  generation: number
  metrics: Record<string, number>
  ranking: { ideaId: string; title: string; rankScore: number; status: string }[]
  narrative: {
    headline: string
    summary: string
    ideaComments: { ideaId: string; comment: string }[]
    nextActions: string[]
    needsOwner: string[]
  } | null
  isDemo: boolean
  createdAt: string
}
export type OfficeSettings = {
  mode: string
  scheduleEnabled: boolean
  researchScope: 'rotate' | 'all'
  evolutionEnabled: boolean
  evolutionMinIdeas: number
  evolutionRoundsPerDay: number
  scoutsPerStrategyPerDay: number
  leadsPerDay: number
  providers: { model: string; search: string; payment: string }
  limits: { dailyKopecks: number; monthlyKopecks: number }
}
export type OfficeSettingsUpdate = Partial<
  Pick<
    OfficeSettings,
    | 'evolutionEnabled'
    | 'evolutionMinIdeas'
    | 'evolutionRoundsPerDay'
    | 'scoutsPerStrategyPerDay'
    | 'leadsPerDay'
  >
>
