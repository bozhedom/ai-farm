import { describe, expect, it } from 'vitest'
import { prepareStepRequest, stepBudget } from '../../core/computer-use/model'
import { normalizeUrl } from '../../core/computer-use/policy'
import { computerUseTools } from '../../core/computer-use/tools'

describe('computer-use step request', () => {
  it('gives the model the visible page text and links', () => {
    const base = {
      taskId: 't',
      reservationId: 'r',
      goal: 'Найди открытые конкурсы для разработчиков',
      stepNo: 2,
      stepLimit: 30,
      history: [],
      page: { url: 'https://example.com/', title: 'Пример' },
      png: null,
      opportunities: 0,
    }
    const request = prepareStepRequest({
      ...base,
      reading: {
        text: 'Конкурс X, приз $5000, срок 30 ноября',
        links: [{ text: 'Подробнее', href: 'https://example.com/x' }],
      },
    })
    const sent = JSON.parse(request.text)
    expect(sent.page_text).toContain('приз $5000')
    expect(sent.links).toEqual([{ text: 'Подробнее', href: 'https://example.com/x' }])
    expect(request.system).toContain('note_opportunity')
    // Without a reading (an older VM agent) the request still has both fields, empty.
    expect(JSON.parse(prepareStepRequest(base).text)).toMatchObject({ page_text: '', links: [] })
  })
})

describe('computer-use step budget and visited pages', () => {
  it('flags wrap-up at three steps or fifteen percent left, and the final step', () => {
    expect(stepBudget(1, 30, 0, 2_000_000)).toEqual({
      stepsLeft: 30,
      costLeftPercent: 100,
      wrapUp: false,
      finalStep: false,
    })
    expect(stepBudget(28, 30, 0, 2_000_000)).toMatchObject({ stepsLeft: 3, wrapUp: true })
    expect(stepBudget(27, 30, 0, 2_000_000)).toMatchObject({ stepsLeft: 4, wrapUp: false })
    expect(stepBudget(5, 30, 1_700_000, 2_000_000)).toMatchObject({
      costLeftPercent: 15,
      wrapUp: true,
      finalStep: false,
    })
    expect(stepBudget(5, 30, 1_690_000, 2_000_000)).toMatchObject({
      costLeftPercent: 15,
      wrapUp: true,
    })
    expect(stepBudget(5, 30, 1_680_000, 2_000_000)).toMatchObject({
      costLeftPercent: 16,
      wrapUp: false,
    })
    // Overspent by a call that cost more than its share: never negative.
    expect(stepBudget(5, 30, 2_100_000, 2_000_000).costLeftPercent).toBe(0)
    expect(stepBudget(30, 30, 0, 0)).toEqual({
      stepsLeft: 1,
      costLeftPercent: null,
      wrapUp: true,
      finalStep: true,
    })
    expect(stepBudget(3, 30, 0, 2_000_000, true)).toMatchObject({ wrapUp: true, finalStep: true })
  })

  it('sends the budget, the visited list and the wrap-up rule; the estimate covers them', () => {
    const base = {
      taskId: 't',
      reservationId: 'r',
      goal: 'Найди открытые конкурсы для разработчиков',
      stepNo: 29,
      stepLimit: 30,
      history: [],
      page: { url: 'https://example.com/', title: 'Пример' },
      png: null,
      opportunities: 1,
    }
    const visited = [{ url: 'https://example.com/', visits: 2, navigates: 2 }]
    const request = prepareStepRequest({ ...base, budget: stepBudget(29, 30, 0, 0), visited })
    const sent = JSON.parse(request.text)
    expect(sent.budget).toEqual({
      steps_left: 2,
      cost_left_percent: null,
      wrap_up: true,
      final_step: false,
    })
    expect(sent.visited_urls).toEqual(visited)
    expect(request.system).toContain('budget.wrap_up')
    expect(request.system).toContain('budget.final_step')
    expect(request.system).toContain('COMPUTER_USE_LOOP_URL')
    expect(request.system).toContain('wait почти не нужен')
    expect(computerUseTools.find((t) => t.name === 'finish')!.description).toContain(
      'budget.final_step',
    )
    // The final flag only shortens the text: an estimate made before it is set still covers it.
    const last = prepareStepRequest({ ...base, budget: stepBudget(29, 30, 0, 0, true), visited })
    expect(Buffer.byteLength(last.text)).toBeLessThanOrEqual(Buffer.byteLength(request.text))
    expect(last.maximumMicrousd).toBeLessThanOrEqual(request.maximumMicrousd)
  })
})

describe('loop guard addresses', () => {
  it('normalises fragments, host case and trailing slashes but keeps the query', () => {
    expect(normalizeUrl('https://PLATI.example/catalog/#top')).toBe('https://plati.example/catalog')
    expect(normalizeUrl('https://plati.example/')).toBe('https://plati.example/')
    expect(normalizeUrl('https://plati.example')).toBe('https://plati.example/')
    expect(normalizeUrl('https://plati.example/catalog?page=2')).toBe(
      'https://plati.example/catalog?page=2',
    )
    // Spellings of one page: www, default port, empty query, parameter order, encoding.
    for (const same of [
      'https://www.plati.example/catalog?b=2&a=1',
      'https://plati.example:443/catalog/?a=1&b=2#x',
      'HTTPS://WWW.Plati.Example/catalog?a=1&b=2',
    ])
      expect(normalizeUrl(same)).toBe('https://plati.example/catalog?a=1&b=2')
    expect(normalizeUrl('https://www.fl.ru/projects/?')).toBe('https://fl.ru/projects')
    expect(normalizeUrl('http://fl.ru:80/')).toBe('http://fl.ru/')
    expect(normalizeUrl('https://fl.ru:8443/')).toBe('https://fl.ru:8443/')
    expect(
      normalizeUrl('https://fl.ru/%D0%BF%D0%BE%D0%B8%D1%81%D0%BA?q=%D1%82%D0%B5%D0%BA%D1%81%D1%82'),
    ).toBe('https://fl.ru/поиск?q=текст')
    expect(normalizeUrl('https://fl.ru/поиск?q=текст')).toBe('https://fl.ru/поиск?q=текст')
    // Different pages stay different: other values, an escaped separator, http and https.
    expect(normalizeUrl('https://fl.ru/p?page=2')).not.toBe(normalizeUrl('https://fl.ru/p?page=3'))
    expect(normalizeUrl('https://fl.ru/p?q=a%26b')).not.toBe(normalizeUrl('https://fl.ru/p?q=a&b'))
    expect(normalizeUrl('https://fl.ru/a%2Fb')).toBe('https://fl.ru/a%2Fb')
    expect(normalizeUrl('not a url')).toBe('not a url')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })
})
