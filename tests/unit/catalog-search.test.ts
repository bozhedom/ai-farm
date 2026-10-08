import { afterEach, describe, expect, it, vi } from 'vitest'
import { serviceByTemplate, serviceTemplates } from '../../core/service-catalog'
import type { Template } from '../../core/policy'

const mocks = vi.hoisted(() => ({
  config: vi.fn(() => ({ SEARCH_PROVIDER: 'demo', SEARCH_COST_KOPECKS: 60 })),
  localSearch: vi.fn(),
  meteredCall: vi.fn(
    async (args: { invoke: () => Promise<{ value: unknown }> }) => (await args.invoke()).value,
  ),
}))

vi.mock('../../core/config', () => ({ config: mocks.config }))
vi.mock('../../core/budget', () => ({ meteredCall: mocks.meteredCall }))
vi.mock('../../core/providers/local', () => ({
  localSearch: mocks.localSearch,
  localModel: vi.fn(),
}))

import { search } from '../../core/providers'

afterEach(() => {
  vi.clearAllMocks()
  mocks.config.mockReturnValue({ SEARCH_PROVIDER: 'demo', SEARCH_COST_KOPECKS: 60 })
})

describe('catalog evidence queries', () => {
  it.each(serviceTemplates)(
    '%s uses a separate server-defined customer query',
    async (template) => {
      mocks.config.mockReturnValue({ SEARCH_PROVIDER: 'searxng', SEARCH_COST_KOPECKS: 60 })
      mocks.localSearch.mockResolvedValue([])
      await search(template, `research:${template}`, 'reservation')
      expect(mocks.localSearch).toHaveBeenLastCalledWith(serviceByTemplate[template].searchQuery, 2)
      await search(template, `customers:${template}`, 'reservation', 'customers')
      expect(mocks.localSearch).toHaveBeenLastCalledWith(
        serviceByTemplate[template].clientSearchQuery,
        0,
      )
      expect(mocks.meteredCall).toHaveBeenLastCalledWith(
        expect.objectContaining({
          reservationId: 'reservation',
          maximum: 0,
          activity: expect.objectContaining({
            taskLabel: expect.stringContaining('Поиск запросов'),
          }),
        }),
      )
    },
  )

  it('marks synthetic customer candidates and never calls a real search in demo mode', async () => {
    const evidence = await search('description', 'demo-customers', 'reservation', 'customers')
    expect(evidence).toHaveLength(2)
    for (const item of evidence) {
      expect(item.demo).toBe(true)
      expect(new URL(item.url).hostname.endsWith('.example')).toBe(true)
      expect(item.title).toContain('Демонстрация')
    }
    expect(mocks.localSearch).not.toHaveBeenCalled()
  })

  it.each(['unsupported', 'constructor', 'toString'])(
    'rejects %s before reserving a call',
    async (id) => {
      await expect(search(id as Template, 'invalid', 'reservation')).rejects.toThrow(
        'TEMPLATE_UNSUPPORTED',
      )
      expect(mocks.meteredCall).not.toHaveBeenCalled()
      expect(mocks.localSearch).not.toHaveBeenCalled()
    },
  )
})
