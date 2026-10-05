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
      expect(url.pathname).toBe('/api/tags')
      return new Response(JSON.stringify({ models: [{ name: settings.config().OLLAMA_MODEL }] }))
    }),
  )
  expect(await localProviderReadiness()).toEqual({ model: true, search: false })
  vi.mocked(fetch).mockImplementation(
    async () =>
      new Response(JSON.stringify({ models: [{ name: settings.config().OLLAMA_MODEL }] })),
  )
  expect(await localProviderReadiness()).toEqual({ model: true, search: true })
})

it('keeps a missing model waiting even when the Ollama process responds', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'ollama',
    SEARCH_PROVIDER: 'searxng',
    OLLAMA_MODEL: 'qwen3:4b',
  })
  for (const data of [
    {},
    { models: [] },
    { models: [{ name: 'qwen3:8b' }] },
    { models: [null, { name: 123 }] },
  ]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    expect(await localProviderReadiness()).toEqual({ model: false, search: true })
  }
})

it('accepts the implicit latest tag without confusing a registry port with a tag', async () => {
  const original = settings.config()
  const config = vi.spyOn(settings, 'config')
  for (const name of ['qwen3', 'registry.example:5000/team/qwen3']) {
    config.mockReturnValue({
      ...original,
      MODEL_PROVIDER: 'ollama',
      SEARCH_PROVIDER: 'searxng',
      OLLAMA_MODEL: name,
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ models: [{ model: `${name}:latest` }] }))),
    )
    expect(await localProviderReadiness()).toEqual({ model: true, search: true })
  }
})

it('treats invalid model lists and HTTP errors as unavailable', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'ollama',
    SEARCH_PROVIDER: 'searxng',
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid json')))
  expect(await localProviderReadiness()).toEqual({ model: false, search: true })
  vi.mocked(fetch).mockImplementation(async () => new Response('error', { status: 503 }))
  expect(await localProviderReadiness()).toEqual({ model: false, search: false })
})

it('makes no readiness requests for cloud or demo providers', async () => {
  vi.stubGlobal('fetch', vi.fn())
  expect(await localProviderReadiness()).toEqual({ model: true, search: true })
  expect(fetch).not.toHaveBeenCalled()
})
