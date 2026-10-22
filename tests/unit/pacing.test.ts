import { describe, expect, it } from 'vitest'
import { expectedTaskCost, managerFloor, pacingDecision, type PacingInput } from '../../core/pacing'

const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 21, hour, minute))
const base: PacingInput = {
  category: 'scout',
  limit: 3000,
  dailyKopecks: 120000,
  spentBeforeHour: 0,
  usedThisHour: 0,
  managerFloor: 0,
  now: at(0),
}

describe('budget pacing', () => {
  it('gives each remaining hour an equal part of the remaining day', () => {
    expect(pacingDecision(base)).toMatchObject({ allowed: true, allowanceKopecks: 5000 })
    // Unspent morning budget moves to the later hours.
    expect(pacingDecision({ ...base, now: at(12) }).allowanceKopecks).toBe(10000)
    expect(pacingDecision({ ...base, now: at(23, 59) }).hoursRemaining).toBe(1)
  })
  it('postpones a second task once the hour is used', () => {
    const decision = pacingDecision({ ...base, usedThisHour: 3000 })
    expect(decision.allowed).toBe(false)
    expect(decision.retryAt).toBe(new Date(at(0, 10).getTime() + 5000).toISOString())
    expect(pacingDecision({ ...base, usedThisHour: 2000 }).allowed).toBe(true)
  })
  it('retries at the next hour when it comes before ten minutes', () => {
    const decision = pacingDecision({ ...base, usedThisHour: 4000, now: at(5, 55) })
    expect(decision.retryAt).toBe(new Date(at(6).getTime() + 5000).toISOString())
  })
  it('admits one large envelope in an empty hour while the day has room', () => {
    const research = { ...base, category: 'research' as const, limit: 10000 }
    expect(pacingDecision(research).allowed).toBe(true)
    expect(pacingDecision({ ...research, usedThisHour: 1 }).allowed).toBe(false)
    expect(pacingDecision({ ...research, spentBeforeHour: 115000, now: at(20) }).allowed).toBe(
      false,
    )
  })
  it('ranks scouts above leads and reports', () => {
    const used = { ...base, limit: 2000, usedThisHour: 2000 }
    expect(pacingDecision({ ...used, category: 'scout' }).allowed).toBe(true)
    expect(pacingDecision({ ...used, category: 'lead' }).allowed).toBe(false)
    expect(pacingDecision({ ...used, category: 'report' }).allowed).toBe(false)
    expect(pacingDecision({ ...used, category: 'report' }).allowanceKopecks).toBe(2500)
  })
  it('keeps the manager floor away from farm work and never paces the manager', () => {
    const held = { ...base, managerFloor: 48000 }
    expect(pacingDecision(held).allowanceKopecks).toBe(3000)
    expect(pacingDecision({ ...held, usedThisHour: 1 }).allowed).toBe(false)
    expect(pacingDecision({ ...held, spentBeforeHour: 70000, now: at(23) }).allowed).toBe(false)
    const manager = { ...held, category: 'trading_manager' as const, limit: 12000 }
    expect(pacingDecision({ ...manager, usedThisHour: 100000 }).allowed).toBe(true)
    expect(pacingDecision({ ...base, category: 'order', usedThisHour: 100000 }).allowed).toBe(true)
  })
  it('paces by the realistic cost, while the envelope must still fit the day', () => {
    // A 200 ₽ lead envelope for a task that really costs about 25 ₽.
    const lead = { ...base, category: 'lead' as const, limit: 20000, expectedKopecks: 2500 }
    expect(pacingDecision({ ...lead, usedThisHour: 2500 }).allowed).toBe(false)
    expect(pacingDecision({ ...lead, expectedKopecks: undefined, usedThisHour: 1 }).allowed).toBe(
      false,
    )
    // Allowance 3000 at hour 0 (120000 / 24 * 0.6); several 25 ₽ tasks fit in the hour.
    expect(pacingDecision({ ...lead, usedThisHour: 500 }).allowed).toBe(true)
    // The expected cost never exceeds the envelope.
    expect(pacingDecision({ ...lead, expectedKopecks: 999999, usedThisHour: 1 }).allowed).toBe(
      false,
    )
    // The full envelope must fit what is left of the day, whatever the estimate.
    expect(
      pacingDecision({ ...lead, spentBeforeHour: 101000, usedThisHour: 0, now: at(22) }).allowed,
    ).toBe(false)
  })
  it('estimates the task cost from enough history, never above the reservation', () => {
    expect(expectedTaskCost(20000, { count: 27, p90: 2697.4 })).toBe(2698)
    expect(expectedTaskCost(20000, { count: 4, p90: 2697 })).toBe(20000)
    expect(expectedTaskCost(20000, { count: 30, p90: 50000 })).toBe(20000)
    expect(expectedTaskCost(20000, { count: 30, p90: 0 })).toBe(1)
    expect(expectedTaskCost(20000, { count: 0, p90: Number.NaN })).toBe(20000)
    expect(expectedTaskCost(0, { count: 30, p90: 2000 })).toBe(0)
  })
  it('reserves the manager only for its remaining runs within its cap', () => {
    const args = {
      enabled: true,
      reserveKopecks: 12000,
      dailyKopecks: 48000,
      maxDailyRuns: 4,
      runsToday: 1,
      spentToday: 1500,
      reservedOpen: 0,
    }
    expect(managerFloor(args)).toBe(36000)
    expect(managerFloor({ ...args, spentToday: 40000 })).toBe(8000)
    expect(managerFloor({ ...args, runsToday: 4 })).toBe(0)
    expect(managerFloor({ ...args, enabled: false })).toBe(0)
    expect(managerFloor({ ...args, reserveKopecks: 0 })).toBe(0)
  })
  it('sizes the manager floor by its real run cost but keeps one full reservation', () => {
    const args = {
      enabled: true,
      reserveKopecks: 12000,
      dailyKopecks: 48000,
      maxDailyRuns: 4,
      runsToday: 1,
      spentToday: 1500,
      reservedOpen: 0,
    }
    // Three runs left at 13 ₽ each would be 39 ₽; the next run still needs its 120 ₽ envelope.
    expect(managerFloor({ ...args, expectedKopecks: 1300 })).toBe(12000)
    expect(managerFloor({ ...args, expectedKopecks: 5000 })).toBe(15000)
    // The estimate never exceeds the reservation.
    expect(managerFloor({ ...args, expectedKopecks: 50000 })).toBe(36000)
    expect(managerFloor({ ...args, expectedKopecks: 1300, runsToday: 4 })).toBe(0)
  })
})
