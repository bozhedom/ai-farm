import { describe, expect, it } from 'vitest'
import { scoreStrategies, selectionReadiness, scoreWeights } from '../../core/evolution'
import type { AgentMetrics } from '../../core/agents'
import { demoIdeaCritique } from '../../core/providers/demo'
import { defaultParams } from '../../core/agents'

const metrics = (id: string, over: Partial<AgentMetrics> = {}): AgentMetrics => ({
  strategyId: id,
  createdAt: '2026-10-01T00:00:00.000Z',
  ideas: 6,
  passed: 3,
  duplicates: 0,
  sourceMilli: 6 * 667,
  executablePassed: 0,
  builtPassed: 0,
  costKopecks: 0,
  reserveKopecks: 0,
  delivered: 0,
  review: 0,
  humanFinished: 0,
  humanWorked: 0,
  ...over,
})
const state = {
  mode: 'running',
  research_enabled: true,
  evolution_enabled: true,
  evolution_min_ideas: 6,
  generation: 1,
}

describe('quality score', () => {
  it('uses integer components and drops the ones that do not apply', () => {
    const [scored] = scoreStrategies([metrics('a')])
    expect(scored!.components).toEqual({
      P: 500,
      E: 667,
      U: 1000,
      B: null,
      C: null,
      D: null,
      H: null,
    })
    expect(scored!.total).toBe(Math.round((40 * 500 + 20 * 667 + 10 * 1000) / 70))
    const full = scoreStrategies([
      metrics('b', {
        executablePassed: 2,
        builtPassed: 1,
        reserveKopecks: 3000,
        costKopecks: 9000,
        delivered: 3,
        review: 1,
        humanFinished: 4,
        humanWorked: 1,
      }),
    ])[0]!
    expect(full.components).toEqual({ P: 500, E: 667, U: 1000, B: 500, C: 500, D: 750, H: 250 })
    const weights = Object.values(scoreWeights).reduce((a, b) => a + b, 0)
    expect(full.total).toBe(
      Math.round(
        (40 * 500 + 20 * 667 + 10 * 1000 + 15 * 500 + 5 * 500 + 10 * 750 + 20 * 250) / weights,
      ),
    )
    expect(Number.isInteger(full.total)).toBe(true)
  })

  it('does not punish executable ideas that still wait for their product check', () => {
    // Two accepted executable ideas, no check finished yet: B does not apply.
    const waiting = scoreStrategies([
      metrics('w', { passed: 6, executablePassed: 0, builtPassed: 0 }),
    ])[0]!
    const human = scoreStrategies([metrics('h', { passed: 6 })])[0]!
    expect(waiting.components.B).toBeNull()
    expect(waiting.total).toBe(human.total)
    const failed = scoreStrategies([
      metrics('f', { passed: 6, executablePassed: 2, builtPassed: 0 }),
    ])[0]!
    expect(failed.components.B).toBe(0)
  })

  it('writes counts in correct Russian', () => {
    const four = scoreStrategies(['a', 'b', 'c', 'd'].map((id) => metrics(id, { ideas: 1 })))
    expect(selectionReadiness({ ...state, evolution_min_ideas: 2 }, four, false).reason).toBe(
      'Ждём данных: нужно не меньше 2 идей у каждого разведчика.',
    )
    const close = scoreStrategies([
      metrics('a', { passed: 6 }),
      metrics('b', { passed: 5 }),
      metrics('c', { passed: 5, duplicates: 1 }),
      metrics('d', { passed: 0 }),
    ])
    expect(selectionReadiness(state, close, false).reason).toMatch(
      /1 пункт,|2 пункта,|[05-9] пунктов,/,
    )
  })

  it('ranks by score, then the older agent wins a tie', () => {
    const ranked = scoreStrategies([
      metrics('copy', { createdAt: '2026-10-05T00:00:00.000Z' }),
      metrics('old', { createdAt: '2026-10-01T00:00:00.000Z' }),
      metrics('best', { passed: 6 }),
      metrics('weak', { passed: 0, duplicates: 3 }),
    ])
    expect(ranked.map((r) => r.strategyId)).toEqual(['best', 'old', 'copy', 'weak'])
  })

  it('holds without four agents, enough ideas or a 5 point gap', () => {
    const four = scoreStrategies([
      metrics('a', { passed: 6 }),
      metrics('b', { passed: 5 }),
      metrics('c', { passed: 1 }),
      metrics('d', { passed: 0 }),
    ])
    expect(selectionReadiness(state, four, false).ready).toBe(true)
    expect(selectionReadiness(state, four.slice(0, 3), false).reason).toMatch(/четыре/)
    expect(selectionReadiness(state, four, true).reason).toBe('В этом поколении отбор уже был.')
    expect(selectionReadiness({ ...state, evolution_min_ideas: 7 }, four, false)).toMatchObject({
      ready: false,
      missing: [
        { agentId: 'a', need: 1 },
        { agentId: 'b', need: 1 },
        { agentId: 'c', need: 1 },
        { agentId: 'd', need: 1 },
      ],
    })
    const close = scoreStrategies([
      metrics('a', { passed: 6 }),
      metrics('b', { passed: 4 }),
      metrics('c', { passed: 4 }),
      metrics('d', { passed: 0 }),
    ])
    expect(selectionReadiness(state, close, false).reason).toMatch(
      /^Разрыв между вторым и третьим 0/,
    )
    expect(selectionReadiness({ ...state, mode: 'paused' }, four, false).ready).toBe(false)
    expect(selectionReadiness({ ...state, evolution_enabled: false }, four, false).ready).toBe(
      false,
    )
  })

  it('gives the demo critic a measurable gap with founder parameters', () => {
    const passes = [0, 1, 2, 3].map((agent) =>
      [0, 1].filter(
        (n) =>
          demoIdeaCritique({ params: defaultParams(agent), previousByAgent: n, duplicate: false })
            .verdict === 'PASS',
      ),
    )
    expect(passes.map((p) => p.length)).toEqual([2, 1, 0, 0])
    expect(
      demoIdeaCritique({ params: defaultParams(0), previousByAgent: 0, duplicate: true }).verdict,
    ).toBe('REVISE')
  })
})
