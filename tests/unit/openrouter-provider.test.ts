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
  vi.spyOn(activity, 'reportValidation').mockResolvedValue()
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
      response_format: { type: 'json_object' },
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
  it('limits reasoning only when the owner configures an effort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response()))))
    await openrouterModel(args)
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).reasoning).toBeUndefined()
    vi.mocked(settings.config).mockReturnValue({
      ...settings.config(),
      OPENROUTER_REASONING_EFFORT: 'low',
    })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(response())))
    await openrouterModel(args)
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string)).toMatchObject({
      reasoning: { effort: 'low', exclude: true },
      provider: { require_parameters: true, allow_fallbacks: false },
    })
  })
  it.each([
    ['incomplete', 'MODEL_OUTPUT_INCOMPLETE'],
    ['refusal', 'MODEL_REFUSED'],
    ['tools', 'POLICY_MODEL_TOOLS_FORBIDDEN'],
    ['multiple', 'MODEL_OUTPUT_INCOMPLETE'],
    ['error', 'OPENROUTER_RESPONSE_ERROR'],
  ])('retains usage and never retries %s output', async (kind, error) => {
    const data = response()
    if (kind === 'incomplete') data.choices[0]!.finish_reason = 'length'
    if (kind === 'refusal') data.choices[0]!.finish_reason = 'content_filter'
    if (kind === 'tools') Object.assign(data.choices[0]!.message, { tool_calls: [{}] })
    if (kind === 'multiple') data.choices.push(data.choices[0]!)
    if (kind === 'error') Object.assign(data, { error: { message: 'private detail' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await expect(openrouterModel(args)).rejects.toThrow(error)
    expect(db.query).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('allows one zero-price format repair and adds its usage to the call', async () => {
    const invalid = response()
    invalid.choices[0]!.message.content = '{"wrong":true}'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(invalid)))
        .mockResolvedValueOnce(new Response(JSON.stringify(response()))),
    )
    expect((await openrouterModel(args)).value).toEqual({ text: 'Проверено' })
    expect(fetch).toHaveBeenCalledTimes(2)
    const repair = JSON.parse(
      JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string).messages[1].content,
    )
    expect(repair).toMatchObject({ candidate: '{"wrong":true}', original_context: args.context })
    expect(repair.validation_errors.length).toBeGreaterThan(0)
    expect(activity.reportValidation).toHaveBeenCalledWith(args.key, expect.any(Array), true)
    expect(vi.mocked(db.query).mock.calls[1]![1]?.slice(1, 7)).toEqual([
      2000,
      200,
      400,
      600,
      null,
      0,
    ])
  })
  it('preserves the source and reviewed result when repairing an invalid quality response', async () => {
    const context = JSON.stringify({
      input: 'Доставка не предоставляется.',
      output: 'Доставка включена.',
    })
    const invalid = response()
    invalid.choices[0]!.message.content =
      '{"type":"object","properties":{"verdict":{"type":"string"}}}'
    const corrected = response()
    corrected.choices[0]!.message.content =
      '{"verdict":"BLOCKED","reason":"Результат противоречит условию доставки."}'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(invalid)))
        .mockResolvedValueOnce(new Response(JSON.stringify(corrected))),
    )
    const result = await openrouterModel({
      ...args,
      context,
      schema: z
        .object({
          verdict: z.enum(['PASS', 'REVISE', 'BLOCKED']),
          reason: z.string().min(5),
        })
        .strict(),
    })
    expect(result.value.verdict).toBe('BLOCKED')
    const body = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string)
    const repair = JSON.parse(body.messages[1].content)
    expect(JSON.parse(repair.original_context)).toEqual(JSON.parse(context))
    expect(repair.candidate).toBe(invalid.choices[0]!.message.content)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('stops after one failed format repair', async () => {
    const invalid = () => {
      const data = response()
      data.choices[0]!.message.content = 'not json'
      return new Response(JSON.stringify(data))
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => invalid()),
    )
    await expect(openrouterModel(args)).rejects.toThrow('MODEL_SCHEMA_INVALID')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(activity.reportValidation).toHaveBeenLastCalledWith(args.key, expect.any(Array), false)
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
  it('keeps reasoning unknown when a provider counts it outside completion tokens', async () => {
    const data = response()
    data.usage.completion_tokens_details.reasoning_tokens = 239
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await openrouterModel(args)
    expect(vi.mocked(db.query).mock.calls[0]![1]?.slice(1, 6)).toEqual([1000, 100, 200, 300, null])
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
    await expect(openrouterModel({ ...args, maxTokens: 8001 })).rejects.toThrow(
      'OPENROUTER_OUTPUT_LIMIT_INVALID',
    )
    vi.mocked(settings.config).mockReturnValue({ ...settings.config(), OPENROUTER_API_KEY: '' })
    await expect(openrouterModel(args)).rejects.toThrow('OPENROUTER_CREDENTIALS_REQUIRED')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('reports an upstream error inside a successful HTTP response without usage', async () => {
    const data = { error: { message: 'provider unavailable', code: 502 } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await expect(openrouterModel(args)).rejects.toThrow('OPENROUTER_RESPONSE_ERROR')
    expect(db.query).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
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
