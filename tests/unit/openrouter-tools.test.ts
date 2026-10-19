import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as settings from '../../core/config'
import * as db from '../../core/db'
import * as activity from '../../core/activity'
import { openrouterToolCall } from '../../core/providers/openrouter-tools'
import { computerUseTools } from '../../core/computer-use/tools'

const original = settings.config()
const args = {
  key: 'computer-use:task:1',
  system: 'shared rules',
  text: '{"goal":"найти баунти"}',
  imagePng: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  tools: [...computerUseTools],
  maxTokens: 700,
}
const response = (overrides: Record<string, unknown> = {}) => ({
  id: 'gen-tools',
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: 'Открываю поиск.',
        tool_calls: [
          {
            type: 'function',
            function: { name: 'navigate', arguments: '{"url":"https://example.com"}' },
          },
        ],
        ...overrides,
      },
    },
  ],
  usage: { prompt_tokens: 5000, completion_tokens: 60, cost: '0.0025' },
})
beforeEach(() => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...original,
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: 'test-only-key',
  })
  vi.spyOn(db, 'query').mockResolvedValue([])
  vi.spyOn(activity, 'reportProgress').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('computer-use tool calls through the paid OpenRouter route', () => {
  it('sends the screenshot and only the server tool list, then returns the raw call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response()))))
    const result = await openrouterToolCall(args)
    expect(result.value).toEqual({
      name: 'navigate',
      arguments: { url: 'https://example.com' },
      note: 'Открываю поиск.',
    })
    // Project tariff: 5000 input tokens at $10/M plus 60 output at $50/M, above the $0.0025 bill.
    expect(result.microusd).toBe(53000)
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)
    expect(body).toMatchObject({
      model: 'openai/gpt-6-astra',
      max_tokens: 700,
      tool_choice: 'required',
      parallel_tool_calls: false,
      plugins: [],
      provider: { allow_fallbacks: false, data_collection: 'deny' },
    })
    expect(body.response_format).toBeUndefined()
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(
      computerUseTools.map((t) => t.name),
    )
    expect(body.tools.every((t: { function: { strict: boolean } }) => t.function.strict)).toBe(true)
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/)
    expect(fetch).toHaveBeenCalledOnce()
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('actual_microusd'), [
      'computer-use:task:1',
      5000,
      60,
      0,
      0,
      null,
      53000,
      'gen-tools',
    ])
  })
  it('rejects answers without exactly one declared tool call and never retries', async () => {
    for (const data of [
      response({ tool_calls: [] }),
      response({
        tool_calls: [
          { type: 'function', function: { name: 'navigate', arguments: '{}' } },
          { type: 'function', function: { name: 'back', arguments: '{}' } },
        ],
      }),
      response({
        tool_calls: [{ type: 'function', function: { name: 'shell', arguments: '{}' } }],
      }),
      response({ tool_calls: [{ type: 'function', function: { name: 'back', arguments: '{' } }] }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))))
      await expect(openrouterToolCall(args)).rejects.toThrow('COMPUTER_USE_TOOL_CALL_INVALID')
      expect(fetch).toHaveBeenCalledOnce()
    }
    const cut = response()
    cut.choices[0]!.finish_reason = 'length'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(cut))))
    await expect(openrouterToolCall(args)).rejects.toThrow('MODEL_OUTPUT_INCOMPLETE')
  })
  it('keeps the HTTP error without recording usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 402 })))
    await expect(openrouterToolCall(args)).rejects.toThrow('OPENROUTER_HTTP_402')
    expect(db.query).not.toHaveBeenCalled()
  })
})
