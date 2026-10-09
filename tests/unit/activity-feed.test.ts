import { describe, expect, it } from 'vitest'
import {
  buildErrorText,
  cleanText,
  feedItems,
  feedKinds,
  plural,
  type FeedContext,
} from '../../core/activity-feed'

const ctx: FeedContext = {
  label: (id) => ({ a: 'А', b: 'Б', c: 'В', d: 'Г' })[id] ?? '?',
  orders: new Map([
    [
      'order-1042-0000',
      {
        name: 'Описание товара',
        number: '1042',
        priceKopecks: 49000,
        paidAt: '2026-10-08T10:00:00.000Z',
        deliveredAt: '2026-10-08T10:03:00.000Z',
      },
    ],
  ]),
  jobOrders: new Map([['job-1', 'order-1042-0000']]),
}
const at = '2026-10-08T10:00:00.000Z'
const event = (kind: string, data: Record<string, unknown>, message = '') => ({
  kind,
  data,
  message,
  created_at: at,
})
const text = (kind: string, data: Record<string, unknown>, message = '') =>
  feedItems(event(kind, data, message), ctx).map((item) => item.text)

describe('owner feed in human words', () => {
  it('writes the lines of product.md section 7', () => {
    expect(
      text('idea_found', { agentId: 'b', title: 'Описания изделий для мастеров', sources: 3 }),
    ).toEqual(['Разведчик Б нашёл идею: Описания изделий для мастеров. 3 источника.'])
    expect(
      text('idea_reviewed', {
        agentId: 'd',
        verdict: 'BLOCKED',
        reason: 'Бесплатных шаблонов полно.',
      }),
    ).toEqual(['Критик отклонил идею Разведчика Г: Бесплатных шаблонов полно.'])
    expect(
      text('idea_reviewed', { agentId: 'a', verdict: 'PASS', title: 'Ответы для студий' }),
    ).toEqual(['Критик принял идею Разведчика А: Ответы для студий.'])
    expect(
      text('product_published', { name: 'Ответы на частые вопросы', priceKopecks: 149000 }),
    ).toEqual([
      'Новый продукт на сайте: «Ответы на частые вопросы», 1 490 ₽. Пример прошёл проверку.',
    ])
    expect(text('idea_needs_human', { title: 'Выездная мойка окон' })).toEqual([
      'Идея «Выездная мойка окон» требует человека. Оставили в рейтинге с планом запуска.',
    ])
    expect(
      text('lead_draft_ready', { host: 'fl.ru', title: 'Нужно 30 описаний для Ozon' }),
    ).toEqual(['Найден возможный клиент на fl.ru: «Нужно 30 описаний для Ozon». Отклик готов.'])
    expect(text('test_payment_confirmed', { orderId: 'order-1042-0000' })).toEqual([
      'Заказ №1042 (тест): «Описание товара», 490 ₽.',
    ])
    expect(text('order_delivered', { orderId: 'order-1042-0000' })).toEqual([
      'Заказ №1042 готов за 3 минуты.',
    ])
    expect(text('job_error', { kind: 'fulfill', jobId: 'job-1', terminal: true })).toEqual([
      'Заказ №1042 не прошёл проверку. Посмотрите.',
    ])
    expect(
      text('evolution_rotated', {
        generation: 3,
        archived: [{ label: 'В', passed: 1, ideas: 6 }],
        children: [
          {
            label: 'А2',
            parentLabel: 'А',
            mutation: { param: 'focusCategories', from: ['marketplaces'], to: ['b2b'] },
          },
        ],
      }),
    ).toEqual([
      'Отбор поколения 3: Разведчик В уволен, 1 принятая идея из 6.',
      'Разведчик А скопирован. Копия А2 ищет в B2B, а не на маркетплейсах.',
    ])
    expect(text('evaluation', { decision: 'HOLD' })).toEqual([
      'Отбор по выручке пропущен: продаж пока нет.',
    ])
    expect(text('farm_daily_budget_wait', { dailyKopecks: 5000 })).toEqual([
      'Дневной лимит 50 ₽ исчерпан. Работа продолжится завтра.',
    ])
    expect(text('control', { mode: 'paused' })).toEqual([
      'Вы поставили ферму на паузу. Начатые заказы доделываем.',
    ])
  })

  it('never shows long dashes, arrows or decorative dots, even from model text', () => {
    const samples: [string, Record<string, unknown>, string?][] = [
      [
        'scouts_assigned',
        {},
        'Руководитель раздал задания: Разведчик А ищет в общепите, Б в хендмейде.',
      ],
      ['idea_found', { agentId: 'a', title: 'Идея — с тире → и стрелкой · точка', sources: 1 }],
      ['idea_reviewed', { agentId: 'a', verdict: 'REVISE', reason: 'Слабо — нужен сегмент →' }],
      ['idea_reviewed', { agentId: 'a', verdict: 'BLOCKED', reason: 'Нет — оснований' }],
      ['report_ready', { headline: 'Итог — хороший' }],
      ['evolution_hold', { reason: 'Разрыв — мал' }],
      ['product_created', { template: 'faq' }],
      ['product_updated', { template: 'faq' }],
      ['product_visibility', { name: 'X — Y', visibility: 'private' }],
      ['lead_search_completed', { saved: 5, drafted: 1 }],
      ['simulation', {}],
      ['settings_changed', {}],
      ['research_restarted', {}],
      ['evolution_requested', {}],
      ['agent_params_assigned', {}],
      ['control', { mode: 'emergency_stop' }],
      ['control', { mode: 'running' }],
      ['evaluation', { decision: 'CLOSED' }],
      ['job_error', { kind: 'scout', terminal: true }],
      ['job_error', { kind: 'research', terminal: true }],
    ]
    for (const [kind, data, message] of samples) {
      expect(feedKinds).toContain(kind)
      for (const line of text(kind, data, message ?? '')) {
        expect(line).not.toMatch(/[—–→←↗↑↓·]/)
        expect(line.length).toBeGreaterThan(5)
      }
    }
    expect(cleanText('А — Б → В · Г')).toBe('А, Б В, Г')
    expect(text('unknown_kind', {})).toEqual([])
    expect(text('job_error', { kind: 'scout', terminal: false })).toEqual([])
  })

  it('explains failed builds and late or replaced payments', () => {
    expect(feedKinds).toEqual(
      expect.arrayContaining([
        'idea_build_failed',
        'late_payment_received',
        'payment_hash_replaced',
      ]),
    )
    expect(
      text('idea_build_failed', {
        ideaId: 'i1',
        title: 'Меню для кафе',
        reason:
          'Сборка не прошла проверку: Контрольный пример: Текст обрывается на середине фразы. Допиши мысль до конца.',
      }),
    ).toEqual([
      'Сборка по идее «Меню для кафе» не прошла проверку: контрольный пример: Текст обрывается на середине фразы.',
    ])
    expect(text('late_payment_received', { orderId: 'order-1042-0000' })).toEqual([
      'Заказ №1042: перевод пришёл после срока счёта. Верните его вручную.',
    ])
    expect(text('payment_hash_replaced', { orderId: 'order-1042-0000' })).toEqual([
      'Заказ №1042: неверный номер перевода заменён найденным переводом.',
    ])
  })

  it('rewrites model instructions in a build failure as what went wrong', () => {
    expect(
      buildErrorText(
        'Сборка не прошла проверку: Страница продукта: Не используй длинное тире «—», пиши дефис или запятую.',
      ),
    ).toBe('Страница продукта: В тексте длинное тире.')
    expect(
      buildErrorText(
        'Сборка не прошла проверку: Латинское слово «site» в русском тексте. Замени его русским словом; служебные коды, статусы, названия полей и идентификаторы не пиши.',
      ),
    ).toBe('Латинское слово «site» в русском тексте.')
    expect(
      buildErrorText(
        'Сборка не прошла проверку: критик вернул гипотезу на доработку. Мало фактов.',
      ),
    ).toBe('Критик вернул продукт на доработку. Мало фактов.')
    expect(
      buildErrorText('Сборка не прошла проверку: Контрольный пример отклонён (REVISE): Мало.'),
    ).toBe('Контрольный пример вернули на доработку: Мало.')
    expect(
      buildErrorText(
        'Сборка не прошла проверку: страница продукта не прошла проверку текста и после исправления. Заголовок должен называть эту услугу («описания товаров»), а не другую идею: используй одно из слов «описани…», «карточ…». Остальные поля ответа оставь как были.',
      ),
    ).toBe(
      'Страница продукта не прошла проверку текста и после исправления. Заголовок страницы не называет услугу «описания товаров».',
    )
    expect(buildErrorText('')).toBe('Серверная проверка отклонила продукт.')
  })

  it('uses Russian plurals', () => {
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, 'идея', 'идеи', 'идей'))).toEqual([
      'идея',
      'идеи',
      'идей',
      'идей',
      'идея',
      'идеи',
      'идей',
    ])
  })
})
