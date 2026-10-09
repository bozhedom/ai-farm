import { describe, expect, it } from 'vitest'
import {
  TextQualityError,
  headlineMatchesTemplate,
  polishOutput,
  productOfferSchemaFor,
  reportIssues,
  reportSchemaFor,
  replyDraftSchemaFor,
  resultLanguageIssue,
  softenDashes,
  textQualityIssue,
  validateOutput,
  validateProductOffer,
  validateReplyDraft,
  validateReport,
} from '../../core/policy'
import { demoProductOffer } from '../../core/providers/demo'
import { freeRetryAllowed } from '../../core/budget'
import { newestLeadDate, selectCustomerCandidates, staleLead } from '../../core/customer-discovery'

describe('text quality of model text people read', () => {
  // Real answers of a free model from the end-to-end QA run.
  it.each([
    ['Текст,free от оценочных эпитетов', 'free'],
    ["Описание, соответствующее шаблону 'description'", 'description'],
    ['Уже 7 ужеaccepted идей', 'ужеaccepted'],
    ['Две идеи needs_human ждут вас', 'needs'],
    ['Пауза HOLD-пауза по деньгам', 'HOLD-пауза'],
    ['Критик вернул идею REVISE', 'REVISE'],
    ['Смотрите идею a130e8da в списке', 'a130e8da'],
    ['Нужен человек для similarIdeas', 'similarIdeas'],
    ['Подготовим для job_post текст', 'job'],
  ])('rejects stray Latin in Russian text: %s', (text, word) => {
    expect(textQualityIssue(text)).toContain(word)
  })

  it('rejects other scripts, service marks, double dots, dashes and broken endings', () => {
    expect(textQualityIssue('Мы поможем 进一步 улучшить текст.')).toContain('другой письменности')
    expect(textQualityIssue('Подходит для сервиса..')).toContain('Две точки')
    expect(textQualityIssue('Итог — хороший')).toContain('тире')
    expect(textQualityIssue('Поле {текст} заполнено.')).toContain('Служебные')
    expect(textQualityIssue('Текст по системному промпту.')).toContain('Служебные')
    expect(textQualityIssue('Подходит для')).toContain('обрывается')
    expect(textQualityIssue('Состав:')).toContain('обрывается')
    expect(textQualityIssue('Пример «Линия')).toContain('Незакрытые')
  })

  it('keeps plain Russian with brands, formats and abbreviations', () => {
    for (const text of [
      'Карточки для Ozon и Wildberries без воды.',
      'Ответы на частые вопросы (FAQ) для сайта и SEO.',
      'Результат в PNG или PDF, формат A4, фото 10x15.',
      'Посты для Telegram и VK по вашему тексту.',
      'Опыт работы с Excel и CRM, XXI век.',
      'Без SEO-подборки и Wi-Fi роутеров.',
      'Только факты из вашего текста',
      'Всё готово…',
    ])
      expect(textQualityIssue(text), text).toBeNull()
    expect(textQualityIssue('Работаем с Tinkoff Касса', { allow: ['tinkoff'] })).toBeNull()
    expect(textQualityIssue('Translation into English 进一步', { foreign: true })).toBeNull()
  })

  it('softens long dashes without changing the meaning', () => {
    expect(softenDashes('Итог — хороший')).toBe('Итог - хороший')
    expect(softenDashes('Срок 3 — 5 дней, 10–15 штук')).toBe('Срок 3-5 дней, 10-15 штук')
    expect(softenDashes('— первый пункт\n— второй')).toBe('- первый пункт\n- второй')
  })
})

describe('product pages follow their service type', () => {
  it('ties the headline to the service', () => {
    expect(headlineMatchesTemplate('description', 'Цифровой чек-листа ухода после груминга')).toBe(
      false,
    )
    expect(headlineMatchesTemplate('description', 'Описания товаров для грумеров')).toBe(true)
    expect(headlineMatchesTemplate('landing', 'Текст страницы для детского кружка')).toBe(true)
    expect(headlineMatchesTemplate('landing', 'Детские кружки рисования')).toBe(false)
  })

  const offer = (page: Record<string, unknown>) => ({
    ...demoProductOffer('description'),
    page: {
      headline: 'Описания товаров для грумеров',
      forWhom: ['Груминг-салоны с интернет-магазином'],
      limits: ['Пишем только по вашим фактам.'],
      ...page,
    },
  })

  it('gives the model a repair hint with the field path', () => {
    const result = productOfferSchemaFor('description').safeParse(
      offer({
        headline: 'Цифровой чек-листа ухода после груминга',
        forWhom: ['Текст,free от оценочных эпитетов'],
      }),
    )
    expect(result.success).toBe(false)
    const paths = result.error!.issues.map((issue) => issue.path.join('.'))
    expect(paths).toEqual(expect.arrayContaining(['page.forWhom.0', 'page.headline']))
    expect(productOfferSchemaFor('description').safeParse(offer({})).success).toBe(true)
  })

  it('refuses a bad page on the server and keeps "what you get" server-owned', () => {
    expect(() =>
      validateProductOffer(offer({ limits: ['Не подходит для сервиса..'] }), 'description', true),
    ).toThrow(TextQualityError)
    const valid = validateProductOffer(
      offer({ youGet: ['соответствующее шаблону description'], headline: 'Описание — быстро' }),
      'description',
      true,
    )
    expect(valid.page).toEqual({
      headline: 'Описание - быстро',
      forWhom: ['Груминг-салоны с интернет-магазином'],
      limits: ['Пишем только по вашим фактам.'],
    })
  })
})

