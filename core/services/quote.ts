import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const serviceQuoteTtlMs = 5 * 60 * 1000
const hash = z.string().regex(/^[0-9a-f]{64}$/)
export const serviceQuoteSchema = z
  .object({
    v: z.literal(1),
    id: z.uuid(),
    productId: z.uuid(),
    version: z.number().int().positive(),
    priceKopecks: z.number().int().positive().max(10000000),
    productDigest: hash,
    inputDigest: hash,
    paymentMode: z.enum(['sandbox', 'sepolia']),
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict()
export type ServiceQuote = z.infer<typeof serviceQuoteSchema>

export function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/** Deliberate domain separation: an order link or session cannot be used as a quote. */
function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(`service-quote:v1:${payload}`).digest()
}

export function signServiceQuote(value: ServiceQuote, secret: string) {
  const payload = Buffer.from(JSON.stringify(serviceQuoteSchema.parse(value))).toString('base64url')
  return `${payload}.${signature(payload, secret).toString('base64url')}`
}

/** Verification does not reject expiry: an already accepted request remains recoverable. */
export function readServiceQuote(token: string, secret: string): ServiceQuote {
  try {
    if (token.length > 2000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error()
    const [payload, encodedSignature] = token.split('.') as [string, string]
    const provided = Buffer.from(encodedSignature, 'base64url')
    if (
      provided.toString('base64url') !== encodedSignature ||
      !timingSafeEqual(signature(payload, secret), provided)
    )
      throw new Error()
    const data = Buffer.from(payload, 'base64url')
    if (data.toString('base64url') !== payload) throw new Error()
    return serviceQuoteSchema.parse(JSON.parse(data.toString('utf8')))
  } catch {
    throw new Error('SERVICE_QUOTE_INVALID')
  }
}

export function assertFreshServiceQuote(quote: ServiceQuote, now: number) {
  if (
    quote.issuedAt > now ||
    quote.expiresAt - quote.issuedAt !== serviceQuoteTtlMs ||
    quote.expiresAt <= now
  )
    throw new Error('SERVICE_QUOTE_EXPIRED')
}
