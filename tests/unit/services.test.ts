import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assertFreshServiceQuote,
  digest,
  readServiceQuote,
  serviceQuoteTtlMs,
  signServiceQuote,
  type ServiceQuote,
} from '../../core/services/quote'

const secret = 'service-quote-test-secret-over-forty-characters'
const issuedAt = Date.UTC(2026, 9, 13)
const quote: ServiceQuote = {
  v: 1,
  id: randomUUID(),
  productId: randomUUID(),
  version: 2,
  priceKopecks: 49000,
  productDigest: digest('product snapshot'),
  inputDigest: digest('source facts'),
  paymentMode: 'sandbox',
  issuedAt,
  expiresAt: issuedAt + serviceQuoteTtlMs,
}

describe('signed service offers', () => {
  it('binds exact input, version, price and mode without including the input itself', () => {
    const token = signServiceQuote(quote, secret)
    expect(readServiceQuote(token, secret)).toEqual(quote)
    expect(token).not.toContain('source facts')
    expect(digest('source facts ')).not.toBe(quote.inputDigest)
  })

  it('rejects price tampering and another server secret', () => {
    const token = signServiceQuote(quote, secret)
    const payload = Buffer.from(JSON.stringify({ ...quote, priceKopecks: 1 })).toString('base64url')
    expect(() => readServiceQuote(`${payload}.${token.split('.')[1]}`, secret)).toThrow(
      'SERVICE_QUOTE_INVALID',
    )
    expect(() => readServiceQuote(token, `${secret}-other`)).toThrow('SERVICE_QUOTE_INVALID')
  })

  it.each(['', 'a.b', 'a'.repeat(2001), '☃.bad', 'e30=.a'.repeat(10)])(
    'rejects malformed or oversized tokens',
    (token) => {
      expect(() => readServiceQuote(token, secret)).toThrow('SERVICE_QUOTE_INVALID')
    },
  )

  it('has an exact expiry boundary and forbids quotes issued in the future', () => {
    expect(() => assertFreshServiceQuote(quote, quote.expiresAt - 1)).not.toThrow()
    expect(() => assertFreshServiceQuote(quote, quote.expiresAt)).toThrow('SERVICE_QUOTE_EXPIRED')
    expect(() => assertFreshServiceQuote(quote, issuedAt - 1)).toThrow('SERVICE_QUOTE_EXPIRED')
    expect(() =>
      assertFreshServiceQuote({ ...quote, expiresAt: quote.expiresAt + 1 }, issuedAt),
    ).toThrow('SERVICE_QUOTE_EXPIRED')
  })

  it('allows authentic expired tokens to identify an already accepted request', () => {
    expect(readServiceQuote(signServiceQuote(quote, secret), secret).id).toBe(quote.id)
  })

  it('refuses fractional prices, non-test modes and unknown signed claims', () => {
    expect(() => signServiceQuote({ ...quote, priceKopecks: 49.99 }, secret)).toThrow()
    expect(() => signServiceQuote({ ...quote, paymentMode: 'mainnet' } as any, secret)).toThrow()
    expect(() => signServiceQuote({ ...quote, payTo: 'somewhere' } as any, secret)).toThrow()
  })
})
