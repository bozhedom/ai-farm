import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { localModel, localSearch, parseSearxResults } from '../../core/local-providers'
import * as activity from '../../core/activity'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('local providers', () => {
  it('filters unsafe and duplicate sources and removes markup', () => {
    const result = parseSearxResults({
      results: [
        { url: 'https://example.com/a', title: '<b>Пример</b>', content: 'Факты' },
        { url: 'https://example.com/a' },
        { url: 'https://localhost/secrets' },
        { url: 'javascript:alert(1)' },
      ],
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ title: 'Пример', demo: false })
  })
  it('stops a real search when independent sources are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }))))
    await expect(localSearch('example')).rejects.toThrow('SEARCH_INSUFFICIENT_SOURCES')
  })
  it('validates streamed JSON and reports only character counters', async () => {
    const progress = vi.spyOn(activity, 'reportProgress').mockResolvedValue()
    const chunks = ['{"text":', '"Проверенный ответ"}']
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            chunks.map((content) => JSON.stringify({ message: { content } })).join('\n') +
              '\n' +
              JSON.stringify({ done: true, done_reason: 'stop' }) +
              '\n',
          ),
        ),
    )
    const result = await localModel({
      key: 'test',
      system: 'rules',
      context: 'facts',
      schema: z.object({ text: z.string() }),
      maxTokens: 100,
    })
    expect(result.text).toBe('Проверенный ответ')
    expect(progress).toHaveBeenLastCalledWith('test', chunks.join('').length)
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({
      stream: true,
      think: false,
    })
  })
  it.each([
    [{ done: true, done_reason: 'length' }, 'MODEL_OUTPUT_INCOMPLETE'],
    [{ message: { content: '{"wrong":true}' }, done: true }, 'MODEL_SCHEMA_INVALID'],
    [{ message: { content: '{}' } }, 'MODEL_OUTPUT_INCOMPLETE'],
  ])('never treats incomplete or invalid answers as success', async (item, code) => {
    vi.spyOn(activity, 'reportProgress').mockResolvedValue()
    vi.spyOn(activity, 'reportValidation').mockResolvedValue()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(JSON.stringify(item) + '\n')),
    )
    await expect(
      localModel({
        key: 'test',
        system: 'rules',
        context: 'facts',
        schema: z.object({ text: z.string() }),
        maxTokens: 100,
      }),
    ).rejects.toThrow(code)
    expect(fetch).toHaveBeenCalledTimes(code === 'MODEL_SCHEMA_INVALID' ? 2 : 1)
  })
  it('repairs a schema error once and never publishes the first invalid candidate', async () => {
    vi.spyOn(activity, 'reportProgress').mockResolvedValue()
    const validation = vi.spyOn(activity, 'reportValidation').mockResolvedValue()
    const answer = (text: string) =>
      new Response(
        JSON.stringify({ message: { content: JSON.stringify({ text }) }, done: true }) + '\n',
      )
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(answer('x')).mockResolvedValueOnce(answer('Проверенный текст')),
    )
    expect(
      await localModel({
        key: 'repair',
        system: 'rules',
        context: 'facts',
        schema: z.object({ text: z.string().min(5) }),
        maxTokens: 100,
      }),
    ).toEqual({ text: 'Проверенный текст' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(validation).toHaveBeenCalledWith(
      'repair',
      [expect.objectContaining({ path: 'text', code: 'too_small' })],
      true,
    )
    const second = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string)
    expect(JSON.parse(second.messages[1].content).candidate).toBe('{"text":"x"}')
  })
})
