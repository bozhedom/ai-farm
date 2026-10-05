import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as settings from '../../core/config'
import * as db from '../../core/db'
import * as activity from '../../core/activity'
import { openaiModel } from '../../core/providers/openai'
import { openaiCost, openaiMaximum, usdToKopecks } from '../../core/providers/openai-cost'
import { researchSchemaForEvidence } from '../../core/policy'
import { dependentResearchIdea, researchEvidence } from '../fixtures/research'

const original = settings.config()
const args = {
  key: 'paid-check',
  system: 'shared rules',
  context: 'facts',
  schema: z.object({ text: z.string() }).strict(),
  maxTokens: 100,
}
const response = () => ({
  id: 'resp_test',
  status: 'completed',
  service_tier: 'default',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: '{"text":"Проверено"}' }] },
  ],
  usage: {
    input_tokens: 1000,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    output_tokens_details: { reasoning_tokens: 80 },
  },
})
beforeEach(() => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...original,
    MODEL_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-only-key',
    OPENAI_USD_KOPECKS: 12000,
  })
  vi.spyOn(db, 'query').mockResolvedValue([])
  vi.spyOn(activity, 'reportProgress').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('bounded cloud model', () => {
  it('prices cached input, cache writes and total output using integer money', () => {
    expect(openaiCost(1000, 100, 200, 300)).toBe(13950)
    expect(openaiCost(3, 0, 0, 3)).toBe(38)
    expect(openaiMaximum(1000, 100)).toBe(17500)
    expect(usdToKopecks(13950, 12000)).toBe(168)
    expect(() => openaiCost(10, 1, 9, 2)).toThrow('OPENAI_USAGE_INVALID')
    expect(() => openaiCost(100001, 1)).toThrow('OPENAI_USAGE_INVALID')
  })
  it('sends one bounded, stateless request and stores full usage before validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response()))))
    expect(await openaiModel(args)).toEqual({
      value: { text: 'Проверено' },
      cost: 168,
      microusd: 13950,
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(call[0]).toBe('https://api.openai.com/v1/responses')
    expect(call[1]?.redirect).toBe('error')
    const body = JSON.parse(call[1]!.body as string)
    expect(body).toMatchObject({
      instructions: 'shared rules',
      max_output_tokens: 100,
      store: false,
      service_tier: 'default',
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', strict: true } },
    })
    expect(body.tools).toBeUndefined()
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('actual_microusd'), [
      'paid-check',
      1000,
      100,
      200,
      300,
      80,
      13950,
      'resp_test',
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['incomplete', 'refusal', 'invalid'])(
    'preserves usage without retrying %s output',
    async (kind) => {
      const data = response()
      if (kind === 'incomplete') data.status = 'incomplete'
      else
        data.output = [
          {
            type: 'message',
            content: [
              kind === 'refusal'
                ? { type: 'refusal', text: 'no' }
                : { type: 'output_text', text: '{"wrong":true}' },
            ],
          },
        ]
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
      await expect(openaiModel(args)).rejects.toThrow(
        kind === 'incomplete'
          ? 'MODEL_OUTPUT_INCOMPLETE'
          : kind === 'refusal'
            ? 'MODEL_REFUSED'
            : 'MODEL_SCHEMA_INVALID',
      )
      expect(db.query).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledOnce()
    },
  )
  it('does not retry HTTP errors or expose the provider body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private provider diagnostics', { status: 429 })),
    )
    await expect(openaiModel(args)).rejects.toThrow('OPENAI_HTTP_429')
    expect(db.query).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects dependent sources without adding an automatic paid repair', async () => {
    const data = response()
    data.output = [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(dependentResearchIdea) }],
      },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await expect(
      openaiModel({ ...args, schema: researchSchemaForEvidence(researchEvidence, false) }),
    ).rejects.toThrow('MODEL_SCHEMA_INVALID')
    expect(fetch).toHaveBeenCalledOnce()
    expect(db.query).toHaveBeenCalledOnce()
  })
  it('rejects missing usage instead of reporting a free response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...response(), usage: null }))),
    )
    await expect(openaiModel(args)).rejects.toThrow('OPENAI_USAGE_INVALID')
    expect(db.query).not.toHaveBeenCalled()
  })
})
