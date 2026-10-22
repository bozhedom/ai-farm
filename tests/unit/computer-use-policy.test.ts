import { describe, expect, it } from 'vitest'
import {
  classifyAction,
  forbiddenFindingReason,
  isPrivateHost,
  validateGoal,
  withoutNegatedMentions,
  type ElementInfo,
} from '../../core/computer-use/policy'
import { rotationGoals } from '../../core/computer-use/goals'

describe('finding topic check ignores negated mentions', () => {
  it('lets a finding say what a job excludes and still blocks positive mentions', () => {
    for (const text of [
      'Тексты для сайта клиники красоты, без политических кампаний и без казино.',
      'Копирайтинг для магазина, кроме азартных игр.',
      'Writing product pages, no gambling, without political campaigns.',
      'Статьи не связаны с политикой, только ремонт.',
    ])
      expect([text, forbiddenFindingReason(text)]).toEqual([text, ''])
    for (const text of [
      'Тексты для политической кампании кандидата.',
      'Не только казино, но и букмекеры.',
      'Без вложений на казино: обзоры слотов.',
      'Без опыта. Пишем обзоры казино.',
      'Обзоры казино, без опыта.',
    ])
      expect([text, forbiddenFindingReason(text)]).toEqual([text, 'POLICY_IDEA_TOPIC_BLOCKED'])
    // Schemes stay blocked when stated positively.
    expect(forbiddenFindingReason('Нужно обойти капчу на сайте.')).toBe(
      'COMPUTER_USE_SCHEME_BLOCKED',
    )
    const stripped = withoutNegatedMentions('Описания, без политических кампаний. Срок неделя.')
    expect(stripped).not.toMatch(/без|политическ|кампани/)
    expect(stripped).toContain('Описания')
    expect(stripped).toContain('Срок неделя')
  })
})

const page = (
  url: string,
  extra: Partial<{
    focused: ElementInfo
    target: ElementInfo
    typedBefore: string
    permit: { domain: string }
  }> = {},
) => ({
  url,
  title: 'Страница',
  ...extra,
})
const element = (partial: Partial<ElementInfo>): ElementInfo => ({
  tag: 'button',
  type: '',
  name: '',
  text: '',
  href: '',
  autocomplete: '',
  ...partial,
})

