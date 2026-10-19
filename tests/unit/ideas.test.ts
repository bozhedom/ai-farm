import { describe, expect, it } from 'vitest'
import {
  decideStatus,
  findDuplicate,
  ideaFingerprint,
  ideaTokens,
  jaccard,
  rankScore,
} from '../../core/ideas'
import {
  ideaSchemaForEvidence,
  validateIdea,
  validateIdeaTopic,
  type Evidence,
} from '../../core/policy'
import { demoIdea, demoScoutEvidence } from '../../core/providers/demo'
import { taxonomyTopics } from '../../core/taxonomy'
import { defaultParams } from '../../core/agents'

const evidence: Evidence[] = [
  'https://example.com/a',
  'https://www.example.com/b',
  'https://example.org/c',
].map((url) => ({
  url,
  title: 'Источник',
  snippet: 'Фрагмент',
  observedAt: '2026-10-08',
  demo: false,
}))

const idea = {
  title: 'Описания карточек для продавцов',
  audience: 'Продавцы на маркетплейсах',
  problem: 'Продавцы тратят часы на карточки товаров.',
  demandSignals: [
    { claim: 'Заказы на описания на бирже', url: 'https://example.com/a' },
    { claim: 'Вопросы продавцов на форуме', url: 'https://example.org/c' },
  ],
  competitors: ['Фрилансеры'],
  revenueModel: 'service_fee',
  revenueNote: 'Оплата за каждый текст.',
  startupCostRub: 0,
  monthlyCostRub: 500,
  risks: ['Бесплатные шаблоны'],
  quickTest: 'Показать предложение 20 продавцам.',
  farmExecutable: true,
  suggestedTemplate: 'description',
  executionNote: 'Ферма пишет текст по данным.',
  launchPlanForHuman: [],
  uncertainties: ['Спрос не проверен.'],
}

describe('idea fingerprints and duplicates', () => {
  it('normalizes tokens: lower case, ё as е, words from four letters, no stop words', () => {
    expect(ideaTokens('Ёлочные игрушки для детей и взрослых, которые радуют')).toEqual([
      'елочные',
      'игрушки',
      'детей',
      'взрослых',
      'радуют',
    ])
    expect(ideaFingerprint('Описания карточек', 'продавцы карточек')).toBe(
      'карточек описания продавцы',
    )
  })

  it('marks exact and close repeats, the oldest original wins', () => {
    const base = ideaFingerprint(idea.title, idea.audience)
    const rows = [
      { id: 'b', fingerprint: 'совсем другая идея кафе', created_at: '2026-10-02' },
      { id: 'a', fingerprint: base, created_at: '2026-10-01' },
    ]
    expect(findDuplicate(base, rows)).toBe('a')
    const close = ideaFingerprint('Описания карточек для продавцов Ozon', idea.audience)
    expect(jaccard(close, base)).toBeGreaterThanOrEqual(0.6)
    expect(findDuplicate(close, [{ id: 'a', fingerprint: base }])).toBe('a')
    const other = ideaFingerprint('Выездная мойка окон', 'Жильцы многоэтажек')
    expect(findDuplicate(other, rows)).toBeNull()
  })
})

describe('deterministic rank and status', () => {
  it('weights critic, sources, farm, cost and demand into 0..100', () => {
    expect(
      rankScore({
        verdict: 'PASS',
        domains: 3,
        farmExecutable: true,
        startupCostRub: 0,
        demandSignals: 3,
      }),
    ).toBe(100)
    expect(
      rankScore({
        verdict: 'BLOCKED',
        domains: 0,
        farmExecutable: false,
        startupCostRub: 500000,
        demandSignals: 0,
      }),
    ).toBe(0)
    expect(
      rankScore({
        verdict: 'REVISE',
        domains: 2,
        farmExecutable: false,
        startupCostRub: 50000,
        demandSignals: 2,
      }),
    ).toBe(Math.round(20 + (20 * 2) / 3 + 7.5 + (10 * 2) / 3))
    const pass = rankScore({
      verdict: 'PASS',
      domains: 2,
      farmExecutable: false,
      startupCostRub: 0,
      demandSignals: 2,
    })
    const revise = rankScore({
      verdict: 'REVISE',
      domains: 2,
      farmExecutable: false,
      startupCostRub: 0,
      demandSignals: 2,
    })
    expect(pass - revise).toBe(20)
  })

  it('maps critic verdicts to statuses', () => {
    expect(decideStatus('PASS', true)).toBe('accepted')
    expect(decideStatus('PASS', false)).toBe('needs_human')
    expect(decideStatus('BLOCKED', true)).toBe('rejected')
    expect(decideStatus('REVISE', true)).toBe('new')
  })
})

