import { z } from 'zod'

export const POLICY = Object.freeze({
  version: 'v1',
  maxProducts: 3,
  maxStrategies: 4,
  scheduledResearchPerDay: 1,
  manualResearchPerDay: 3,
  manualResearchCooldownMs: 300000,
  maxInputChars: 4000,
  maxOutputChars: 12000,
  maxAttempts: 3,
  chainId: 11155111,
  productionPayments: false,
})
export const templates = ['description', 'faq', 'social'] as const
export type Template = (typeof templates)[number]
export const templateSchema = z.enum(templates)
const plain = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !/[<>]/.test(s), 'HTML_FORBIDDEN')
export const productSchema = z
  .object({
    template: templateSchema,
    name: plain(4, 80),
    audience: plain(4, 200),
    promise: plain(15, 400),
    inputLabel: plain(4, 160),
  })
  .strict()
export type ProductSpec = z.infer<typeof productSchema>
export const researchSchema = z
  .object({
    title: plain(4, 120),
    problem: plain(10, 600),
    audience: plain(4, 200),
    hypothesis: plain(10, 700),
    counterargument: plain(10, 700),
    experiment: plain(10, 500),
    estimatedCostRub: z.number().min(0).max(1000000),
    sources: z.array(z.url()).max(6),
    uncertainties: z.array(plain(3, 300)).min(1).max(6),
  })
  .strict()
export const reviewSchema = z
  .object({
    verdict: z.enum(['PASS', 'REVISE', 'BLOCKED']),
    reason: plain(5, 700),
  })
  .strict()
export const outputSchema = z.object({ text: plain(30, POLICY.maxOutputChars) }).strict()
export type Evidence = {
  url: string
  title: string
  snippet: string
  observedAt: string
  demo: boolean
}

const forbidden =
  /(?:фишинг|пиратск|накрутк|казино|наркотик|порнограф|обход.{0,15}(?:блокиров|верификац)|гарантированн.{0,15}(?:доход|прибыл)|украденн|купить.{0,10}базу.{0,10}данных|phishing|malware|casino|guaranteed profit)/iu
const injection =
  /(?:ignore.{0,30}(?:previous|instructions)|игнорируй.{0,30}(?:инструкц|правил)|system\s*prompt|системн.{0,10}промпт|seed[- ]phrase|приватн.{0,10}ключ|<script|javascript:)/iu
export function validateContent(text: string) {
  if (forbidden.test(text)) throw new Error('POLICY_CONTENT_BLOCKED')
  if (injection.test(text)) throw new Error('UNTRUSTED_INSTRUCTION_BLOCKED')
}
export function validateInput(text: string) {
  if (text.trim().length < 30 || text.length > POLICY.maxInputChars) throw new Error('INPUT_LENGTH')
  validateContent(text)
}
export function validateProduct(value: unknown, expected: Template): ProductSpec {
  const spec = productSchema.parse(value)
  if (spec.template !== expected) throw new Error('TEMPLATE_MISMATCH')
  validateContent(Object.values(spec).join(' '))
  return spec
}
export function validateEvidence(sources: string[], evidence: Evidence[], demo: boolean) {
  const allowed = new Set(evidence.map((e) => e.url))
  if (sources.some((url) => !allowed.has(url))) throw new Error('FABRICATED_SOURCE')
  const domains = new Set(sources.map((url) => new URL(url).hostname.replace(/^www\./, '')))
  if (!demo && domains.size < 2) throw new Error('INSUFFICIENT_SOURCES')
}
export function safeSourceUrl(url: string) {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !/^(localhost|.*\.local|\[.*\]|\d+\.\d+\.\d+\.\d+)$/.test(u.hostname)
    )
  } catch {
    return false
  }
}
