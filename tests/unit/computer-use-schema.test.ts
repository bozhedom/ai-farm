import { describe, expect, it } from 'vitest'
import { browserActionNames, parseToolCall, VIEWPORT } from '../../core/computer-use/schema'
import { computerUseTools } from '../../core/computer-use/tools'
import { pngSize, solidPng } from '../../core/computer-use/png'

describe('computer-use tool calls are validated strictly on the server', () => {
  it('accepts every declared action with exact fields', () => {
    expect(parseToolCall('navigate', { url: 'https://example.com/a' })).toEqual({
      name: 'navigate',
      url: 'https://example.com/a',
    })
    expect(parseToolCall('click', { x: 0, y: VIEWPORT.height - 1 })).toMatchObject({
      name: 'click',
    })
    expect(parseToolCall('key', { key: 'PageDown' })).toEqual({ name: 'key', key: 'PageDown' })
    expect(parseToolCall('type', { text: 'гранты для разработчиков 2026, ё/Ü' })).toMatchObject({
      name: 'type',
    })
    expect(
      parseToolCall('finish', { report: 'Найдено два конкурса, оба требуют регистрации.' }),
    ).toMatchObject({ name: 'finish' })
    expect(
      parseToolCall('request_approval', {
        reason: 'Нужна регистрация на площадке.',
        action: { name: 'click', x: 1, y: 2 },
      }),
    ).toMatchObject({ name: 'request_approval', action: { name: 'click' } })
    expect(
      parseToolCall('note_opportunity', {
        title: 'Конкурс для агентов',
        url: 'https://example.com/c',
        summary: 'Приз за лучшего агента.',
        kind: 'bounty',
        requiresHuman: true,
        decision: 'human',
        fit: 55,
        ai_forbidden: false,
        estimated_value: { amount: 500000, currency: 'rub' },
        reason: 'Нужна регистрация.',
      }),
    ).toMatchObject({
      name: 'note_opportunity',
      kind: 'bounty',
      estimated_value: { amount: 500000, currency: 'RUB' },
    })
    expect(
      parseToolCall('draft_proposal', {
        opportunity_url: 'https://www.fl.ru/projects/1/',
        platform_domain: 'FL.ru',
        text: 'Здравствуйте! '.repeat(20),
        price_amount: 250000,
        price_currency: 'RUB',
      }),
    ).toMatchObject({ name: 'draft_proposal', platform_domain: 'fl.ru' })
    expect(
      parseToolCall('draft_proposal', {
        opportunity_url: 'https://www.fl.ru/projects/1/',
        platform_domain: 'fl.ru',
        text: 'Первый абзац.\nВторой абзац. '.repeat(12),
        price_amount: null,
        price_currency: null,
      }),
    ).toMatchObject({ name: 'draft_proposal', price_amount: null })
    expect(
      parseToolCall('type_stored', { id: '00000000-0000-4000-8000-000000000000' }),
    ).toMatchObject({ name: 'type_stored' })
    expect(
      parseToolCall('write_document', {
        title: 'Описание дивана',
        brief: 'Три абзаца о диване для каталога мебели, без цен.',
        kind: 'product_description',
      }),
    ).toMatchObject({ name: 'write_document', kind: 'product_description' })
    expect(parseToolCall('prepare_send', { domain: 'kwork.ru', purpose: 'reply' })).toEqual({
      name: 'prepare_send',
      domain: 'kwork.ru',
      purpose: 'reply',
    })
  })
  it('refuses unknown tools, extra fields, bad coordinates, schemes and markup', () => {
    for (const [name, args] of [
      ['shell', { command: 'ls' }],
      ['click', { x: VIEWPORT.width, y: 1 }],
      ['click', { x: 1, y: 1, button: 'right' }],
      ['navigate', { url: 'file:///etc/passwd' }],
      ['navigate', { url: 'javascript:alert(1)' }],
      ['key', { key: 'F12' }],
      // Playwright types "\n" as Enter and "\t" as Tab: only the `key` action may press those.
      ['type', { text: 'login\n' }],
      ['type', { text: 'a\tb' }],
      ['type', { text: 'a\rb' }],
      ['type', { text: 'x\u001b' }],
      ['wait', { ms: 60000 }],
      ['finish', { report: '<script>alert(1)</script>' }],
      [
        'note_opportunity',
        { title: 'x', url: 'https://a.b', summary: 's', kind: 'scam', requiresHuman: true },
      ],
      // Self-assessment fields are required; fit stays within 0-100.
      [
        'note_opportunity',
        {
          title: 'Задание',
          url: 'https://a.b',
          summary: 's',
          kind: 'freelance',
          requiresHuman: true,
        },
      ],
      [
        'note_opportunity',
        {
          title: 'Задание',
          url: 'https://a.b',
          summary: 's',
          kind: 'freelance',
          requiresHuman: true,
          decision: 'take',
          fit: 101,
          ai_forbidden: false,
          estimated_value: null,
          reason: 'r',
        },
      ],
      [
        'draft_proposal',
        {
          opportunity_url: 'https://fl.ru/p/1',
          platform_domain: 'fl.ru',
          text: 'коротко',
          price_amount: null,
          price_currency: null,
        },
      ],
      [
        'draft_proposal',
        {
          opportunity_url: 'https://fl.ru/p/1',
          platform_domain: 'fl.ru',
          text: 'a\tb '.repeat(60),
          price_amount: 10.5,
          price_currency: null,
        },
      ],
      ['type_stored', { id: 'not-a-uuid' }],
      ['write_document', { title: 'Текст', brief: 'мало', kind: 'article' }],
      ['prepare_send', { domain: 'fl.ru', purpose: 'proposal' }],
      ['insert_text', { text: 'прямой вызов запрещён' }],
      ['request_approval', { reason: 'r', action: { name: 'finish', report: 'x' } }],
      ['navigate', null],
      ['navigate', 'https://a.b'],
    ] as const)
      expect(() => parseToolCall(name, args), `${name}`).toThrow('COMPUTER_USE_TOOL_CALL_INVALID')
  })
  it('declares exactly the server tool list with strict JSON schemas', () => {
    const names = computerUseTools.map((tool) => tool.name)
    expect(names).toEqual([
      ...browserActionNames,
      'finish',
      'request_approval',
      'note_opportunity',
      'draft_proposal',
      'type_stored',
      'log_in',
      'write_document',
      'prepare_send',
    ])
    for (const tool of computerUseTools) {
      const parameters = tool.parameters as {
        properties: Record<string, unknown>
        required: string[]
      }
      expect(parameters.properties.name).toBeUndefined()
      expect(parameters.required).not.toContain('name')
      expect(parameters).toMatchObject({ type: 'object', additionalProperties: false })
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })
  it('produces valid PNG bytes for demo screenshots', () => {
    const png = solidPng(64, 40, [200, 200, 200])
    expect(pngSize(png)).toEqual({ width: 64, height: 40 })
    expect(pngSize(Buffer.from('not a png'))).toBeNull()
  })
})

describe('tool parameters sent to the model', () => {
  it('avoid schema features OpenAI strict functions reject', () => {
    const text = JSON.stringify(computerUseTools.map((tool) => tool.parameters))
    expect(text).not.toContain('"oneOf"')
    expect(text).not.toContain('"pattern"')
  })
})
