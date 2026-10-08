import type { PaymentMode, ProductPage } from './contracts/common'
import type { PublicService } from './contracts/public'
import type { ServiceDefinition, ServiceTemplate } from './service-catalog'

/**
 * Server-owned storefront rules. Models pick a `priceId` from this list; they never invent a
 * price. Amounts are integer kopecks. This module has no database or config access, so the
 * public site, the farm and tests can share it.
 */
export const priceList = Object.freeze([29000, 49000, 69000, 79000, 89000, 149000, 199000] as const)
export type PriceKopecks = (typeof priceList)[number]
export const priceIds = [
  'rub290',
  'rub490',
  'rub690',
  'rub790',
  'rub890',
  'rub1490',
  'rub1990',
] as const
export type PriceId = (typeof priceIds)[number]

export function priceKopecksFor(id: string): PriceKopecks {
  const index = (priceIds as readonly string[]).indexOf(id)
  if (index < 0) throw new Error('PRICE_UNKNOWN')
  return priceList[index]!
}
export function priceIdFor(kopecks: number): PriceId | null {
  const index = (priceList as readonly number[]).indexOf(kopecks)
  return index < 0 ? null : priceIds[index]!
}

/** Starting price per service type until research picks another listed price. */
export const defaultPriceKopecks: Readonly<Record<ServiceTemplate, PriceKopecks>> = Object.freeze({
  description: 49000,
  faq: 149000,
  social: 79000,
  proofreading: 49000,
  translation: 89000,
  summary: 49000,
  email: 29000,
  landing: 199000,
  proposal: 149000,
  instruction: 79000,
  lesson: 79000,
  job_post: 69000,
})

export const publicSlugPattern = /^[a-z0-9][a-z0-9-]{1,60}$/
/** Same rule as `db/014-foundation.sql`: one product per template, underscores become hyphens. */
export function publicSlug(template: ServiceTemplate | string) {
  const slug = template.toLowerCase().replace(/_/g, '-')
  if (!publicSlugPattern.test(slug)) throw new Error('SLUG_INVALID')
  return slug
}

/** 149000 -> "1 490 ₽", 12350 -> "123,50 ₽". Integer arithmetic only, no floats. */
export function formatRub(kopecks: number) {
  if (!Number.isSafeInteger(kopecks) || kopecks < 0) throw new Error('MONEY_INVALID')
  const rubles = String(Math.trunc(kopecks / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const rest = kopecks % 100
  return `${rubles}${rest ? ',' + String(rest).padStart(2, '0') : ''} ₽`
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() && !/[<>]/.test(value)
    ? value.trim().slice(0, max)
    : undefined
const list = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item) => text(item, 300))
        .filter((item): item is string => !!item)
        .slice(0, 8)
    : undefined

/** Keeps only known plain-text fields of a stored page. Unknown keys never reach buyers. */
export function productPage(value: unknown): ProductPage {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const page: ProductPage = {}
  const headline = text(source.headline, 160)
  if (headline) page.headline = headline
  for (const key of ['forWhom', 'youGet', 'limits'] as const) {
    const items = list(source[key])
    if (items?.length) page[key] = items
  }
  return page
}

export type PublicProductRow = {
  slug: string
  version: number
  price_kopecks: number
  page: unknown
  is_demo: boolean
  spec: { name?: string; audience?: string; promise?: string; inputLabel?: string }
}

export const publicInputLimit = 4000

/** Buyer-facing view of a product. No ids, strategies, costs, checks or model details. */
export function publicServiceProjection(
  row: PublicProductRow,
  service: ServiceDefinition,
  options: { paymentMode?: PaymentMode; inputLimit?: number } = {},
): PublicService {
  return {
    slug: row.slug,
    name: row.spec.name || service.label,
    category: service.category,
    audience: row.spec.audience || service.audience,
    promise: row.spec.promise || service.delivery,
    inputLabel: row.spec.inputLabel || service.inputLabel,
    example: service.example,
    inputLimit: options.inputLimit ?? publicInputLimit,
    priceKopecks: row.price_kopecks,
    currency: options.paymentMode === 'sepolia' ? 'TEST_ETH' : 'RUB',
    version: row.version,
    isDemo: row.is_demo,
    page: productPage(row.page),
  }
}

export const sepoliaChainId = 11155111
const weiPerEth = 10n ** 18n

/**
 * Test ETH for a ruble price at the conditional rate `TEST_ETH_RUB_RATE` (whole rubles per
 * 1 test ETH). Not a market rate. Rounds down; the caller adds its unique invoice wei.
 */
export function kopecksToWei(kopecks: number, rubPerEth: number): bigint {
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) throw new Error('MONEY_INVALID')
  if (!Number.isSafeInteger(rubPerEth) || rubPerEth <= 0) throw new Error('RATE_INVALID')
  return (BigInt(kopecks) * weiPerEth) / (BigInt(rubPerEth) * 100n)
}

/** 1500000000000000n -> "0.0015". Exact decimal string, no trailing zeros. */
export function formatEth(wei: bigint | string) {
  const value = BigInt(wei)
  if (value < 0n) throw new Error('MONEY_INVALID')
  const fraction = (value % weiPerEth).toString().padStart(18, '0').replace(/0+$/, '')
  return `${value / weiPerEth}${fraction ? '.' + fraction : ''}`
}

/** EIP-681 transfer link for wallets and QR codes. Sepolia only. */
export function sepoliaPaymentUri(receiver: string, wei: bigint | string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(receiver)) throw new Error('SEPOLIA_RECEIVER_REQUIRED')
  const value = BigInt(wei)
  if (value <= 0n) throw new Error('MONEY_INVALID')
  return `ethereum:${receiver}@${sepoliaChainId}?value=${value}`
}
