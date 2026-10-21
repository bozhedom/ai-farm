import { describe, expect, it } from 'vitest'
import {
  DIRECTION_LIMITS as L,
  effectiveWeight,
  nextDirection,
  rotationSlot,
  validateDirectionTitle,
  validateWeight,
  yieldTenths,
  type DirectionYield,
} from '../../core/computer-use/directions'
import { builtInDirections, rotationGoals } from '../../core/computer-use/goals'
import { validateGoal } from '../../core/computer-use/policy'

const direction = (
  id: string,
  partial: Partial<DirectionYield> = {},
): DirectionYield & { credit: number } => ({
  id,
  weight: 3,
  credit: 0,
  tasks: 0,
  take: 0,
  human: 0,
  lastRunAt: null,
  ...partial,
})

/** Runs the scheduler `n` times, feeding the stored credits back like the database does. */
function simulate(start: DirectionYield[], n: number) {
  let rows = start.map((d) => ({ ...d }))
  const picks: string[] = []
  for (let i = 0; i < n; i++) {
    const result = nextDirection(rows)!
    picks.push(result.picked.id)
    const credits = new Map(result.credits.map((c) => [c.id, c.credit]))
    rows = rows.map((d) => ({ ...d, credit: credits.get(d.id)! }))
  }
  return picks
}
const count = (picks: string[], id: string) => picks.filter((p) => p === id).length
const maxGap = (picks: string[], id: string) => {
  let last = -1
  let gap = 0
  picks.forEach((p, i) => {
    if (p !== id) return
    gap = Math.max(gap, i - last)
    last = i
  })
  return Math.max(gap, picks.length - last)
}

describe('built-in search directions', () => {
  it('are concrete, legal and pass the owner-goal checks', () => {
    expect(builtInDirections.length).toBeGreaterThanOrEqual(20)
    const keys = new Set<string>()
    const titles = new Set<string>()
    for (const d of builtInDirections) {
      expect(d.key).toMatch(/^[a-z][a-z0-9_-]{1,60}$/)
      expect(keys.has(d.key)).toBe(false)
      keys.add(d.key)
      expect(titles.has(d.title)).toBe(false)
      titles.add(d.title)
      expect(validateDirectionTitle(d.title)).toBe(d.title)
      expect(validateGoal(d.goal)).toBe(d.goal)
      // Every goal says what to record: findings are records, never actions or revenue.
      expect(d.goal).toMatch(/[Зз]апиши/)
    }
    expect(rotationGoals).toEqual(builtInDirections.map((d) => d.goal))
  })
  it('keeps the first six goals of the previous rotation', () => {
    expect(builtInDirections.slice(0, 6).map((d) => d.key)).toEqual([
      'bounties',
      'freelance_text',
      'grants',
      'rewards',
      'digital_products',
      'small_business',
    ])
  })
  it('covers the broader legal set the owner asked for', () => {
    const all = builtInDirections.map((d) => `${d.title} ${d.goal}`).join('\n')
    for (const needle of [
      'Ozon',
      'Wildberries',
      'Gumroad',
      'Etsy',
      'Boosty',
      'plati.market',
      'PromptBase',
      'Algora',
      'bug bounty',
      'хакатон',
      'партнёрск',
      'Telegram',
      'закупки',
      'UserTesting',
      'тестирование сайтов',
      'Toloka',
      'write for us',
      'аирдроп',
      'перевод',
      'стоки',
    ])
      expect(all.toLowerCase()).toContain(needle.toLowerCase())
  })
})

describe('direction validation', () => {
  it('rejects forbidden schemes in titles and keeps the goal checks', () => {
    expect(() => validateDirectionTitle('Мультиаккаунты на биржах')).toThrow(
      'COMPUTER_USE_SCHEME_BLOCKED',
    )
    expect(() => validateDirectionTitle('Обход KYC для аирдропов')).toThrow(
      'COMPUTER_USE_SCHEME_BLOCKED',
    )
    expect(() => validateDirectionTitle('Курсовые работы для студентов')).toThrow(
      'POLICY_IDEA_TOPIC_BLOCKED',
    )
    expect(() => validateDirectionTitle('ab')).toThrow('COMPUTER_USE_DIRECTION_TITLE')
    expect(() => validateDirectionTitle('<b>Заголовок</b>')).toThrow('COMPUTER_USE_DIRECTION_TITLE')
    expect(validateDirectionTitle('  Переводы   для стартапов ')).toBe('Переводы для стартапов')
    expect(() => validateGoal('Найди, где купить аккаунты для аирдропов и дропов.')).toThrow(
      'COMPUTER_USE_SCHEME_BLOCKED',
    )
    expect(() => validateGoal('Найди площадки с обходом капчи и верификации.')).toThrow(
      'COMPUTER_USE_SCHEME_BLOCKED',
    )
    expect(() => validateGoal('Найди казино с партнёрской программой.')).toThrow(
      'POLICY_IDEA_TOPIC_BLOCKED',
    )
  })
  it('accepts priorities 1..5 only', () => {
    expect(validateWeight(1)).toBe(1)
    expect(validateWeight(5)).toBe(5)
    for (const bad of [0, 6, 2.5, NaN]) expect(() => validateWeight(bad)).toThrow('WEIGHT')
  })
})

