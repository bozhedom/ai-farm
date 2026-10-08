import { describe, expect, it } from 'vitest'
import {
  clientKey,
  nextWindow,
  probeLimit,
  publicLimits,
  rateLimitKey,
} from '../../core/rate-limit'

const secret = 'unit-test-secret-at-least-forty-characters-long'

describe('public request limits', () => {
  it('keys counters by route and address without storing the address', () => {
    const key = rateLimitKey('createOrder', '203.0.113.7', secret)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain('203')
    expect(rateLimitKey('createOrder', '203.0.113.7', secret)).toBe(key)
    expect(rateLimitKey('order', '203.0.113.7', secret)).not.toBe(key)
    expect(rateLimitKey('createOrder', '203.0.113.8', secret)).not.toBe(key)
    expect(rateLimitKey('createOrder', '203.0.113.7', secret + 'x')).not.toBe(key)
    expect(clientKey('203.0.113.7', secret)).not.toBe(key)
  })

  it('counts inside a window and starts over once it has passed', () => {
    const t0 = new Date('2026-10-08T12:00:00Z')
    let state = nextWindow(null, t0, 60)
    expect(state).toEqual({ attempts: 1, windowStart: t0 })
    for (let i = 0; i < 119; i++) state = nextWindow(state, new Date(t0.getTime() + 1000), 60)
    expect(state.attempts).toBe(120)
    expect(nextWindow(state, new Date(t0.getTime() + 59999), 60).attempts).toBe(121)
    expect(nextWindow(state, new Date(t0.getTime() + 60000), 60)).toEqual({
      attempts: 1,
      windowStart: new Date(t0.getTime() + 60000),
    })
  })

  it('uses the limits from the public site plan', () => {
    expect(publicLimits).toEqual({
      catalog: { limit: 120, windowSeconds: 60 },
      service: { limit: 120, windowSeconds: 60 },
      createOrder: { limit: 10, windowSeconds: 3600 },
      order: { limit: 120, windowSeconds: 60 },
      pay: { limit: 20, windowSeconds: 3600 },
      result: { limit: 60, windowSeconds: 60 },
    })
    expect(probeLimit).toEqual({ limit: 50, windowSeconds: 600 })
  })
})
