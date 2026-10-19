import type { BudgetCategory } from './budget'

/**
 * Budget pacing for paid models: the farm spreads the day's budget over the remaining UTC hours
 * instead of spending it in the morning. Pure functions; queue.ts supplies the numbers.
 *
 * Priorities: the trading manager is never paced and keeps a floor of its remaining daily
 * envelope; scouts may use the whole hourly allowance; research, leads and reports get a smaller
 * share. An empty hour always admits one task that fits the rest of the day, so a reserve larger
 * than the hourly allowance still runs (the next hours then get correspondingly less).
 */
export const pacingShares: Partial<Record<BudgetCategory, number>> = {
  scout: 1,
  research: 0.8,
  lead: 0.6,
  report: 0.5,
}

export type PacingInput = {
  category: BudgetCategory
  /** Envelope of the task about to start. */
  limit: number
  dailyKopecks: number
  /** Charged today before the current UTC hour. */
  spentBeforeHour: number
  /** Charged during the current hour plus every open reservation. */
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
  const allowed =
    input.limit <= restOfDay &&
    (input.usedThisHour + input.limit <= allowanceKopecks || input.usedThisHour === 0)
  return { allowed, allowanceKopecks, hoursRemaining, retryAt }
}

/** Kopecks the manager may still need today: its remaining runs, within its remaining cap. */
export function managerFloor(args: {
  enabled: boolean
  reserveKopecks: number
  dailyKopecks: number
  maxDailyRuns: number
  runsToday: number
  spentToday: number
  reservedOpen: number
}) {
  if (!args.enabled || args.reserveKopecks <= 0) return 0
  const runs = Math.max(0, args.maxDailyRuns - args.runsToday)
  const cap = Math.max(0, args.dailyKopecks - args.spentToday - args.reservedOpen)
  return Math.min(cap, runs * args.reserveKopecks)
}
