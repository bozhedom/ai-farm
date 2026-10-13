import { afterEach, expect, it, vi } from 'vitest'
import { MANAGER_POLICY } from '../../core/policy'

afterEach(() => vi.unstubAllEnvs())
it('checks the actual paid envelope before charging or sending a model request', async () => {
  vi.resetModules()
  vi.stubEnv('MODEL_PROVIDER', 'openai')
  vi.stubEnv('SEARCH_PROVIDER', 'searxng')
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
it('keeps the zero-price provider within the same monetary envelope', async () => {
  vi.resetModules()
  vi.stubEnv('MODEL_PROVIDER', 'openrouter')
  vi.stubEnv('OPENROUTER_API_KEY', 'test-only')
  vi.stubEnv('SEARCH_PROVIDER', 'searxng')
  const { managerModelBlocker } = await import('../../core/manager/runtime')
  expect(managerModelBlocker()).toBe('')
})
