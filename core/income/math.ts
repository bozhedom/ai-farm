/**
 * Pure aggregation rules for the income overview. Integer kopecks and 18-decimal bigint units only;
 * no floating point and no currency conversion.
 */
import type {
  IncomeAmount,
  IncomeCurrency,
  IncomeMode,
  IncomePeriod,
  IncomeSourceStatus,
  IncomeTotals,
} from '../contracts/overview'
import { decimal } from '../trading/decimal'

export const DAYS = 30
export const periodDays: Record<IncomePeriod, number> = { today: 1, week: 7, month: DAYS }

/** UTC day key, `2026-10-20`. */
export const dayKey = (at: Date) => at.toISOString().slice(0, 10)

/** The last `days` UTC days ending with today, oldest first. */
export function dayKeys(now: Date, days = DAYS) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  )
}

/** First day key of a period: today, the last 7 days or the last 30 days, all including today. */
export function periodStart(now: Date, period: IncomePeriod) {
  return dayKeys(now, periodDays[period])[0]!
}

export type Fill = {
  agentId: string
  exchange: string
  mode: IncomeMode
  side: 'buy' | 'sell'
  filledQty: bigint
  quote: bigint
  baseFee: bigint
  quoteFee: bigint
  at: Date
}
export type ClosedTrade = {
  agentId: string
  exchange: string
  mode: IncomeMode
  at: Date
  /** null when the history is inconsistent (the sell exceeds the replayed position). */
  realized: bigint | null
}

/**
 * Replays fills per agent with the same rules as `applyFill` in core/trading/accounting.ts and
 * returns the realized result of every filled sell. Fills must be ordered by agent, then time.
 * Every agent starts flat (base 0), which is how every trading agent is created.
 */
export function replayTrades(fills: Fill[]): ClosedTrade[] {
  const state = new Map<string, { base: bigint; basis: bigint; broken: boolean }>()
  const trades: ClosedTrade[] = []
  for (const f of fills) {
    if (f.filledQty <= 0n) continue
    const s = state.get(f.agentId) ?? { base: 0n, basis: 0n, broken: false }
    state.set(f.agentId, s)
    if (f.side === 'buy') {
      s.base += f.filledQty + f.baseFee
      s.basis += f.quote - f.quoteFee
      continue
    }
    const removed = f.filledQty - f.baseFee
    let realized: bigint | null = null
    if (!s.broken && removed > 0n && removed <= s.base && s.base > 0n) {
      const released = removed === s.base ? s.basis : (s.basis * removed) / s.base
      realized = f.quote + f.quoteFee - released
      s.base -= removed
      s.basis -= released
    } else {
      // Unknown position: stop attributing results for this agent rather than guess.
      s.broken = true
    }
    trades.push({ agentId: f.agentId, exchange: f.exchange, mode: f.mode, at: f.at, realized })
  }
  return trades
}

export function winStats(trades: ClosedTrade[]) {
  let wins = 0
  for (const t of trades) if (t.realized !== null && t.realized > 0n) wins += 1
  return { trades: trades.length, wins }
}

/** Day-bucketed amounts: kopecks as numbers, currencies as bigint units. */
export type DayBucket = {
  realKopecks: number
  testKopecks: number
  spendKopecks: number
  trading: Record<IncomeMode, bigint>
  execution: Record<IncomeMode, Partial<Record<IncomeCurrency, bigint>>>
}

export const emptyBucket = (): DayBucket => ({
  realKopecks: 0,
  testKopecks: 0,
  spendKopecks: 0,
  trading: { paper: 0n, demo: 0n, live: 0n },
  execution: { paper: {}, demo: {}, live: {} },
})

export function addExecution(
  bucket: DayBucket,
  mode: IncomeMode,
  currency: IncomeCurrency,
  value: bigint,
) {
  bucket.execution[mode][currency] = (bucket.execution[mode][currency] ?? 0n) + value
}

const currencies: IncomeCurrency[] = ['USDT', 'USDC', 'USD']
function amounts(values: Partial<Record<IncomeCurrency, bigint>>[]): IncomeAmount[] {
  return currencies.flatMap((currency) => {
    let sum = 0n,
      seen = false
    for (const v of values)
      if (v[currency] !== undefined) {
        seen = true
        sum += v[currency]!
      }
    return seen ? [{ currency, amount: decimal(sum) }] : []
  })
}

/** Sums buckets into totals. Real and test money stay in separate fields. */
export function totals(buckets: DayBucket[]): IncomeTotals {
  let real = 0,
    test = 0,
    spend = 0
  const trading = { paper: 0n, demo: 0n, live: 0n }
  for (const b of buckets) {
    real += b.realKopecks
    test += b.testKopecks
    spend += b.spendKopecks
    trading.paper += b.trading.paper
    trading.demo += b.trading.demo
    trading.live += b.trading.live
  }
  return {
    realOrdersKopecks: real,
    liveTradingUsdt: decimal(trading.live),
    liveExecution: amounts(buckets.map((b) => b.execution.live)),
    testPaymentsKopecks: test,
    paperTradingUsdt: decimal(trading.paper),
    demoTradingUsdt: decimal(trading.demo),
    testExecution: amounts(buckets.flatMap((b) => [b.execution.paper, b.execution.demo])),
    spendKopecks: spend,
    netKopecks: real - spend,
  }
}

/** Period totals from 30 day buckets keyed by UTC day. */
export function periodTotals(byDay: Map<string, DayBucket>, now: Date, period: IncomePeriod) {
  return totals(dayKeys(now, periodDays[period]).map((day) => byDay.get(day) ?? emptyBucket()))
}

type Portfolio = { mode: IncomeMode; status: string; started?: boolean }
/**
 * The mode that represents a direction: live when it was ever activated or runs, then an active
 * demo, then paper. A configured but never started live budget is not real activity.
 */
export function headlineMode(portfolios: Portfolio[]): IncomeMode {
  const by = (mode: IncomeMode) => portfolios.find((p) => p.mode === mode)
  const live = by('live')
  if (live && (live.started || live.status === 'running' || live.status === 'paused')) return 'live'
  const demo = by('demo')
  if (demo && (demo.status === 'running' || demo.status === 'paused')) return 'demo'
  return 'paper'
}

/** Status of a trading or execution direction from its headline portfolio. */
export function directionStatus(p: {
  status: string
  workerAlive: boolean
  problem: boolean
}): IncomeSourceStatus {
  if (p.problem || p.status === 'attention') return 'needs_human'
  if (p.status === 'running') return p.workerAlive ? 'autonomous' : 'needs_human'
  return 'disabled'
}

export const isZero = (value: string) => /^-?0(?:\.0*)?$/.test(value)
