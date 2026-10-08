import { describe, expect, it } from 'vitest'
import { ambiguousPath, indexablePage, rawPath } from '../../server/middleware/security'
import { peerClientIp } from '../../server/utils/client'
import { limitAddress } from '../../core/rate-limit'

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
    for (const path of ['/', '/terms', '/services/description'])
      expect(indexablePage(path)).toBe(true)
    for (const path of ['/order/abc', '/office', '/api/public/catalog', '/services/a/b'])
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
