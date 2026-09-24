import { describe, expect, it } from 'vitest'
import { assess, type Score } from '../../core/evolution'
const scores = (): Score[] =>
  [1000000, 900000, 500000, 400000].map((revenue, i) => ({
    id: String(i),
    visits: 400,
    delivered: 20,
    revenue,
    refunds: 0,
    fees: 10000,
    costs: 100000,
    violations: 0,
  }))
describe('weekly evaluation', () => {
  it('selects exactly two winners and two losers', () =>
    expect(assess(scores(), 14, true)).toMatchObject({
      decision: 'ROTATE',
      winners: ['0', '1'],
      losers: ['2', '3'],
    }))
  it('does not invent revenue when none exists', () =>
    expect(
      assess(
        scores().map((s) => ({ ...s, revenue: 0, delivered: 0 })),
        14,
        true,
      ).decision,
    ).toBe('HOLD'))
  it('waits for cohort maturation', () => expect(assess(scores(), 7, true).decision).toBe('HOLD'))
  it('refuses incomparable traffic and open obligations', () => {
    expect(assess(scores(), 14, false).decision).toBe('HOLD')
    expect(assess(scores(), 14, true, true).decision).toBe('HOLD')
  })
  it('does not rotate ties or losses', () => {
    expect(
      assess(
        scores().map((s) => ({ ...s, revenue: 1000000 })),
        14,
        true,
      ).decision,
    ).toBe('HOLD')
    expect(
      assess(
        scores().map((s) => ({ ...s, costs: 2000000 })),
        14,
        true,
      ).decision,
    ).toBe('HOLD')
  })
  it('closes an inconclusive 28-day experiment', () =>
    expect(assess([], 28, false).decision).toBe('CLOSED'))
  it('rejects invalid and duplicate metrics', () => {
    expect(
      assess(
        scores().map((s) => ({ ...s, visits: NaN })),
        14,
        true,
      ).decision,
    ).toBe('HOLD')
    expect(
      assess(
        scores().map((s) => ({ ...s, id: 'same' })),
        14,
        true,
      ).decision,
    ).toBe('HOLD')
  })
})