describe('idea validation', () => {
  it('accepts sources only from the evidence and from two domains', () => {
    expect(validateIdea(idea, evidence, false, 'marketplaces-cards').title).toBe(idea.title)
    expect(() =>
      validateIdea(
        { ...idea, demandSignals: [{ claim: 'Выдумано', url: 'https://fake.example/x' }] },
        evidence,
        false,
        'marketplaces-cards',
      ),
    ).toThrow()
    expect(() =>
      validateIdea(
        {
          ...idea,
          demandSignals: [
            { claim: 'Один домен', url: 'https://example.com/a' },
            { claim: 'Тот же домен', url: 'https://www.example.com/b' },
          ],
        },
        evidence,
        false,
        'marketplaces-cards',
      ),
    ).toThrow()
    expect(() => validateIdea(idea, evidence, false, 'casino')).toThrow('POLICY_TOPIC_UNKNOWN')
  })

  it('refuses banned content, HTML and an executable idea without a template', () => {
    expect(() =>
      validateIdea(
        { ...idea, problem: 'Онлайн-казино для новичков и ставки.' },
        evidence,
        false,
        'it-docs',
      ),
    ).toThrow('POLICY_CONTENT_BLOCKED')
    expect(() =>
      validateIdea({ ...idea, title: '<b>Идея</b>' }, evidence, false, 'it-docs'),
    ).toThrow()
    expect(() =>
      ideaSchemaForEvidence(evidence, false).parse({ ...idea, suggestedTemplate: null }),
    ).toThrow()
    const human = validateIdea(
      { ...idea, farmExecutable: false, suggestedTemplate: 'faq' },
      evidence,
      false,
      'it-docs',
    )
    expect(human.suggestedTemplate).toBeNull()
  })

  it('blocks areas the master prompt excludes, whatever the critic says', () => {
    for (const title of [
      'Написание курсовых работ на заказ',
      'Платные прогнозы на ставки на спорт',
      'Эротический контент 18+ для взрослых',
      'Агитация для кандидатов в депутаты',
      'Перепродажа аккаунтов маркетплейсов',
      'Отзывы на заказ для карточек',
      'Сигналы для трейдинга криптовалют',
      'Холодные звонки по базе клиентов',
      'Фарм аирдропов с сотни кошельков',
      'Мультиаккаунты для наград тестовой сети',
      'Дропы для вывода денег',
      'Банковский счёт для агента без проверки',
      'Регистрация на чужой паспорт',
      'Обход KYC на бирже',
      'Обход санкций при выводе',
    ])
      expect(() => validateIdea({ ...idea, title }, evidence, false, 'it-docs'), title).toThrow(
        'POLICY_IDEA_TOPIC_BLOCKED',
      )
  })

  it('lets every taxonomy angle and demo idea through the stop list', () => {
    for (const topic of taxonomyTopics)
      for (const angle of topic.angles)
        expect(() =>
          validateIdeaTopic(`${angle.title}\n${topic.audience}\n${angle.problem}`),
        ).not.toThrow()
  })

  it('builds explicit demo ideas that pass the same validation', () => {
    for (const topic of taxonomyTopics) {
      const found = [...demoScoutEvidence(topic.queries[0]), ...demoScoutEvidence(topic.queries[1])]
      const value = demoIdea({
        topic,
        evidence: found,
        params: defaultParams(0),
        previousOnTopic: 0,
      })
      const checked = validateIdea(value, found, true, topic.id)
      expect(checked.uncertainties.join(' ')).toMatch(/Демо/)
      expect(found.every((item) => item.demo)).toBe(true)
    }
  })
})
