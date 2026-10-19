import { afterEach, expect, it, vi } from 'vitest'
import { MANAGER_POLICY } from '../../core/policy'
import { managerLimits } from '../../core/manager/limits'

afterEach(() => vi.unstubAllEnvs())
it('checks the actual paid envelope before charging or sending a model request', async () => {
  vi.resetModules()
  vi.stubEnv('MODEL_PROVIDER', 'openai')
  vi.stubEnv('SEARCH_PROVIDER', 'searxng')
  // The original 5 ₽ envelope: a paid Astra review does not fit and nothing is sent.
  vi.stubEnv('MANAGER_RESERVE_KOPECKS', String(MANAGER_POLICY.reserveKopecks))
  const { planWithModel, managerModelArgs, managerModelBlocker } =
    await import('../../core/manager/runtime')
  const { prepareModelRequest } = await import('../../core/providers')
  const snapshot = { at: new Date().toISOString(), portfolios: [], recentTasks: [] },
    run = { id: 'run', reservationId: 'reservation' }
  const args = managerModelArgs(snapshot, run)
  expect(args.maxOutputTokens).toBe(2800)
  expect(prepareModelRequest(args).maximum).toBeGreaterThan(MANAGER_POLICY.reserveKopecks)
  expect(managerModelBlocker()).toBe('MANAGER_MODEL_TOO_EXPENSIVE')
  const network = vi.spyOn(globalThis, 'fetch')
  try {
    await expect(planWithModel(snapshot, run)).rejects.toThrow('MANAGER_MODEL_TOO_EXPENSIVE')
    expect(network).not.toHaveBeenCalled()
  } finally {
    network.mockRestore()
  }
})
it('fits a full bounded Astra review through OpenRouter into the default paid envelope', async () => {
  vi.resetModules()
  vi.stubEnv('MODEL_PROVIDER', 'openai')
  vi.stubEnv('OPENAI_TRANSPORT', 'openrouter')
  vi.stubEnv('OPENROUTER_API_KEY', 'test-only')
  vi.stubEnv('SEARCH_PROVIDER', 'searxng')
  const { managerModelArgs, managerModelBlocker } = await import('../../core/manager/runtime')
  const { prepareModelRequest } = await import('../../core/providers')
  const { managerLimits: limits } = await import('../../core/manager/limits')
  expect(managerModelBlocker()).toBe('')
  // The largest snapshot the server builds: four portfolios, four agents each, twelve tasks.
  const agent = (i: number) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    kind: 'reversion',
    params: { lookback: 60, entryBps: 60, takeProfitBps: 100 },
    symbol: 'BTC-USDT',
    selectorVersion: 3,
    assignedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    roundTrips: 12,
    cashUsdt: '24.123456789012345678',
    baseQuantity: '0.000123456789012345',
    pnlUsdt: '-1.123456789012345678',
    drawdownBps: 120,
    canExperiment: true,
  })
  const snapshot = {
    at: new Date().toISOString(),
    portfolios: ['okx', 'bybit', 'binance', 'bitget'].map((exchange) => ({
      exchange,
      status: 'running',
      reason: '',
      revision: 3,
      activeTask: false,
      scoutFresh: true,
      candidates: Array.from({ length: 6 }, () => ({ symbol: 'ABCDEFGH-USDT', score: 1234 })),
      agents: [0, 1, 2, 3].map(agent),
    })),
    recentTasks: Array.from({ length: 12 }, () => ({
      exchange: 'okx',
      status: 'completed',
      reason: 'MANAGER_EVALUATED',
      hypothesis: 'Ю'.repeat(400),
      outcome: { verdict: 'Ю'.repeat(200) },
      created_at: new Date().toISOString(),
    })),
  }
  const request = prepareModelRequest(
    managerModelArgs(snapshot as never, { id: 'run', reservationId: 'r' }),
  )
  expect(request.maximumMicrousd).toBeGreaterThan(0)
  expect(request.maximum).toBeLessThanOrEqual(limits().reserveKopecks)
  expect(limits().dailyKopecks).toBeGreaterThanOrEqual(4 * limits().reserveKopecks)
})
it('keeps the zero-price provider within the same monetary envelope', async () => {
  vi.resetModules()
  vi.stubEnv('MODEL_PROVIDER', 'openrouter')
  vi.stubEnv('OPENROUTER_API_KEY', 'test-only')
  vi.stubEnv('SEARCH_PROVIDER', 'searxng')
  const { managerModelBlocker } = await import('../../core/manager/runtime')
  expect(managerModelBlocker()).toBe('')
})
it('clamps manager overrides to the policy ceilings and keeps free defaults', () => {
  const base = {
    MANAGER_RESERVE_KOPECKS: undefined,
    MANAGER_DAILY_KOPECKS: undefined,
    MANAGER_RUNS_PER_DAY: undefined,
  }
  expect(managerLimits({ ...base, MODEL_PROVIDER: 'openrouter' })).toEqual({
    reserveKopecks: MANAGER_POLICY.reserveKopecks,
    dailyKopecks: MANAGER_POLICY.dailyKopecks,
    maxDailyRuns: MANAGER_POLICY.maxDailyRuns,
    intervalMs: MANAGER_POLICY.intervalMs,
  })
  expect(managerLimits({ ...base, MODEL_PROVIDER: 'openai' }).reserveKopecks).toBe(
    MANAGER_POLICY.astraReserveKopecks,
  )
  const high = managerLimits({
    MODEL_PROVIDER: 'openai',
    MANAGER_RESERVE_KOPECKS: 10_000_000,
    MANAGER_DAILY_KOPECKS: 10_000_000,
    MANAGER_RUNS_PER_DAY: 1000,
  })
  expect(high.reserveKopecks).toBe(MANAGER_POLICY.maxReserveKopecks)
  expect(high.dailyKopecks).toBe(MANAGER_POLICY.maxDailyKopecks)
  expect(high.maxDailyRuns).toBe(MANAGER_POLICY.maxRunsPerDay)
  expect(high.intervalMs).toBe(2 * 60 * 60_000)
})
