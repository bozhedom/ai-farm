/**
 * `GET /api/office/income`: how the farm earns, in one owner-only snapshot.
 *
 * Money rules: rubles are integer kopecks; trading and execution results are exact decimal
 * strings in their own currency (USDT, USDC, USD). Currencies are never converted or added
 * together. Only `live` results and real paid orders are real money; paper, demo and test
 * payments are always reported in separate, labelled fields and never count as revenue.
 */
import type { OfficeMode, OfficeOverview } from './office'

export type IncomePeriod = 'today' | 'week' | 'month'
export type IncomeMode = 'paper' | 'demo' | 'live'
export type IncomeExchange = 'okx' | 'bybit' | 'binance' | 'bitget'
export type IncomeCurrency = 'USDT' | 'USDC' | 'USD'

/** autonomous: works by itself; needs_human: blocked on the owner; paper_only: by policy never real money. */
export type IncomeSourceStatus = 'autonomous' | 'needs_human' | 'paper_only' | 'disabled'

export type IncomeAmount = { currency: IncomeCurrency; amount: string }

export type IncomeTotals = {
  /** Real money: paid non-test orders, kopecks. */
  realOrdersKopecks: number
  /** Real money: live spot trading, realized after fees (USDT). */
  liveTradingUsdt: string
  /** Real money: live execution tracks, realized, per currency. */
  liveExecution: IncomeAmount[]
  /** Not revenue: confirmed sandbox / Sepolia payments, kopecks. */
  testPaymentsKopecks: number
  /** Not revenue: paper and demo trading, realized (USDT). */
  paperTradingUsdt: string
  demoTradingUsdt: string
  /** Not revenue: paper and demo execution tracks, realized, per currency. */
  testExecution: IncomeAmount[]
  /** Model and search spend (OpenRouter, Astra, others) from the call ledger, kopecks. */
  spendKopecks: number
  /** realOrdersKopecks - spendKopecks. Trading currencies are shown next to it, not added. */
  netKopecks: number
}

export type IncomeSource = {
  id: string
  group:
    'trading' | 'bots' | 'manager' | 'execution' | 'services' | 'scouts' | 'markets' | 'computer'
  title: string
  status: IncomeSourceStatus
  /** test: sandbox / Sepolia payments. null: the direction has no money mode. */
  mode: IncomeMode | 'test' | null
  /** Result in the source's own unit. `test` is true for anything that is not real money. */
  result: {
    unit: 'USDT' | 'USDC' | 'USD' | 'RUB' | 'count'
    /** Decimal string for currencies, kopecks for RUB, an integer for count. */
    value: string
    label: string
    test: boolean
  } | null
  detail: string
  lastAt: string | null
  link: string
}

export type IncomeTradingRow = {
  exchange: IncomeExchange
  mode: IncomeMode
  status: 'idle' | 'running' | 'paused' | 'stopped'
  keys: boolean
  workerAlive: boolean
  capital: string
  equity: string
  /** Equity minus capital since activation, including open positions. */
  pnl: string
  /** Realized after fees, all time. */
  realized: string
  activeAgents: number
  /** Filled sells over 30 days, with their realized result reconstructed from fills. */
  trades30d: number
  wins30d: number
  lastAt: string | null
}

export type IncomeAgentRank = {
  id: string
  name: string
  exchange: IncomeExchange
  mode: IncomeMode
  kind: string
  symbol: string
  realized: string
  roundTrips: number
  status: 'active' | 'archived'
}

export type IncomeNeed = {
  id: string
  title: string
  /** Short instruction for the owner. */
  detail: string
  link: string
  severity: 'block' | 'warn'
}

export type OfficeIncome = {
  generatedAt: string
  mode: OfficeMode
  workerAlive: boolean
  periods: Record<IncomePeriod, IncomeTotals>
  allTime: IncomeTotals
  sources: IncomeSource[]
  trading: IncomeTradingRow[]
  /** End-of-day equity per exchange and mode for the last 30 UTC days; only series with data. */
  equity: {
    exchange: IncomeExchange
    mode: IncomeMode
    points: { day: string; equity: string }[]
  }[]
  /** 30 UTC days, oldest first. */
  daily: { day: string; realKopecks: number; testKopecks: number; spendKopecks: number }[]
  spendByCategory: { category: string; kopecks: number }[]
  agents: { best: IncomeAgentRank[]; worst: IncomeAgentRank[] }
  funnel: {
    ideas: number
    accepted: number
    productized: number
    publicProducts: number
    orders: number
    delivered: number
    paidReal: number
  }
  products: {
    id: string
    name: string
    priceKopecks: number
    orders: number
    delivered: number
    publicUrl: string
  }[]
  /** Allowed storefront prices, kopecks (core/storefront.ts priceList). */
  priceList: number[]
  /** Active trading strategies currently admitted, by exchange, mode and kind. */
  strategies: { exchange: IncomeExchange; mode: IncomeMode; kind: string; count: number }[]
  feed: OfficeOverview['feed']
  needsHuman: IncomeNeed[]
}
