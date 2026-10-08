import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { localModel, localSearch, parseSearxResults } from '../../core/providers/local'
import * as activity from '../../core/activity'
import { researchSchemaForEvidence } from '../../core/policy'
import { dependentResearchIdea, researchEvidence } from '../fixtures/research'

beforeEach(() => vi.spyOn(activity, 'reportUsage').mockResolvedValue())

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('local providers', () => {
  it.each([true, false])(
    'allows exactly one local repair for dependent sources (corrected: %s)',
    async (corrected) => {
      vi.spyOn(activity, 'reportProgress').mockResolvedValue()
      const validation = vi.spyOn(activity, 'reportValidation').mockResolvedValue()
      const valid = {
        ...dependentResearchIdea,
        sources: [researchEvidence[0]!.url, researchEvidence[2]!.url],
      }
      const answer = (idea: typeof dependentResearchIdea) =>
        new Response(
          JSON.stringify({
            message: { content: JSON.stringify(idea) },
            done: true,
            prompt_eval_count: 150,
            eval_count: 100,
          }) + '\n',
        )
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(answer(dependentResearchIdea))
          .mockResolvedValueOnce(answer(corrected ? valid : dependentResearchIdea)),
      )
      const context = JSON.stringify({ evidence: researchEvidence, task: 'Проверь гипотезу.' })
      const result = localModel({
        key: 'source-repair',
        system: 'shared rules',
        context,
        schema: researchSchemaForEvidence(researchEvidence, false),
        maxTokens: 1000,
      })
      if (corrected) await expect(result).resolves.toEqual(valid)
      else await expect(result).rejects.toThrow('MODEL_SCHEMA_INVALID')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(activity.reportUsage).toHaveBeenCalledTimes(2)
      expect(validation).toHaveBeenNthCalledWith(
        1,
        'source-repair',
        [expect.objectContaining({ path: 'sources', code: 'custom' })],
        true,
      )
      if (!corrected)
        expect(validation).toHaveBeenNthCalledWith(
          2,
          'source-repair',
          [expect.objectContaining({ path: 'sources', code: 'custom' })],
          false,
        )
      const second = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string)
      const repair = JSON.parse(second.messages[1].content)
      expect(repair.original_context).toBe(context)
      expect(JSON.parse(repair.candidate)).toEqual(dependentResearchIdea)
      expect(repair.task).toContain('Состав sources можно изменить')
    },
  )
  it('does not repair a monetary estimate to fit a schema limit', async () => {
    vi.spyOn(activity, 'reportProgress').mockResolvedValue()
    const validation = vi.spyOn(activity, 'reportValidation').mockResolvedValue()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ message: { content: '{"estimatedCostRub":4000}' }, done: true }) +
                '\n',
            ),
        ),
    )
    await expect(
      localModel({
        key: 'cost',
        system: 'rules',
        context: 'facts',
        schema: z.object({ estimatedCostRub: z.number().max(40) }),
        maxTokens: 100,
      }),
    ).rejects.toThrow('MODEL_SCHEMA_INVALID')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(validation).toHaveBeenLastCalledWith('cost', expect.any(Array), false)
  })
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
      vi.fn().mockResolvedValue(
        new Response(
          chunks.map((content) => JSON.stringify({ message: { content } })).join('\n') +
            '\n' +
            JSON.stringify({
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 108,
              eval_count: 17,
            }) +
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
    expect(activity.reportUsage).toHaveBeenCalledWith('test', 108, 17)
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
        JSON.stringify({
          message: { content: JSON.stringify({ text }) },
          done: true,
          prompt_eval_count: 50,
          eval_count: 10,
        }) + '\n',
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
    expect(activity.reportUsage).toHaveBeenCalledTimes(2)
    expect(validation).toHaveBeenCalledWith(
      'repair',
      [expect.objectContaining({ path: 'text', code: 'too_small' })],
      true,
    )
    const second = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string)
    expect(JSON.parse(second.messages[1].content)).toMatchObject({
      candidate: '{"text":"x"}',
      original_context: 'facts',
    })
  })
})
