/**
 * Owner office API contracts (`/api/office/**`). Owner session required.
 * Real revenue and test payments are always separate fields.
 */

export type OfficeMode = 'running' | 'paused' | 'emergency_stop'
export type IdeaStatus = 'new' | 'accepted' | 'needs_human' | 'rejected' | 'productized'
export type CritiqueVerdict = 'PASS' | 'REVISE' | 'BLOCKED'
export type AgentMutation = { param: string; from: unknown; to: unknown }
export type ScoreComponent = 'P' | 'E' | 'U' | 'B' | 'C' | 'D' | 'H'
export type BudgetCategory =
  'research' | 'order' | 'scout' | 'lead' | 'report' | 'trading_manager' | 'computer_use'

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
    /** Number of confirmed test payments (sandbox or Sepolia). Never revenue. */
    testPayments: number
    /** Added by slice B: delivered orders, all time. */
    ordersDelivered?: number
    /** Added by slice B: sum of confirmed test payments in kopecks. Never revenue. */
    testPaymentsKopecks?: number
    /** Added by the UX pass: working scouts, for the menu counter. */
    activeAgents?: number
    /** Added by the UX pass: client requests not yet handled, for the menu counter. */
    newLeads?: number
  }
  worker: { alive: boolean; reason: string; nextAt: string | null }
  feed: { at: string; kind: string; text: string; link: string | null }[]
  needsOwner: { kind: string; text: string; link: string }[]
  /** Added by slice B: what the farm is doing right now, with progress; null when idle. */
  now?: { title: string; detail: string; step: number; steps: number } | null
}
export type OfficeIdea = {
  id: string
  title: string
  /** Russian industry name, e.g. "Общепит и доставка". */
  category: string
  /** Russian topic name, e.g. "Меню и описания блюд". */
  topic: string
  /** Added by slice B: taxonomy ids for filters (`?category=<categoryId>`). */
  categoryId?: string
  topicId?: string
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
  /** Added by the UX pass: the owner took this "needs a person" idea into work or finished it. */
  ownerStatus?: 'taken' | 'done' | null
  ownerTakenAt?: string | null
  /** The owner's own account after finishing; not revenue. */
  ownerOutcome?: 'worked' | 'failed' | null
  ownerOutcomeAt?: string | null
  /** Why the farm could not build a product from this idea (ideas.build_error), in words. */
  buildError?: string | null
  buildFailedAt?: string | null
  /** Added by the UX pass: the newest product built from this idea. */
  product?: {
    id: string
    name: string
    publicUrl: string
    visibility: 'private' | 'public'
    status: string
    /** A demo product on a stand with a real model: the storefront does not show it. */
    demoHidden?: boolean
  } | null
}
export type OfficeIdeaList = {
  items: OfficeIdea[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  /** Added by slice B: industries for the filter, from the server taxonomy. */
  categories?: { id: string; label: string }[]
  /** Added by the UX pass: counts for the filter chips (`?view=`), within the chosen industry. */
  counts?: {
    all: number
    farm: number
    human: number
    rejected: number
    taken: number
    /** Finished by the owner with an outcome. */
    done?: number
    /** Ideas per industry id, all industries. */
    byCategory: Record<string, number>
  }
}
export type OfficeAgent = {
  id: string
  /** "Разведчик А", copies "Разведчик А2". Computed on the server. */
  name: string
  /** Added by slice B: short label "А", "А2". */
  label?: string
  /** Added by slice B: industry labels of params.focusCategories. */
  focusLabels?: string[]
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
  score: {
    total: number
    components: Record<ScoreComponent, number | null>
    /**
     * Added by the UX pass: fewer ideas than the selection threshold. The score still counts in
     * selection (formula unchanged), but people see «Мало данных» instead of the number.
     */
    lowData?: boolean
  } | null
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
  /** `samples` (added by the UX pass): ideas the agent had at this round. */
  scores: { agentId: string; name: string; score: number; samples?: number }[]
  archived: string[]
  children: { id: string; parentId: string; mutation: AgentMutation }[]
}
export type OfficeAgents = {
  generation: number
  agents: OfficeAgent[]
  /** Added by the UX pass: all ideas and critic-accepted ideas over all generations. */
  totals?: { ideas: number; passed: number }
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
  /** Added by the UX pass: title of the idea the product grew from. */
  ideaTitle?: string | null
  isDemo: boolean
  /** A demo product on a stand with a real model: the storefront does not show it. */
  demoHidden?: boolean
  needsRefresh: boolean
  publicUrl: string
  stats: { orders: number; delivered: number; leads: number }
  /** Added by slice B: 'sandbox' (sellable) or 'archived'. */
  status?: string
}
export type OfficeOrderSummary = {
  id: string
  /** Added by the UX pass: short order number, «Заказ №1042». */
  number?: number
  status: string
  source: 'owner' | 'public'
  paymentMode: string
  isTestPayment: boolean
  priceKopecks: number
  revenueKopecks: number
  product: { name: string; slug: string; version: number }
  createdAt: string
  attention: boolean
  /** Added by slice B: agent of the order in office words, "Разведчик А2". */
  agentName?: string
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
/** Added by slice B: one page of a list endpoint. */
export type OfficeList<T> = {
  items: T[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}
/** `GET /api/office/orders?offset&attention`. */
export type OfficeOrderList = OfficeList<OfficeOrderSummary>
/** `GET /api/office/leads?stage&offset`. Stage changes: `POST /api/opportunities/[id]`. */
export type OfficeLeadList = OfficeList<OfficeLead>
/** `GET /api/office/products?offset`. */
export type OfficeProductList = OfficeList<OfficeProduct>
/** `GET /api/office/reports?offset`. */
export type OfficeReportList = OfficeList<OfficeReport>
/** Added by slice B: `GET /api/office/journal`, the technical log in plain words. */
export type OfficeJournal = {
  events: { id: string; at: string; kind: string; text: string }[]
  jobs: {
    id: string
    kind: string
    title: string
    status: 'queued' | 'running' | 'done' | 'failed'
    error: string | null
    attempts: number
    createdAt: string
    startedAt: string | null
    finishedAt: string | null
  }[]
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
  /** Added by slice B: the 28-day season is open. A new one: POST /api/control {action:'restart_research'}. */
  researchEnabled?: boolean
  /** Added by the UX pass: UTC hour (0-20) when the daily run may start. */
  scheduleHourUtc?: number
  /** Added by the UX pass: technical model id for support; `providers.model` is the human name. */
  modelId?: string | null
}
export type OfficeSettingsUpdate = Partial<
  Pick<
    OfficeSettings,
    | 'evolutionEnabled'
    | 'evolutionMinIdeas'
    | 'evolutionRoundsPerDay'
    | 'scoutsPerStrategyPerDay'
    | 'leadsPerDay'
    | 'scheduleHourUtc'
  >
>

/** Added by slice B: answers of owner actions that queue work. */
export type OfficeQueued = { id: string; status: string; reused: boolean }
export type OfficeScoutRequest = { topicId?: string }
export type OfficeScoutQueued = { jobs: { id: string; status: string }[]; reused: boolean }
/** Added by the UX pass: `POST /api/office/leads/search` answers like the scout button. */
export type OfficeLeadSearchQueued = OfficeScoutQueued
export type OfficeIdeaUpdate = {
  ownerNote?: string
  status?: 'needs_human' | 'rejected'
  /** Added by the UX pass: take one "needs a person" idea into work, finish it, or let it go. */
  ownerStatus?: 'taken' | 'done' | null
  /** Required with `done`. */
  ownerOutcome?: 'worked' | 'failed'
}
export type OfficeVisibilityUpdate = { visibility: 'private' | 'public' }