describe('manager report text', () => {
  const ids = ['a130e8da-0000-4000-8000-000000000001']
  const report = (patch: Record<string, unknown>) => ({
    headline: 'Четыре идеи, одна в работе',
    summary: 'Разведчики нашли четыре идеи, критик принял две. Одну ферма соберёт сама.',
    ideaComments: [{ ideaId: ids[0]!, comment: 'Хорошая идея для магазинов.' }],
    nextActions: ['Собрать продукт по лучшей идее.'],
    needsOwner: [],
    ...patch,
  })

  it('accepts a plain report and softens dashes', () => {
    expect(reportIssues(report({}), ids)).toEqual([])
    expect(validateReport(report({ headline: 'Итог — четыре идеи' }), ids).headline).toBe(
      'Итог - четыре идеи',
    )
  })

  it.each([
    [{ summary: 'Уже 7 ужеaccepted идей.' }, 'ужеaccepted'],
    [{ summary: 'Денежный отбор HOLD.' }, 'HOLD'],
    [{ ideaComments: [{ ideaId: ids[0], comment: 'Идея a130e8da лучшая.' }] }, 'идентификатор'],
    [{ needsOwner: ['Подтвердить цену продукта.'] }, 'Цены и лимиты'],
    [{ needsOwner: ['Увеличить дневной лимит.'] }, 'Цены и лимиты'],
    [{ nextActions: ['Цену стоит снизить до 300 рублей.'] }, 'Цены и лимиты'],
  ])('rejects %j', (patch, hint) => {
    const issues = reportIssues(report(patch), ids)
    expect(issues[0]?.message).toContain(hint)
    expect(reportSchemaFor(ids).safeParse(report(patch)).success).toBe(false)
    expect(() => validateReport(report(patch) as any, ids)).toThrow('REPORT_TEXT_REJECTED')
  })
})

describe('reply drafts', () => {
  const url = 'http://localhost:3210/services/description'
  const draft = `Здравствуйте! Увидели ваш запрос про карточки для Ozon. Мы делаем описания товаров по вашим характеристикам, без выдумок. Подробнее: ${url}`

  it('accepts Russian with the link and words the client used', () => {
    expect(validateReplyDraft(draft, url, 'Описание товара', 'Нужны карточки для Ozon')).toBe(draft)
    expect(
      replyDraftSchemaFor(url, 'Описание товара', 'Нужны тексты для Kaspi').safeParse({
        draft: draft.replace('Ozon', 'Kaspi'),
      }).success,
    ).toBe(true)
  })

  it('rejects Chinese words and stray Latin', () => {
    expect(() => validateReplyDraft(draft.replace('Мы делаем', 'Мы 进一步 делаем'), url)).toThrow(
      'POLICY_REPLY_TEXT',
    )
    const result = replyDraftSchemaFor(url).safeParse({
      draft: draft.replace('без выдумок', 'without выдумок'),
    })
    expect(result.success).toBe(false)
  })
})

describe('delivered results', () => {
  it('words an empty clarification section and softens dashes', () => {
    const text =
      'Заголовок:\nОцифровка рисунков — сканирование\n\nОписание:\nСрок — три дня.\n\nЧто уточнить:\n- Уточнений нет'
    const polished = polishOutput('landing', 'Студия оцифровывает рисунки.', text)
    expect(polished).toBe(
      'Заголовок:\nОцифровка рисунков - сканирование\n\nОписание:\nСрок - три дня.\n\nЧто уточнить:\nВсё нужное есть в исходном тексте.',
    )
    expect(() => validateOutput('landing', polished)).not.toThrow()
  })

  it('keeps real clarifications and the buyer’s own dashes', () => {
    const text = 'Шаги:\n1. Сохранить — PDF.\n\nЧто уточнить:\n- Уточнений нет по цвету\n- Срок'
    expect(polishOutput('instruction', 'Сохраните — PDF.', text)).toBe(text)
    expect(polishOutput('proofreading', 'x', 'Исправленный текст:\nИтог — да')).toContain('—')
  })
})

