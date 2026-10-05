import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as settings from '../../core/config'
import * as db from '../../core/db'
import * as activity from '../../core/activity'
import { openrouterCost, openrouterModel } from '../../core/providers/openrouter'

const original = settings.config()
const args = {
  key: 'free-cloud-check',
  system: 'shared rules',
  context: 'facts',
  schema: z.object({ text: z.string() }).strict(),
  maxTokens: 100,
}
const response = () => ({
  id: 'gen_test',
  model: 'provider/model:free',
  choices: [
    {
      finish_reason: 'stop',
      message: { role: 'assistant', content: '{"text":"Проверено"}' },
    },
  ],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    completion_tokens_details: { reasoning_tokens: 80 },
    cost: 0,
  },
})
beforeEach(() => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...original,
    MODEL_PROVIDER: 'openrouter',
    OPENROUTER_MODEL: 'openrouter/free',
    OPENROUTER_API_KEY: 'test-only-key',
  })
  vi.spyOn(db, 'query').mockResolvedValue([])
  vi.spyOn(activity, 'reportProgress').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('free OpenRouter adapter', () => {
  it('accepts only explicit free model IDs and rejects routing shortcuts', () => {
    expect(settings.isFreeOpenrouterModel('openrouter/free')).toBe(true)
    expect(settings.isFreeOpenrouterModel('vendor/model-3.1:free')).toBe(true)
    for (const model of [
      'openrouter/auto',
      'vendor/model',
      'vendor/model:free:online',
      'vendor/model:free:nitro',
      'vendor/model:free,other/paid',
      'https://example.com/paid:free',
      ' vendor/model:free',
    ])
      expect(settings.isFreeOpenrouterModel(model)).toBe(false)
  })
  it('converts decimal costs upward to integer microdollars without float arithmetic', () => {
    expect(openrouterCost(0)).toBe(0)
    expect(openrouterCost('0.000001')).toBe(1)
    expect(openrouterCost('0.0000001')).toBe(1)
    expect(openrouterCost(1e-7)).toBe(1)
    expect(openrouterCost('1.2345678')).toBe(1234568)
    expect(openrouterCost('1e+2')).toBe(100000000)
    for (const value of [-1, NaN, Infinity, '', 'free', ' 0 ', '99999999999'])
      expect(() => openrouterCost(value)).toThrow('OPENROUTER_USAGE_INVALID')
  })
  it('sends one schema-constrained request with zero prices and no paid fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response()))))
    expect(await openrouterModel(args)).toEqual({
      value: { text: 'Проверено' },
      cost: 0,
      microusd: 0,
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init?.redirect).toBe('error')
    const body = JSON.parse(init!.body as string)
    expect(body).toMatchObject({
      model: 'openrouter/free',
      messages: [
        { role: 'system', content: 'shared rules' },
        { role: 'user', content: 'facts' },
      ],
      max_tokens: 100,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
      provider: {
        require_parameters: true,
        allow_fallbacks: false,
        data_collection: 'deny',
        max_price: { prompt: 0, completion: 0, request: 0 },
      },
      plugins: [],
    })
    expect(body.tools).toBeUndefined()
    expect(body.models).toBeUndefined()
    expect(body.fallbacks).toBeUndefined()
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined()
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('actual_microusd'), [
      'free-cloud-check',
      1000,
      100,
      200,
      300,
      80,
      0,
      'gen_test',
    ])
    expect(fetch).toHaveBeenCalledOnce()
  })
  it.each([
    ['incomplete', 'MODEL_OUTPUT_INCOMPLETE'],
    ['refusal', 'MODEL_REFUSED'],
    ['invalid', 'MODEL_SCHEMA_INVALID'],
    ['tools', 'POLICY_MODEL_TOOLS_FORBIDDEN'],
    ['multiple', 'MODEL_OUTPUT_INCOMPLETE'],
    ['error', 'OPENROUTER_RESPONSE_ERROR'],
  ])('retains usage and never retries %s output', async (kind, error) => {
    const data = response()
    if (kind === 'incomplete') data.choices[0]!.finish_reason = 'length'
    if (kind === 'refusal') data.choices[0]!.finish_reason = 'content_filter'
    if (kind === 'invalid') data.choices[0]!.message.content = '{"wrong":true}'
    if (kind === 'tools') Object.assign(data.choices[0]!.message, { tool_calls: [{}] })
    if (kind === 'multiple') data.choices.push(data.choices[0]!)
    if (kind === 'error') Object.assign(data, { error: { message: 'private detail' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await expect(openrouterModel(args)).rejects.toThrow(error)
    expect(db.query).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('retains a reported charge and blocks output instead of calling it free', async () => {
    const data = response()
    data.usage.cost = 0.0000001
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await expect(openrouterModel(args)).rejects.toThrow('OPENROUTER_COST_REVIEW_REQUIRED')
    expect(vi.mocked(db.query).mock.calls[0]![1]?.[6]).toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('keeps unreported cache and reasoning usage unknown', async () => {
    const data = {
      ...response(),
      usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await openrouterModel(args)
    expect(vi.mocked(db.query).mock.calls[0]![1]?.slice(3, 6)).toEqual([null, null, null])
  })
  it('rejects missing usage, impossible counts and missing price', async () => {
    for (const usage of [
      null,
      { ...response().usage, completion_tokens: 101 },
      { ...response().usage, prompt_tokens: 400 },
      { ...response().usage, cost: undefined },
      { ...response().usage, cost: null },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...response(), usage }))),
      )
      await expect(openrouterModel(args)).rejects.toThrow('OPENROUTER_USAGE_INVALID')
    }
    expect(db.query).not.toHaveBeenCalled()
  })
  it('rejects paid model configuration before making a request', async () => {
    vi.mocked(settings.config).mockReturnValue({
      ...settings.config(),
      OPENROUTER_MODEL: 'vendor/paid-model',
    })
    vi.stubGlobal('fetch', vi.fn())
    await expect(openrouterModel(args)).rejects.toThrow('OPENROUTER_FREE_MODEL_REQUIRED')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('requires a key and a bounded output before making a request', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(openrouterModel({ ...args, maxTokens: 2801 })).rejects.toThrow(
      'OPENROUTER_OUTPUT_LIMIT_INVALID',
    )
    vi.mocked(settings.config).mockReturnValue({ ...settings.config(), OPENROUTER_API_KEY: '' })
    await expect(openrouterModel(args)).rejects.toThrow('OPENROUTER_CREDENTIALS_REQUIRED')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not retry HTTP errors or expose provider diagnostics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private provider diagnostics', { status: 429 })),
    )
    await expect(openrouterModel(args)).rejects.toThrow('OPENROUTER_HTTP_429')
    expect(db.query).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('bounds response bytes and rejects malformed JSON without a retry', async () => {
    for (const [body, error] of [
      ['x'.repeat(2000001), 'PROVIDER_RESPONSE_TOO_LARGE'],
      ['not json', 'OPENROUTER_RESPONSE_INVALID'],
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
      await expect(openrouterModel(args)).rejects.toThrow(error)
      expect(fetch).toHaveBeenCalledOnce()
    }
    expect(db.query).not.toHaveBeenCalled()
  })
})
