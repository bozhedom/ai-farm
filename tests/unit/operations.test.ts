import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { readFile, query, config } = vi.hoisted(() => ({
  readFile: vi.fn(),
  query: vi.fn(),
  config: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({ readFile }))
vi.mock('../../core/db', () => ({ query }))
vi.mock('../../core/config', () => ({ config }))
import { operationsStatus, serviceReadiness } from '../../core/operations'
const now = new Date('2026-10-05T01:00:00Z')
const healthyState = {
  worker_heartbeat: now,
  payment_heartbeat: now,
  provider_readiness: { model: true, search: true, checkedAt: now.toISOString() },
}
const backup = { status: 'ok', completedAt: now.toISOString() }
beforeEach(() => {
  vi.resetAllMocks()
  query.mockResolvedValue([healthyState])
  config.mockReturnValue({ MODEL_PROVIDER: 'ollama', SEARCH_PROVIDER: 'searxng' })
})
afterEach(() => vi.unstubAllGlobals())
it('reports missing observation history as not started', async () => {
  readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  expect(await operationsStatus(now)).toMatchObject({
    observationError: false,
    observation: { samples: 0, complete: false },
  })
})
it.each(['{broken', 'null', '{}'])(
  'reports corrupt saved history without claiming a fresh start: %s',
  async (content) => {
    readFile.mockResolvedValue(content)
    expect(await operationsStatus(now)).toMatchObject({
      observationError: true,
      observation: { complete: false },
      checks: { backup: false },
    })
  },
)
it('makes an unreadable history visible as an error', async () => {
  readFile.mockRejectedValue(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
  expect(await operationsStatus(now)).toMatchObject({ observationError: true })
})
it('requires fresh model and search preflight as well as infrastructure readiness', async () => {
  readFile.mockResolvedValue(JSON.stringify(backup))
  expect(await serviceReadiness(now)).toMatchObject({
    version: 2,
    status: 'ok',
    checks: {
      database: true,
      worker: true,
      payments: true,
      backup: true,
      providerHeartbeat: true,
      model: true,
      search: true,
    },
    infrastructure: { status: 'ok' },
    providers: {
      status: 'ok',
      fresh: true,
      model: { verification: 'local_probe', preflightReady: true },
      search: { verification: 'local_probe', preflightReady: true },
    },
  })
})
it.each(['model', 'search'] as const)(
  'reports degraded autonomous readiness when %s is unavailable despite healthy infrastructure',
  async (key) => {
    readFile.mockResolvedValue(JSON.stringify(backup))
    query.mockResolvedValue([
      { ...healthyState, provider_readiness: { ...healthyState.provider_readiness, [key]: false } },
    ])
    expect(await serviceReadiness(now)).toMatchObject({
      status: 'degraded',
      infrastructure: { status: 'ok' },
      checks: { providerHeartbeat: true, [key]: false },
      providers: { status: 'degraded', [key]: { preflightReady: false } },
    })
  },
)
it.each([
  null,
  { model: true, search: true },
  { model: true, search: true, checkedAt: 'invalid' },
  { model: true, search: true, checkedAt: new Date(now.getTime() - 90000).toISOString() },
  { model: true, search: true, checkedAt: new Date(now.getTime() + 6000).toISOString() },
])('does not trust absent, stale or invalid provider evidence: %j', async (readiness) => {
  readFile.mockResolvedValue(JSON.stringify(backup))
  query.mockResolvedValue([{ ...healthyState, provider_readiness: readiness }])
  expect(await serviceReadiness(now)).toMatchObject({
    status: 'degraded',
    infrastructure: { status: 'ok' },
    checks: { providerHeartbeat: false, model: false, search: false },
    providers: { status: 'degraded', fresh: false },
  })
})
it('keeps infrastructure failures separate from fresh dependency evidence', async () => {
  readFile.mockResolvedValue(JSON.stringify(backup))
  query.mockResolvedValue([{ ...healthyState, worker_heartbeat: null }])
  expect(await serviceReadiness(now)).toMatchObject({
    status: 'degraded',
    infrastructure: { status: 'degraded', checks: { worker: false } },
    providers: { status: 'ok', fresh: true },
  })
  query.mockRejectedValue(new Error('database unavailable'))
  expect(await serviceReadiness(now)).toMatchObject({
    status: 'degraded',
    checks: { database: false, worker: false, payments: false, providerHeartbeat: false },
    providers: { status: 'degraded', fresh: false },
  })
})
it.each(['openrouter', 'openai', 'yandex'])(
  'marks %s cloud APIs as unprobed without calling them',
  async (model) => {
    readFile.mockResolvedValue(JSON.stringify(backup))
    config.mockReturnValue({ MODEL_PROVIDER: model, SEARCH_PROVIDER: 'yandex' })
    vi.stubGlobal('fetch', vi.fn())
    expect(await serviceReadiness(now)).toMatchObject({
      status: 'ok',
      providers: {
        model: { provider: model, verification: 'not_probed', preflightReady: true },
        search: { provider: 'yandex', verification: 'not_probed', preflightReady: true },
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  },
)
it('retains valid old observations as infrastructure history without a migration error', async () => {
  const samples = [60, 0].map((seconds) => ({
    at: new Date(now.getTime() - seconds * 1000).toISOString(),
    ok: true,
    checks: { database: true, worker: true, payments: true, backup: true },
  }))
  readFile.mockImplementation(async (path: string) =>
    JSON.stringify(path.endsWith('backup.json') ? backup : samples),
  )
  expect(await operationsStatus(now)).toMatchObject({
    observationError: false,
    observation: {
      complete: false,
      legacySamples: 2,
      healthySeconds: 0,
      infrastructure: { healthySeconds: 60, failedSamples: 0 },
    },
  })
})
