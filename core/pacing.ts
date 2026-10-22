import type { BudgetCategory } from './budget'

/**
 * Budget pacing for paid models: the farm spreads the day's budget over the remaining UTC hours
 * instead of spending it in the morning. Pure functions; queue.ts supplies the numbers.
 *
 * Priorities: the trading manager is never paced and keeps a floor of its remaining daily
 * envelope; scouts may use the whole hourly allowance; research, leads and reports get a smaller
 * share. An empty hour always admits one task that fits the rest of the day, so a reserve larger
 * than the hourly allowance still runs (the next hours then get correspondingly less).
 *
 * The hourly share is measured in expected cost (recent p90 of actual charges per task), not in
 * reservations: a 200 ₽ envelope for a task that costs 25 ₽ would otherwise let one task run per
 * hour. Reservations stay the safe upper bound and still enforce the day and month caps.
 */
export const pacingShares: Partial<Record<BudgetCategory, number>> = {
  scout: 1,
  research: 0.8,
  lead: 0.6,
  report: 0.5,
}

export type PacingInput = {
  category: BudgetCategory
  /** Envelope of the task about to start: the safe upper bound that reserveBudget holds. */
  limit: number
  /**
   * What the task realistically costs (`expectedTaskCost`), at most `limit`. The hourly share
   * is paced by it; the envelope still has to fit the rest of the day. Defaults to `limit`.
   */
  expectedKopecks?: number
  dailyKopecks: number
  /** Charged today before the current UTC hour. */
  spentBeforeHour: number
  /** Charged during the current hour plus open reservations at their expected cost. */
  usedThisHour: number
  /** Held for the trading manager's remaining reviews today. */
  managerFloor: number
  now: Date
}
export type PacingDecision = {
  allowed: boolean
  /** Kopecks this category may use during the current hour. */
  allowanceKopecks: number
  hoursRemaining: number
  /** When a postponed task should look again. */
  retryAt: string
}

export const pacingRetryMs = 10 * 60_000

export function pacingDecision(input: PacingInput): PacingDecision {
  const hoursRemaining = 24 - input.now.getUTCHours()
  const nextHour = Date.UTC(
    input.now.getUTCFullYear(),
    input.now.getUTCMonth(),
    input.now.getUTCDate(),
    input.now.getUTCHours() + 1,
  )
  const retryAt = new Date(
    Math.min(nextHour, input.now.getTime() + pacingRetryMs) + 5000,
  ).toISOString()
  const share = input.category === 'trading_manager' ? 1 : (pacingShares[input.category] ?? 1)
  const floor = input.category === 'trading_manager' ? 0 : Math.max(0, input.managerFloor)
  const available = Math.max(0, input.dailyKopecks - input.spentBeforeHour - floor)
  const allowanceKopecks = Math.floor((available / hoursRemaining) * share)
  if (input.category === 'trading_manager' || input.category === 'order' || input.limit === 0)
    return { allowed: true, allowanceKopecks, hoursRemaining, retryAt }
  const restOfDay = available - input.usedThisHour
  const expected = Math.min(input.limit, Math.max(0, input.expectedKopecks ?? input.limit))
  const allowed =
    input.limit <= restOfDay &&
    (input.usedThisHour + expected <= allowanceKopecks || input.usedThisHour === 0)
  return { allowed, allowanceKopecks, hoursRemaining, retryAt }
}

/**
 * Kopecks the manager may still need today: its remaining runs at their realistic cost, but
 * never less than one full reservation so the next run can always be admitted; within its cap.
 */
export function managerFloor(args: {
  enabled: boolean
  reserveKopecks: number
  /** Realistic cost of one run (`expectedTaskCost`); the reservation when unknown. */
  expectedKopecks?: number
  dailyKopecks: number
  maxDailyRuns: number
  runsToday: number
  spentToday: number
  reservedOpen: number
}) {
  if (!args.enabled || args.reserveKopecks <= 0) return 0
  const runs = Math.max(0, args.maxDailyRuns - args.runsToday)
  const cap = Math.max(0, args.dailyKopecks - args.spentToday - args.reservedOpen)
  if (!runs) return 0
  const perRun = Math.min(args.reserveKopecks, args.expectedKopecks ?? args.reserveKopecks)
  return Math.min(cap, Math.max(runs * perRun, args.reserveKopecks))
}

/** Fewer finished tasks than this and pacing keeps the full reservation as the estimate. */
export const expectedCostMinSamples = 5
export const expectedCostWindowDays = 14

/**
 * The realistic cost of one task: the 90th percentile of what recent finished tasks of the
 * category were actually charged, never above the reservation. Too little history falls back to
 * the reservation. Only pacing uses it; reservations and day/month caps stay pessimistic.
 */
export function expectedTaskCost(reserveKopecks: number, sample: { count: number; p90: number }) {
  if (reserveKopecks <= 0) return 0
  if (sample.count < expectedCostMinSamples || !Number.isFinite(sample.p90)) return reserveKopecks
  return Math.min(reserveKopecks, Math.max(1, Math.ceil(sample.p90)))
}