describe('computer-use policy: browsing runs, outward actions wait, fraud is refused', () => {
  it('allows reading, searching and scrolling on public pages', () => {
    expect(
      classifyAction({ name: 'navigate', url: 'https://habr.com/ru/' }, page('about:blank')),
    ).toEqual({ verdict: 'allow', reason: '' })
    expect(
      classifyAction({ name: 'scroll', x: 10, y: 10, deltaY: 500 }, page('https://habr.com')),
    ).toMatchObject({ verdict: 'allow' })
    expect(
      classifyAction(
        { name: 'type', text: 'гранты для разработчиков 2026' },
        page('https://ya.ru', { focused: element({ tag: 'input', type: 'search', name: 'q' }) }),
      ),
    ).toMatchObject({ verdict: 'allow' })
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://example.org/jobs', { target: element({ tag: 'a', text: 'Подробнее' }) }),
      ),
    ).toMatchObject({ verdict: 'allow' })
  })
  it('turns credentials, card data and payment sites into approval requests', () => {
    expect(
      classifyAction(
        { name: 'type', text: 'hunter2' },
        page('https://example.org/login', { focused: element({ tag: 'input', type: 'password' }) }),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_CREDENTIALS' })
    expect(
      classifyAction({ name: 'type', text: '4111 1111 1111 1111' }, page('https://shop.example')),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_DATA' })
    expect(
      classifyAction(
        { name: 'type', text: '123' },
        page('https://shop.example', {
          focused: element({ tag: 'input', name: 'cvv', autocomplete: 'cc-csc' }),
        }),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_SENSITIVE_FIELD' })
    expect(
      classifyAction(
        { name: 'navigate', url: 'https://www.paypal.com/signin' },
        page('about:blank'),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_SITE' })
    expect(
      classifyAction({ name: 'click', x: 5, y: 5 }, page('https://checkout.stripe.com/pay/x')),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_SITE' })
  })
  it('asks before publishing, registering, sending, accepting terms or transferring', () => {
    for (const text of [
      'Опубликовать',
      'Sign up',
      'Отправить сообщение',
      'I agree',
      'Withdraw',
      'Оформить заказ',
    ])
      expect(
        classifyAction(
          { name: 'click', x: 1, y: 1 },
          page('https://example.org/x', { target: element({ text }) }),
        ),
      ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_OUTWARD_ACTION' })
    expect(
      classifyAction(
        { name: 'key', key: 'Enter' },
        page('https://example.org/login', { focused: element({ tag: 'input', type: 'password' }) }),
      ),
    ).toMatchObject({ verdict: 'approval' })
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://example.org/register', { target: element({ type: 'submit' }) }),
      ),
    ).toMatchObject({ verdict: 'approval' })
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://example.org/x', {
          target: element({ tag: 'a', text: 'Купить', href: 'https://yoomoney.ru/checkout' }),
        }),
      ),
    ).toMatchObject({ verdict: 'approval' })
  })
  it('does not let Enter, pieces of a card number or a prefilled outward link skip approval', () => {
    const card = element({ tag: 'input', name: 'cardnumber', autocomplete: 'cc-number' })
    expect(
      classifyAction(
        { name: 'key', key: 'Enter' },
        page('https://shop.example/x', { focused: card }),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_SENSITIVE_FIELD' })
    expect(
      classifyAction(
        { name: 'key', key: 'Enter' },
        page('https://shop.example/x', { focused: element({ tag: 'input', name: 'otp' }) }),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_SENSITIVE_FIELD' })
    expect(
      classifyAction(
        { name: 'key', key: 'PageDown' },
        page('https://shop.example/x', { focused: card }),
      ),
    ).toMatchObject({ verdict: 'allow' })
    // Four pieces of a card number: the last piece completes it.
    const field = element({ tag: 'input', name: 'number' })
    expect(
      classifyAction(
        { name: 'type', text: '1111' },
        page('https://shop.example/x', { focused: field, typedBefore: '411111111111' }),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_DATA' })
    expect(
      classifyAction(
        { name: 'type', text: '1111' },
        page('https://shop.example/x', { focused: field, typedBefore: '41111111' }),
      ),
    ).toMatchObject({ verdict: 'allow' })
    expect(
      classifyAction(
        { name: 'navigate', url: 'https://site.example/send?to=user&text=hello' },
        page('https://site.example/'),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_OUTWARD_PAGE' })
    expect(
      classifyAction({ name: 'navigate', url: 'https://site.example/login' }, page('x')),
    ).toMatchObject({ verdict: 'allow' })
    expect(
      classifyAction({ name: 'navigate', url: 'https://site.example/jobs?page=2' }, page('x')),
    ).toMatchObject({ verdict: 'allow' })
  })
  it('refuses verification bypass, multi-accounting and private targets outright', () => {
    expect(
      classifyAction({ name: 'navigate', url: 'https://2captcha.com/' }, page('about:blank')),
    ).toEqual({ verdict: 'blocked', reason: 'COMPUTER_USE_HOST_BLOCKED' })
    expect(
      classifyAction({ name: 'navigate', url: 'http://169.254.169.254/latest' }, page('x')),
    ).toEqual({ verdict: 'blocked', reason: 'COMPUTER_USE_PRIVATE_NETWORK' })
    expect(
      classifyAction({ name: 'navigate', url: 'http://localhost:3210/office' }, page('x')),
    ).toEqual({ verdict: 'blocked', reason: 'COMPUTER_USE_PRIVATE_NETWORK' })
    expect(
      classifyAction(
        { name: 'type', text: 'купить аккаунты для мультиаккаунта' },
        page('https://a.b'),
      ),
    ).toEqual({ verdict: 'blocked', reason: 'COMPUTER_USE_SCHEME_BLOCKED' })
    expect(
      classifyAction({ name: 'type', text: 'kyc bypass service' }, page('https://a.b')),
    ).toMatchObject({ verdict: 'blocked' })
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://a.b', { target: element({ tag: 'a', href: 'https://anti-captcha.com/x' }) }),
      ),
    ).toEqual({ verdict: 'blocked', reason: 'COMPUTER_USE_HOST_BLOCKED' })
  })
  it('lets one send permit replace approval for an outward click on its platform only', () => {
    const send = element({ tag: 'button', type: 'submit', text: 'Отправить отклик' })
    const permit = { domain: 'fl.ru' }
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://www.fl.ru/projects/1/', { target: send, permit }),
      ),
    ).toEqual({ verdict: 'allow', reason: 'COMPUTER_USE_SEND_PERMIT' })
    expect(
      classifyAction(
        { name: 'key', key: 'Enter' },
        page('https://fl.ru/projects/1/', { focused: send, permit }),
      ),
    ).toEqual({ verdict: 'allow', reason: 'COMPUTER_USE_SEND_PERMIT' })
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://fl.ru/projects/1/apply', { target: element({ tag: 'button' }), permit }),
      ),
    ).toEqual({ verdict: 'allow', reason: 'COMPUTER_USE_SEND_PERMIT' })
    // Another platform, a look-alike host, no permit: the owner decides as before.
    for (const url of ['https://kwork.ru/x', 'https://fl.ru.evil.example/x', 'https://evilfl.ru/x'])
      expect(
        classifyAction({ name: 'click', x: 1, y: 1 }, page(url, { target: send, permit })),
      ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_OUTWARD_ACTION' })
    expect(
      classifyAction({ name: 'click', x: 1, y: 1 }, page('https://fl.ru/x', { target: send })),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_OUTWARD_ACTION' })
    // Money, credentials and code fields are never covered by a permit.
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://fl.ru/x', {
          target: element({ tag: 'a', text: 'Оплатить', href: 'https://yoomoney.ru/pay' }),
          permit,
        }),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_PAYMENT_SITE' })
    expect(
      classifyAction(
        { name: 'key', key: 'Enter' },
        page('https://fl.ru/login', {
          focused: element({ tag: 'input', type: 'password' }),
          permit,
        }),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_CREDENTIALS' })
    expect(
      classifyAction(
        { name: 'key', key: 'Enter' },
        page('https://fl.ru/x', { focused: element({ tag: 'input', name: 'otp' }), permit }),
      ),
    ).toEqual({ verdict: 'approval', reason: 'COMPUTER_USE_SENSITIVE_FIELD' })
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://fl.ru/x', { target: element({ text: 'купить аккаунт' }), permit }),
      ),
    ).toMatchObject({ verdict: 'blocked' })
    // A plain click is allowed anyway and does not need the permit.
    expect(
      classifyAction(
        { name: 'click', x: 1, y: 1 },
        page('https://fl.ru/x', { target: element({ tag: 'a', text: 'Подробнее' }), permit }),
      ),
    ).toEqual({ verdict: 'allow', reason: '' })
  })
  it('recognises private and local hosts', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '::1',
      '[::ffff:7f00:1]',
      '[::ffff:10.0.0.1]',
      'fe80::1',
      'ff02::1',
      '198.18.0.1',
      '0.0.0.0',
      'db',
      'x.local',
    ])
      expect([host, isPrivateHost(host)]).toEqual([host, true])
    for (const host of ['8.8.8.8', 'example.com', '172.32.0.1', '2606:4700::1111'])
      expect([host, isPrivateHost(host)]).toEqual([host, false])
  })
  it('validates goals with the same topic rules as ideas', () => {
    expect(validateGoal('  Найти открытые баунти для ИИ-агентов  ')).toBe(
      'Найти открытые баунти для ИИ-агентов',
    )
    expect(() => validateGoal('коротко')).toThrow('COMPUTER_USE_GOAL_LENGTH')
    expect(() => validateGoal('Найди способ обхода KYC на бирже для вывода')).toThrow(
      'COMPUTER_USE_SCHEME_BLOCKED',
    )
    expect(() => validateGoal('Найди, где купить готовые аккаунты на продажу')).toThrow()
    expect(() => validateGoal('Найди заказы на курсовые работы для студентов')).toThrow(
      'POLICY_IDEA_TOPIC_BLOCKED',
    )
    for (const goal of rotationGoals) expect(validateGoal(goal)).toBe(goal)
  })
})
