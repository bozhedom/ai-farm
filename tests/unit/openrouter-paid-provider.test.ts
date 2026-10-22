import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as settings from '../../core/config'
import * as db from '../../core/db'
import * as activity from '../../core/activity'
import { openaiModel } from '../../core/providers/openai'
import {
  ProviderRejectedError,
  providerErrorDetail,
  sanitizeErrorDetail,
} from '../../core/providers/rejection'

const original = settings.config()
const args = {
  key: 'paid-route',
  system: 'shared rules',
  context: 'facts',
  schema: z.object({ text: z.string() }).strict(),
  maxTokens: 100,
}
const response = (cost: number | string = 0.01395) => ({
  id: 'gen-test',
  choices: [{ finish_reason: 'stop', message: { content: '{"text":"Проверено"}' } }],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    completion_tokens_details: { reasoning_tokens: 80 },
    cost,
  },
})
beforeEach(() => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...original,
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: 'test-only-key',
    OPENAI_USD_KOPECKS: 12000,
  })
  vi.spyOn(db, 'query').mockResolvedValue([])
  vi.spyOn(activity, 'reportProgress').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('GPT-6 Astra through OpenRouter', () => {
  it('sends one bounded request at the published tariff and records usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response()))))
    expect(await openaiModel(args)).toEqual({
      value: { text: 'Проверено' },
      cost: 168,
      microusd: 13950,
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(call[0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(call[1]?.redirect).toBe('error')
    const body = JSON.parse(call[1]!.body as string)
    expect(body).toMatchObject({
      model: 'openai/gpt-6-astra',
      max_tokens: 100,
      stream: false,
      plugins: [],
      response_format: { type: 'json_schema', json_schema: { strict: true } },
      provider: {
        allow_fallbacks: false,
        data_collection: 'deny',
        max_price: { prompt: 10, completion: 50, request: 0 },
      },
    })
    expect(body.tools).toBeUndefined()
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('actual_microusd'), [
      'paid-route',
      1000,
      100,
      200,
      300,
      80,
      13950,
      'gen-test',
    ])
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('charges the OpenRouter bill when it is above the project tariff', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(response('0.02')))),
    )
    expect((await openaiModel(args)).microusd).toBe(20000)
  })
  it('keeps usage and does not retry invalid or incomplete answers', async () => {
    const data = response()
    data.choices[0]!.finish_reason = 'length'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await expect(openaiModel(args)).rejects.toThrow('MODEL_OUTPUT_INCOMPLETE')
    expect(db.query).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('refuses keys billed to the owner provider account', async () => {
    const data = { ...response(), usage: { ...response().usage, is_byok: true } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
    await expect(openaiModel(args)).rejects.toThrow('POLICY_OPENROUTER_BYOK_UNSUPPORTED')
  })
  it('marks only pre-generation rejections as not billed', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status })))
      const error = await openaiModel(args).catch((e) => e)
      expect(error).toBeInstanceOf(ProviderRejectedError)
      expect(error.message).toBe(`OPENROUTER_HTTP_${status}`)
    }
    for (const status of [402, 408, 429, 500, 502, 503]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status })))
      const error = await openaiModel(args).catch((e) => e)
      expect(error).not.toBeInstanceOf(ProviderRejectedError)
      expect(error.message).toBe(`OPENROUTER_HTTP_${status}`)
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    expect(await openaiModel(args).catch((e) => e)).not.toBeInstanceOf(ProviderRejectedError)
    expect(db.query).not.toHaveBeenCalled()
  })
  it('keeps the provider explanation of a rejection, bounded and without keys', async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: {
          raw: "Invalid schema for response_format 'farm_result': Missing 'youGet' in required.",
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 400 })))
    const error = await openaiModel(args).catch((e) => e)
    expect(error.detail).toBe(
      "code 400: Provider returned error: Invalid schema for response_format 'farm_result': Missing 'youGet' in required.",
    )
    expect(providerErrorDetail('not json')).toBeNull()
    expect(
      providerErrorDetail(JSON.stringify({ error: { message: 'слово '.repeat(200) } })),
    ).toHaveLength(300)
    expect(sanitizeErrorDetail('Bearer sk-or-v1-abcdefabcdef123 is invalid')).toBe(
      'Bearer [скрыто] is invalid',
    )
    expect(sanitizeErrorDetail('key sk-or-v1-abcdefabcdef123 is invalid')).toBe(
      'key [ключ скрыт] is invalid',
    )
  })
  it('does not retry HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota', { status: 402 })))
    await expect(openaiModel(args)).rejects.toThrow('OPENROUTER_HTTP_402')
    expect(db.query).not.toHaveBeenCalled()
  })
})
