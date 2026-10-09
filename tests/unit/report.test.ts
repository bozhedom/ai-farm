import { describe, expect, it } from 'vitest'
import { reportSchemaFor, validateReport } from '../../core/policy'
import { reportPeriod } from '../../core/jobs/report'
import { demoReport } from '../../core/providers/demo'

const ranking = [
  {
    ideaId: '11111111-1111-4111-8111-111111111111',
    title: 'Описания карточек',
    status: 'accepted',
  },
  { ideaId: '22222222-2222-4222-8222-222222222222', title: 'Мойка окон', status: 'needs_human' },
]

describe('manager report', () => {
  it('lets the model comment only on ideas the server ranked', () => {
    const schema = reportSchemaFor(ranking.map((r) => r.ideaId))
    const value = {
      headline: 'День разведки',
      summary: 'Разведчики принесли четыре идеи, критик принял две.',
      ideaComments: [{ ideaId: ranking[0]!.ideaId, comment: 'Ферма может сделать сама.' }],
      nextActions: ['Собрать продукт.'],
      needsOwner: [],
    }
    expect(schema.parse(value)).toEqual(value)
    expect(() =>
      schema.parse({
        ...value,
        ideaComments: [{ ideaId: '33333333-3333-4333-8333-333333333333', comment: 'Чужая идея.' }],
      }),
    ).toThrow()
    expect(() => schema.parse({ ...value, ranking: [] })).toThrow()
    expect(() =>
      schema.parse({ ...value, summary: '<script>x</script> длинный текст тут' }),
    ).toThrow()
    expect(() => reportSchemaFor([]).parse(value)).toThrow()
    expect(reportSchemaFor([]).parse({ ...value, ideaComments: [] }).ideaComments).toEqual([])
  })

  it('checks the text for banned content', () => {
    expect(() =>
      validateReport({
        headline: 'Итог',
        summary: 'Предлагаем гарантированный доход каждому покупателю курса.',
        ideaComments: [],
        nextActions: [],
        needsOwner: [],
      }),
    ).toThrow('POLICY_CONTENT_BLOCKED')
  })

  it('builds an explicit demo report that passes the same schema', () => {
    const value = demoReport({ ideas: 4, passed: 2, accepted: 1, needsHuman: 1 }, ranking)
    expect(reportSchemaFor(ranking.map((r) => r.ideaId)).parse(value)).toEqual(value)
    expect(value.summary).toMatch(/^Демо-отчёт собран по цифрам, без вызова модели/)
    expect(value.headline).toBe('4 идеи, 1 в работу')
    expect(JSON.stringify(value)).not.toMatch(/[—→]/)
  })

  it('uses the UTC day of the key or the last seven days', () => {
    const now = new Date('2026-10-08T15:00:00Z')
    expect(reportPeriod('daily', 'report:daily:2026-10-08', now)).toEqual({
      start: new Date('2026-10-08T00:00:00Z'),
      end: now,
    })
    expect(reportPeriod('daily', 'report:daily:2026-10-07', now).end).toEqual(
      new Date('2026-10-08T00:00:00Z'),
    )
    expect(reportPeriod('weekly', 'report:weekly:1', now).start).toEqual(
      new Date('2026-10-01T15:00:00Z'),
    )
  })
})
