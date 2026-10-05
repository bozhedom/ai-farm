import { beforeEach, expect, it, vi } from 'vitest'
const { readFile, query } = vi.hoisted(() => ({ readFile: vi.fn(), query: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile }))
vi.mock('../../core/db', () => ({ query }))
import { operationsStatus } from '../../core/operations'
const now = new Date('2026-10-05T01:00:00Z')
beforeEach(() => {
  vi.resetAllMocks()
  query.mockResolvedValue([{ worker_heartbeat: now, payment_heartbeat: now }])
})
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
