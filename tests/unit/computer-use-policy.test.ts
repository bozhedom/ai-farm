import { describe, expect, it } from 'vitest'
import {
  classifyAction,
  isPrivateHost,
  validateGoal,
  type ElementInfo,
} from '../../core/computer-use/policy'
import { rotationGoals } from '../../core/computer-use/goals'

const page = (url: string, extra: Partial<{ focused: ElementInfo; target: ElementInfo }> = {}) => ({
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
  it('recognises private and local hosts', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '::1',
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
