import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as activity from '../../core/activity'
import { localModel } from '../../core/providers/local'
import { outputSchemaForTemplate, validateOutput } from '../../core/policy'
import { generationContext } from '../../core/jobs/text-context'
import { recipes } from '../../core/templates'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const correct =
  'Кратко:\nКоманда готовит каталог.\n\nКлючевые факты:\n- Дата выпуска не утверждена.'
const malformed = 'Команда готовит каталог. Дата выпуска не утверждена.'
const answer = (text: string) =>
  new Response(
    JSON.stringify({
      message: { content: JSON.stringify({ text }) },
      done: true,
      prompt_eval_count: 100,
      eval_count: 40,
    }) + '\n',
  )

it.each([true, false])(
  'repairs a promised output format at most once (corrected: %s)',
  async (fixed) => {
    vi.spyOn(activity, 'reportUsage').mockResolvedValue()
    vi.spyOn(activity, 'reportProgress').mockResolvedValue()
    vi.spyOn(activity, 'reportValidation').mockResolvedValue()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(answer(malformed))
        .mockResolvedValueOnce(answer(fixed ? correct : malformed)),
    )
    const context = JSON.stringify(
      generationContext(
        { template: 'summary', promise: recipes.summary.delivery },
        malformed,
        'Кратко, только исходные факты.',
      ),
    )
    const schema = outputSchemaForTemplate('summary')
    expect(z.toJSONSchema(schema).type).toBe('object')
    const result = localModel({
      key: 'output-format-repair',
      system: 'rules',
      context,
      schema,
      maxTokens: 1000,
    })
    if (fixed) {
      await expect(result).resolves.toEqual({ text: correct })
      expect(() => validateOutput('summary', correct)).not.toThrow()
    } else await expect(result).rejects.toThrow('MODEL_SCHEMA_INVALID')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(activity.reportUsage).toHaveBeenCalledTimes(2)
    const repair = JSON.parse(
      JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string).messages[1].content,
    )
    expect(repair.original_context).toBe(context)
    expect(repair.validation_errors[0]).toMatchObject({ path: 'text', code: 'custom' })
    expect(repair.validation_errors[0].message).toContain('Ключевые факты:')
  },
)

it('does not ask a model to disguise content blocked by the server policy', async () => {
  vi.spyOn(activity, 'reportUsage').mockResolvedValue()
  vi.spyOn(activity, 'reportProgress').mockResolvedValue()
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        answer('Подготовим массовую рассылку незнакомым людям с рекламным предложением.'),
      ),
  )
  await expect(
    localModel({
      key: 'blocked-content',
      system: 'rules',
      context: 'original facts',
      schema: outputSchemaForTemplate('summary'),
      maxTokens: 1000,
    }),
  ).rejects.toThrow('POLICY_CONTENT_BLOCKED')
  expect(fetch).toHaveBeenCalledTimes(1)
})
