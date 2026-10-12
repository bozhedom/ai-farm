import { describe, expect, it } from 'vitest'
import { ambiguousPath, indexablePage, rawPath } from '../../server/middleware/security'
import { peerClientIp } from '../../server/utils/client'
import { limitAddress } from '../../core/rate-limit'
import { invoiceUnique, invoiceWei } from '../../core/public-orders'
import { requestKeyHash } from '../../core/orders'
import { publicProgress } from '../../core/order-progress'

describe('raw request paths', () => {
  it('refuses paths that URL parsing and the router read differently', () => {
    const check = (url: string) => {
      const raw = rawPath(url)
      return ambiguousPath(raw, new URL(raw, 'http://x').pathname)
    }
    for (const url of [
      '/api/orders/..\\public\\orders\\abc',
      '/api/public/orders/%2e%2e/x',
      '/api/public/orders/%2E%2e%2Fdashboard',
      '/api/public/orders/a%2fb',
      '/api/public/orders/a%5Cb',
      '/api/public/orders/a%5cb',
      '/api//dashboard',
      '/api/./dashboard',
      '/api/public/../dashboard',
      '/api/public/orders/..',
      '/API/public/orders/a%2Fb',
      '/x/../api/dashboard',
      '/order/..%2F..%2Fdashboard',
    ])
      expect([url, check(url)]).toEqual([url, true])
    for (const url of [
      '/api/public/catalog',
      '/api/public/orders/abc_DEF-123?x=../y',
      '/order/' + 'a'.repeat(43),
      '/services/description',
      '/_nuxt/entry.js',
      '/',
    ])
      expect([url, check(url)]).toEqual([url, false])
    expect(rawPath('/api/x?a=1#b')).toBe('/api/x')
  })

  it('lets search engines index only the storefront, services and terms', () => {
    for (const path of ['/storefront', '/terms', '/services/description'])
      expect(indexablePage(path)).toBe(true)
    for (const path of [
      '/',
      '/order/abc',
      '/office',
      '/office/trading',
      '/api/public/catalog',
      '/services/a/b',
    ])
      expect(indexablePage(path)).toBe(false)
  })
})

describe('buyer address for limits', () => {
  it('trusts X-Forwarded-For only from a private proxy with TRUST_PROXY', () => {
    expect(peerClientIp('172.18.0.5', '198.51.100.1, 203.0.113.9', true)).toBe('203.0.113.9')
    expect(peerClientIp('172.18.0.5', '203.0.113.9', false)).toBe('172.18.0.5')
    expect(peerClientIp('198.51.100.7', '203.0.113.9', true)).toBe('198.51.100.7')
    expect(peerClientIp(undefined, '203.0.113.9', true)).toBe('internal')
  })

  it('counts IPv6 by /64 and mapped IPv4 as IPv4', () => {
    expect(limitAddress('2001:db8:1:2::10')).toBe('2001:db8:1:2::/64')
    expect(limitAddress('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(limitAddress('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(limitAddress('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(limitAddress('::1')).toBe('0:0:0:0::/64')
    expect(limitAddress('::ffff:203.0.113.5')).toBe('203.0.113.5')
    expect(limitAddress('203.0.113.5')).toBe('203.0.113.5')
    expect(limitAddress('internal')).toBe('internal')
  })
})

describe('invoice amounts and keys', () => {
  it('keeps amounts unique per sequence value but not predictable', () => {
    expect(invoiceUnique(42n, 7)).toBe(42007n)
    expect(invoiceWei(49000, 300000, invoiceUnique(42n, 999))).toBe(1633000000042999n)
    const seen = new Set<bigint>()
    for (let n = 1n; n <= 500n; n++) seen.add(invoiceUnique(n))
    expect(seen.size).toBe(500)
    expect(() => invoiceUnique(0n)).toThrow('INVOICE_SEQUENCE_EXHAUSTED')
  })

  it('stores idempotency keys as a hash, case-insensitive like a uuid', () => {
    const key = '3f2c1a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b'
    expect(requestKeyHash(key)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(requestKeyHash(key.toUpperCase())).toBe(requestKeyHash(key))
    expect(requestKeyHash(key)).not.toContain(key)
  })
})

describe('buyer wording for held orders', () => {
  const base = {
    status: 'manual_review',
    payment_mode: 'sepolia',
    required_confirmations: 3,
    expires_at: new Date(),
  }
  it('does not promise work that will not start today', () => {
    const view = publicProgress(
      { ...base, paid_at: new Date(), payment_error: 'PAID_ORDERS_LIMIT' },
      null,
      null,
      {},
    )
    expect(view.message.title).toBe('Оплата получена, но сегодня не успеем')
    expect(view.steps[0]!.done).toBe(true)
    expect(view.steps[1]!.done).toBe(false)
  })
  it('explains a transfer claimed by another order', () => {
    const view = publicProgress({ ...base, payment_error: 'TX_ALREADY_USED' }, null, null, {})
    expect(view).toMatchObject({
      status: 'needs_attention',
      message: { title: 'Проверяем перевод вручную' },
    })
  })
})
