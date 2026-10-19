import { config, type Config } from '../config'
import { MANAGER_POLICY as P } from '../policy'

/**
 * Effective trading manager limits. Environment overrides are clamped to the MANAGER_POLICY
 * ceilings. Without them the paid GPT-6 Astra route gets an envelope its bounded review fits
 * in; every other provider keeps the original 5 ₽ per review and 20 ₽ a day. The global daily
 * and monthly limits, the dollar cap and the cost review apply on top.
 */
export function managerLimits(
  c: Pick<
    Config,
    'MODEL_PROVIDER' | 'MANAGER_RESERVE_KOPECKS' | 'MANAGER_DAILY_KOPECKS' | 'MANAGER_RUNS_PER_DAY'
  > = config(),
) {
  const astra = c.MODEL_PROVIDER === 'openai'
  const reserveKopecks = Math.min(
    P.maxReserveKopecks,
    c.MANAGER_RESERVE_KOPECKS ?? (astra ? P.astraReserveKopecks : P.reserveKopecks),
  )
  const dailyKopecks = Math.min(
    P.maxDailyKopecks,
    c.MANAGER_DAILY_KOPECKS ?? (astra ? P.astraDailyKopecks : P.dailyKopecks),
  )
  const maxDailyRuns = Math.min(P.maxRunsPerDay, c.MANAGER_RUNS_PER_DAY ?? P.maxDailyRuns)
  return {
    reserveKopecks,
    dailyKopecks,
    maxDailyRuns,
    // Four runs a day keep the original six hours; more runs shorten the interval evenly.
    intervalMs: Math.max(P.manualCooldownMs, Math.floor(86_400_000 / maxDailyRuns)),
  }
}
