import { describe, expect, it } from 'vitest'
import { managerFloor, pacingDecision, type PacingInput } from '../../core/pacing'

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
})
