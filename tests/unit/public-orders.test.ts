import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  deriveOrderToken,
  invoiceWei,
  orderNumber,
  orderTokenHash,
  orderTokenPattern,
  randomOrderToken,
} from '../../core/public-orders'
import { publicPaymentText, publicProgress } from '../../core/order-progress'
import { formatEth, priceList } from '../../core/storefront'

const secret = 'unit-test-secret-at-least-forty-characters-long'
const now = new Date('2026-10-08T12:00:00Z')
const later = '2026-10-08T13:00:00Z'
const live = { mode: 'running', worker_heartbeat: now }

describe('order links', () => {
  it('derives a 43-character link per request and stores only its sha256', () => {
    const a = deriveOrderToken('11111111-1111-4111-8111-111111111111', secret)
    const b = deriveOrderToken('22222222-2222-4222-8222-222222222222', secret)
    expect(a).toMatch(orderTokenPattern)
    expect(a).not.toBe(b)
    expect(deriveOrderToken('11111111-1111-4111-8111-111111111111', secret)).toBe(a)
    expect(deriveOrderToken('11111111-1111-4111-8111-111111111111', secret + 'x')).not.toBe(a)
    expect(orderTokenHash(a)).toBe(createHash('sha256').update(a).digest('hex'))
    expect(orderTokenHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(orderTokenHash(a)).not.toContain(a)
  })

  it('makes random replacement links of the same shape', () => {
    const tokens = new Set(Array.from({ length: 50 }, randomOrderToken))
    expect(tokens.size).toBe(50)
    for (const token of tokens) expect(token).toMatch(orderTokenPattern)
    expect(orderTokenPattern.test('short')).toBe(false)
    expect(orderTokenPattern.test('a'.repeat(42) + '/')).toBe(false)
  })

  it('shows a short order number without the full id', () => {
    expect(orderNumber('a7f3c2e1-0000-4000-8000-000000000000')).toBe('A7F3C2')
  })
})

describe('invoice amounts in test ETH', () => {
  it('rounds the ruble price down and adds the unique part in wei', () => {
    // 490 RUB at 300 000 RUB per test ETH = 0.0016333.. ETH, rounded to 0.001633 ETH.
    expect(invoiceWei(49000, 300000, 42n)).toBe(1633000000000042n)
    expect(formatEth(invoiceWei(49000, 300000, 42n))).toBe('0.001633000000000042')
    expect(invoiceWei(49000, 300000, 1n) % 10n ** 12n).toBe(1n)
  })

  it('never gives two invoices the same amount, across prices and sequence values', () => {
    const seen = new Set<bigint>()
    for (const price of priceList)
      for (let n = 1n; n <= 200n; n++) seen.add(invoiceWei(price, 300000, n))
    expect(seen.size).toBe(priceList.length * 200)
    // Owner orders use 10^14 + sequence; the shared sequence keeps them apart too.
    expect(seen.has(100000000000000n + 5n)).toBe(false)
  })

  it('refuses an exhausted sequence and keeps tiny prices above zero', () => {
    expect(() => invoiceWei(49000, 300000, 0n)).toThrow('INVOICE_SEQUENCE_EXHAUSTED')
    expect(() => invoiceWei(49000, 300000, 10n ** 12n)).toThrow('INVOICE_SEQUENCE_EXHAUSTED')
    expect(invoiceWei(29000, 1000000000, 7n)).toBe(10n ** 12n + 7n)
    expect(() => invoiceWei(49000, 0, 1n)).toThrow('RATE_INVALID')
  })
})

describe('buyer order status', () => {
  const base = {
    payment_mode: 'sepolia',
    required_confirmations: 3,
    confirmations: 0,
    expires_at: later,
    paid_at: null,
    delivered_at: null,
  }
  const view = (order: Record<string, any>, job: any = null, generated: any = null) =>
    publicProgress({ ...base, ...order }, job, generated, live, now)

  it('walks a crypto order from waiting to found, confirmed and done', () => {
    expect(view({ status: 'awaiting_payment' })).toMatchObject({
      status: 'awaiting_payment',
      message: { title: 'Ждём перевод' },
    })
    expect(view({ status: 'awaiting_payment', tx_hash: '0xabc' }).message.title).toBe(
      'Перевод отправлен',
    )
    expect(view({ status: 'awaiting_payment', tx_hash: '0xabc', confirmations: 1 })).toMatchObject({
      status: 'checking_payment',
      message: { title: 'Перевод найден, ждём подтверждений 1 из 3' },
    })
    expect(view({ status: 'paid', paid_at: now })).toMatchObject({
      status: 'in_progress',
      message: { title: 'Оплачено', tone: 'good' },
    })
    expect(view({ status: 'running', paid_at: now }, { status: 'running' })).toMatchObject({
      status: 'in_progress',
      message: { title: 'Пишем текст', detail: 'Обычно 2-5 минут. Страницу можно закрыть.' },
    })
    expect(
      publicProgress({ ...base, status: 'running', paid_at: now }, null, null, {}, now).message
        .detail,
    ).toBe('Немного задерживаемся. Страницу можно закрыть, текст появится здесь.')
    expect(
      view({ status: 'running', paid_at: now }, { status: 'running' }, now).message.title,
    ).toBe('Проверяем')
    const done = view({ status: 'delivered', paid_at: now, delivered_at: now }, null, now)
    expect(done.status).toBe('delivered')
    expect(done.message).toEqual({
      title: 'Готово',
      detail: 'Текст ниже. Его можно скопировать или скачать.',
      tone: 'good',
    })
    expect(done.steps.map((s) => [s.label, s.done])).toEqual([
      ['Оплачен', true],
      ['Пишем текст', true],
      ['Проверяем', true],
      ['Готово', true],
    ])
  })

  it('says sandbox orders wait for payment, retries and problems in plain words', () => {
    expect(view({ status: 'awaiting_payment', payment_mode: 'sandbox' }).message.title).toBe(
      'Ждём оплату',
    )
    expect(
      view({ status: 'paid', paid_at: now }, { status: 'queued', attempts: 1 }).message.detail,
    ).toBe('Не получилось с первого раза, пробуем ещё.')
    expect(view({ status: 'manual_review', paid_at: now })).toMatchObject({
      status: 'needs_attention',
      message: { title: 'Текст не прошёл нашу проверку' },
    })
    expect(view({ status: 'manual_review' }).message.title).toBe('Проверяем перевод вручную')
    expect(view({ status: 'expired' }).status).toBe('expired')
    expect(view({ status: 'closed' }).status).toBe('closed')
    expect(
      view({ status: 'awaiting_payment', expires_at: '2026-10-08T11:00:00Z' }).message.title,
    ).toBe('Срок оплаты истёк')
  })

  it('never shows codes, attempts or internal names to the buyer', () => {
    const texts = [
      view({ status: 'awaiting_payment', tx_hash: '0xabc', payment_error: 'WRONG_AMOUNT' }),
      view({ status: 'awaiting_payment', tx_hash: '0xabc', payment_error: 'RPC_UNAVAILABLE' }),
      view(
        { status: 'manual_review', paid_at: now },
        { status: 'failed', error_code: 'LEASE_LOST' },
      ),
      view({ status: 'paid', paid_at: now }, { status: 'queued', attempts: 2 }),
    ]
    expect(texts[0]!.message.detail).toBe(
      'Сумма перевода не совпадает со счётом. Переведите точную сумму.',
    )
    // A temporary node problem is not the buyer's problem: keep showing the waiting state.
    expect(texts[1]!.message.title).toBe('Перевод отправлен')
    const json = JSON.stringify(texts)
    for (const hidden of ['WRONG_AMOUNT', 'RPC_', 'LEASE', 'попытка', 'Альфа', 'стратег', 'хеш'])
      expect(json).not.toContain(hidden)
    expect(publicPaymentText('RPC_UNAVAILABLE')).toBeNull()
  })
})
