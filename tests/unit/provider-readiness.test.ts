import { afterEach, expect, it, vi } from 'vitest'
import * as settings from '../../core/config'
import { localProviderReadiness } from '../../core/providers/readiness'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps research waiting for local search while the model is ready for orders', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'ollama',
    SEARCH_PROVIDER: 'searxng',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL) => {
      if (url.pathname === '/healthz') throw new Error('connection refused')
      return new Response('{}')
    }),
  )
  expect(await localProviderReadiness()).toEqual({ model: true, search: false })
  vi.mocked(fetch).mockImplementation(async () => new Response('{}'))
  expect(await localProviderReadiness()).toEqual({ model: true, search: true })
})

it('makes no readiness requests for cloud or demo providers', async () => {
  vi.stubGlobal('fetch', vi.fn())
  expect(await localProviderReadiness()).toEqual({ model: true, search: true })
  expect(fetch).not.toHaveBeenCalled()
})
