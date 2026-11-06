import { afterEach, expect, it, vi } from 'vitest'
import { availableModels } from '../../core/agent-profiles'

afterEach(() => vi.unstubAllGlobals())

it('includes free, short-context, expensive and non-schema text models with their capabilities', async () => {
  const base = {
    name: 'Model',
    context_length: 32000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.0000001', completion: '0.0000004' },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { ...base, id: 'vendor/small:free', pricing: { prompt: '0', completion: '0' } },
            {
              ...base,
              id: 'vendor/expensive',
              pricing: { prompt: '0.00002', completion: '0.00008' },
              supported_parameters: ['response_format'],
            },
            { ...base, id: '~vendor/latest', supported_parameters: ['structured_outputs'] },
            {
              ...base,
              id: 'vendor/image',
              architecture: { input_modalities: ['text'], output_modalities: ['image'] },
            },
            { ...base, id: 'vendor/router', pricing: { prompt: '-1', completion: '-1' } },
            { ...base, id: 'vendor/unbounded-fee', pricing: { ...base.pricing, request: '1' } },
          ],
        }),
      ),
    ),
  )
  const models = await availableModels()
  expect(models.map((m) => m.id)).toEqual([
    'vendor/small:free',
    'vendor/expensive',
    '~vendor/latest',
  ])
  expect(models.map((m) => m.pricing.outputFormat)).toEqual(['text', 'json', 'schema'])
  expect(models[0]!.pricing).toMatchObject({ inputNano: 0, outputNano: 0, contextLength: 32000 })
  expect(models[1]!.pricing).toMatchObject({ inputNano: 20000, outputNano: 80000 })
})
