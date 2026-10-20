import { describe, expect, it } from 'vitest'
import { prepareStepRequest } from '../../core/computer-use/model'

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