describe('language of results', () => {
  it('catches English words the buyer did not write, keeps theirs and translations', () => {
    // Real free-model samples: "доставка originals", "облачного catalogs".
    expect(
      resultLanguageIssue(
        'landing',
        'Срок три дня после получения оригиналов.',
        'Доставка originals',
      ),
    ).toContain('originals')
    expect(resultLanguageIssue('proposal', 'Облачный каталог', 'Ссылка на 进一步')).toContain(
      'письменности',
    )
    expect(
      resultLanguageIssue('description', 'Кружка Arcopal, 300 мл', 'Кружка Arcopal (тире)'),
    ).toBeNull()
    expect(
      resultLanguageIssue('translation', 'Язык перевода: английский\nТекст', 'Text'),
    ).toBeNull()
  })
})

describe('lead freshness', () => {
  const now = new Date('2026-10-09T12:00:00Z')
  it('finds the newest date in a snippet', () => {
    expect(newestLeadDate('Опубликовано 12.03.2018, обновлено 2019-05-01', now)).toEqual(
      new Date('2019-05-01T00:00:00Z'),
    )
    expect(newestLeadDate('Заказ от 3 мая 2022 года', now)).toEqual(
      new Date('2022-05-03T00:00:00Z'),
    )
    expect(newestLeadDate('Текст на 2000 знаков, бюджет 2025 руб', now)).toBeNull()
  })

  it('drops closed and old requests, keeps fresh and undated ones', () => {
    expect(staleLead('Нужен текст вакансии', 'Закрыт. Нужно написать текст вакансии', now)).toBe(
      'LEAD_CLOSED',
    )
    expect(staleLead('Нужны описания товаров', 'Требуется копирайтер, 2013 год', now)).toBe(
      'LEAD_TOO_OLD',
    )
    expect(staleLead('Нужны описания товаров', 'Опубликовано 01.10.2026', now)).toBeNull()
    expect(staleLead('Нужны описания товаров', 'Требуется копирайтер для карточек', now)).toBeNull()
    expect(staleLead('Закрытый клуб ищет автора', 'Нужен текст', now)).toBeNull()
    expect(staleLead('Написать инструкцию пользователя для дипломной', '', now)).toBe(
      'LEAD_EXCLUDED',
    )
    const evidence = [
      {
        url: 'https://fl.ru/projects/1/opisaniya',
        title: 'Нужны описания товаров для магазина',
        snippet: 'Требуется описание карточек товаров. Опубликовано 12.03.2018',
        observedAt: now.toISOString(),
        demo: false,
      },
    ]
    expect(selectCustomerCandidates('description', evidence, now)).toEqual([])
  })
})

describe('free providers may repeat an interrupted call', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const call = (patch: Record<string, unknown>) => ({
    provider: 'openrouter',
    status: 'uncertain',
    charged_kopecks: 0,
    charged_microusd: 0,
    actual_microusd: 0,
    error_code: 'OPENROUTER_HTTP_429',
    heartbeat_at: new Date(now - 10 * 60000),
    ...patch,
  })
  it('repeats a free call that ended without an answer or was abandoned', () => {
    expect(freeRetryAllowed(call({}), 'openrouter', 0, 0, now)).toBe('retry')
    expect(freeRetryAllowed(call({ status: 'pending' }), 'openrouter', 0, 0, now)).toBe('retry')
    expect(freeRetryAllowed(call({ provider: 'ollama' }), 'ollama', 0, 0, now)).toBe('retry')
    expect(
      freeRetryAllowed(
        call({ status: 'pending', heartbeat_at: new Date(now) }),
        'openrouter',
        0,
        0,
        now,
      ),
    ).toBe('wait')
  })
  it('never repeats paid or billed calls, or policy refusals', () => {
    expect(freeRetryAllowed(call({ provider: 'yandex' }), 'yandex', 100, 0, now)).toBe(false)
    expect(freeRetryAllowed(call({ provider: 'openai' }), 'openai', 0, 500, now)).toBe(false)
    expect(freeRetryAllowed(call({ actual_microusd: 3 }), 'openrouter', 0, 0, now)).toBe(false)
    expect(
      freeRetryAllowed(
        call({ error_code: 'OPENROUTER_COST_REVIEW_REQUIRED' }),
        'openrouter',
        0,
        0,
        now,
      ),
    ).toBe(false)
    expect(freeRetryAllowed(call({}), 'ollama', 0, 0, now)).toBe(false)
  })
})
