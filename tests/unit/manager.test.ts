import { describe, expect, it } from 'vitest'
import {
  demoManagerPlan,
  managerPlanSchema,
  validatePlanAgainstSnapshot,
  type ManagerSnapshot,
} from '../../core/manager/plan'

const snapshot: ManagerSnapshot = {
  at: new Date().toISOString(),
  recentTasks: [],
  portfolios: [
    {
      exchange: 'okx',
      status: 'running',
      reason: '',
      revision: 0,
      activeTask: false,
      scoutFresh: true,
      candidates: [],
      agents: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'reversion',
          params: { lookback: 60, entryBps: 60, takeProfitBps: 100 },
          symbol: 'SOL-USDT',
          selectorVersion: 'test',
          assignedAt: '2026-10-01T00:00:00Z',
          createdAt: '2026-10-01T00:00:00Z',
          roundTrips: 4,
          cashUsdt: '25',
          baseQuantity: '0',
          pnlUsdt: '-1',
          drawdownBps: 50,
          canExperiment: true,
        },
      ],
    },
  ],
}
const plan = () => demoManagerPlan(structuredClone(snapshot))

describe('bounded manager proposals', () => {
  it('accepts a bounded experiment and an explicit decision to wait', () => {
    expect(
      validatePlanAgainstSnapshot(managerPlanSchema.parse(plan()), snapshot).tasks,
    ).toHaveLength(1)
    expect(
      managerPlanSchema.parse({
        summary: 'Недостаточно новых данных для проверяемого эксперимента.',
        tasks: [],
      }),
    ).toBeTruthy()
  })
  it('rejects invented tools, money, private modes and risk editing', () => {
    for (const forbidden of [
      { command: 'rm -rf /' },
      { mode: 'live' },
      { capital: 1000 },
      { maxLossBps: 10000 },
      { url: 'https://evil.example' },
    ]) {
      const value = plan()
      Object.assign(value.tasks[0]!, forbidden)
      expect(managerPlanSchema.safeParse(value).success).toBe(false)
    }
    const value = plan()
    Object.assign(value, { execute: 'buy' })
    expect(managerPlanSchema.safeParse(value).success).toBe(false)
  })
  it('enforces parameter bounds and does not accept extra tuning fields', () => {
    for (const params of [
      { lookback: 1, entryBps: 60, takeProfitBps: 100 },
      { lookback: 60, entryBps: 301, takeProfitBps: 100 },
      { lookback: 60, entryBps: 60, takeProfitBps: 601 },
      { lookback: 60, entryBps: 60, takeProfitBps: 100, leverage: 2 },
    ]) {
      const value = plan()
      Object.assign(value.tasks[0]!, { params })
      expect(managerPlanSchema.safeParse(value).success).toBe(false)
    }
  })
  it('does not authorize foreign agents or repeated experiments for the same exchange', () => {
    const foreign = plan()
    foreign.tasks[0]!.exchange = 'bybit'
    expect(() => validatePlanAgainstSnapshot(foreign, snapshot)).toThrow('MANAGER_TARGET_INVALID')
    const duplicated = plan()
    duplicated.tasks.push({ ...duplicated.tasks[0]! })
    expect(() => validatePlanAgainstSnapshot(duplicated, snapshot)).toThrow(
      'MANAGER_DUPLICATE_EXCHANGE',
    )
  })
  it('preserves existing experiments, protected agents and unchanged strategies', () => {
    const busy = structuredClone(snapshot)
    busy.portfolios[0]!.activeTask = true
    expect(() => validatePlanAgainstSnapshot(plan(), busy)).toThrow('MANAGER_TARGET_INVALID')
    const protectedAgent = structuredClone(snapshot)
    protectedAgent.portfolios[0]!.agents[0]!.canExperiment = false
    expect(() => validatePlanAgainstSnapshot(plan(), protectedAgent)).toThrow(
      'MANAGER_TARGET_INVALID',
    )
    const same = plan()
    same.tasks[0]!.params = snapshot.portfolios[0]!.agents[0]!.params
    expect(() => validatePlanAgainstSnapshot(same, snapshot)).toThrow('MANAGER_UNCHANGED_PROPOSAL')
  })
  it('labels synthetic planning and never invents an actionable agent', () => {
    const empty = structuredClone(snapshot)
    empty.portfolios[0]!.agents = []
    expect(demoManagerPlan(empty).tasks).toEqual([])
    expect(plan().summary).toContain('не получен от LLM')
    expect(plan().tasks[0]!.rationale).toContain('готовый пример')
  })
})