describe('yield and effective weight', () => {
  it('gives untried directions the optimistic prior and bounds the multiplier', () => {
    expect(yieldTenths({ tasks: 0, take: 0, human: 0 })).toBe(L.priorYieldTenths)
    expect(yieldTenths({ tasks: 1, take: 5, human: 5 })).toBe(L.priorYieldTenths)
    expect(yieldTenths({ tasks: 4, take: 0, human: 0 })).toBe(0)
    expect(yieldTenths({ tasks: 4, take: 1, human: 2 })).toBe(10)
    expect(yieldTenths({ tasks: 2, take: 9, human: 9 })).toBe(L.maxYieldTenths)
    expect(effectiveWeight({ weight: 3, tasks: 4, take: 0, human: 0 })).toBe(30)
    expect(effectiveWeight({ weight: 3, tasks: 2, take: 9, human: 9 })).toBe(90)
    expect(effectiveWeight({ weight: 9, tasks: 4, take: 0, human: 0 })).toBe(50)
  })
})

describe('nextDirection: deterministic weighted round robin', () => {
  it('returns null without directions and the same pick for the same state', () => {
    expect(nextDirection([])).toBeNull()
    const rows = [direction('b'), direction('a'), direction('c', { credit: 5 })]
    const first = nextDirection(rows)!
    const second = nextDirection(rows)!
    expect(first.picked.id).toBe('c')
    expect(second).toEqual(first)
    // Untried directions weigh 3 * (10 + 10) = 60; the pick pays the total of 180.
    expect(first.credits).toEqual([
      { id: 'b', credit: 60 },
      { id: 'a', credit: 60 },
      { id: 'c', credit: 65 - 180 },
    ])
  })
  it('breaks ties by the longest wait, then by id', () => {
    const old = new Date('2026-10-01T00:00:00Z')
    const recent = new Date('2026-10-20T00:00:00Z')
    expect(
      nextDirection([
        direction('b', { lastRunAt: recent }),
        direction('a', { lastRunAt: old }),
        direction('c'),
      ])!.picked.id,
    ).toBe('c')
    expect(
      nextDirection([direction('b', { lastRunAt: recent }), direction('a', { lastRunAt: old })])!
        .picked.id,
    ).toBe('a')
    expect(nextDirection([direction('b'), direction('a')])!.picked.id).toBe('a')
  })
  it('shares equal directions evenly and never starves anyone', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => direction(id))
    const picks = simulate(rows, 50)
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(count(picks, id)).toBe(10)
      expect(maxGap(picks, id)).toBe(5)
    }
  })
  it('favours yield and priority within bounds', () => {
    const rows = [
      // Tried, nothing came of it: 3 * 10 = 30
      direction('dry', { tasks: 6 }),
      // Tried, the model takes jobs itself: 3 * 30 = 90
      direction('rich', { tasks: 6, take: 6, human: 2 }),
      // Untried owner direction with the lowest priority: 1 * 20 = 20
      direction('new', { weight: 1 }),
      // Highest priority, average yield: 5 * 20 = 100
      direction('top', { weight: 5, tasks: 4, take: 1, human: 2 }),
    ]
    const picks = simulate(rows, 240)
    expect(count(picks, 'dry')).toBe(30)
    expect(count(picks, 'rich')).toBe(90)
    expect(count(picks, 'new')).toBe(20)
    expect(count(picks, 'top')).toBe(100)
    // The weakest direction still runs about once per total/effective = 12 picks.
    expect(maxGap(picks, 'new')).toBeLessThanOrEqual(13)
    expect(maxGap(picks, 'dry')).toBeLessThanOrEqual(9)
  })
  it('keeps credits bounded by the total so the stored integers never drift', () => {
    const rows = [direction('a', { weight: 5 }), direction('b', { weight: 1 }), direction('c')]
    let current = rows
    const total = rows.reduce((sum, d) => sum + effectiveWeight(d), 0)
    for (let i = 0; i < 500; i++) {
      const result = nextDirection(current)!
      for (const c of result.credits) expect(Math.abs(c.credit)).toBeLessThanOrEqual(total)
      const credits = new Map(result.credits.map((c) => [c.id, c.credit]))
      current = current.map((d) => ({ ...d, credit: credits.get(d.id)! }))
    }
  })
})

describe('rotationSlot: platform goals keep their place', () => {
  it('is all directions without logged-in platforms', () => {
    for (let i = 0; i < 10; i++) expect(rotationSlot(i, 0)).toEqual({ kind: 'direction' })
  })
  it('runs both goals of one platform, then one direction', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => rotationSlot(i, 2))).toEqual([
      { kind: 'platform', index: 0 },
      { kind: 'platform', index: 1 },
      { kind: 'direction' },
      { kind: 'platform', index: 0 },
      { kind: 'platform', index: 1 },
      { kind: 'direction' },
    ])
  })
  it('gives one direction slot per platform with two platforms', () => {
    const slots = Array.from({ length: 12 }, (_, i) => rotationSlot(i, 4))
    expect(slots.filter((s) => s.kind === 'platform').length).toBe(8)
    expect(slots.filter((s) => s.kind === 'direction').length).toBe(4)
    expect(slots.slice(0, 4).map((s) => (s.kind === 'platform' ? s.index : -1))).toEqual([
      0, 1, 2, 3,
    ])
  })
  it('tolerates odd indexes', () => {
    expect(rotationSlot(-3, 2)).toEqual({ kind: 'platform', index: 0 })
    expect(rotationSlot(NaN, 2)).toEqual({ kind: 'platform', index: 0 })
    expect(rotationSlot(7.9, 2)).toEqual({ kind: 'platform', index: 1 })
  })
})
