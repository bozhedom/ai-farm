import { describe, expect, it } from 'vitest'
import { POLICY } from '../../core/policy'
import { serviceByTemplate, serviceTemplates } from '../../core/service-catalog'
import {
  defaultPriceKopecks,
  formatEth,
  formatRub,
  kopecksToWei,
  priceIdFor,
  priceIds,
  priceKopecksFor,
  priceList,
  publicInputLimit,
  publicServiceProjection,
  publicSlug,
  publicSlugPattern,
  sepoliaPaymentUri,
} from '../../core/storefront'

describe('storefront rules', () => {
  it('keeps a server-owned list of integer prices with one id per price', () => {
    expect(priceIds).toHaveLength(priceList.length)
    expect(new Set(priceIds).size).toBe(priceIds.length)
    for (const [i, kopecks] of priceList.entries()) {
      expect(Number.isSafeInteger(kopecks)).toBe(true)
      expect(priceKopecksFor(priceIds[i]!)).toBe(kopecks)
      expect(priceIdFor(kopecks)).toBe(priceIds[i])
      if (i) expect(kopecks).toBeGreaterThan(priceList[i - 1]!)
    }
    for (const kopecks of [29000, 49000, 69000, 79000, 89000, 149000, 199000, 19900, 49900])
      expect(priceList).toContain(kopecks)
    expect(() => priceKopecksFor('rub1')).toThrow('PRICE_UNKNOWN')
    expect(priceIdFor(12345)).toBeNull()
  })

  it('prices every service type from the list and gives it a valid slug', () => {
    expect(Object.keys(defaultPriceKopecks).sort()).toEqual([...serviceTemplates].sort())
    for (const template of serviceTemplates) {
      expect(priceList).toContain(defaultPriceKopecks[template])
      expect(publicSlug(template)).toMatch(publicSlugPattern)
    }
    expect(defaultPriceKopecks.description).toBe(49000)
    expect(defaultPriceKopecks.landing).toBe(199000)
    expect(publicSlug('job_post')).toBe('job-post')
    expect(() => publicSlug('x')).toThrow('SLUG_INVALID')
  })

  it('formats kopecks without floating point', () => {
    expect(formatRub(49000)).toBe('490 ₽')
    expect(formatRub(149000)).toBe('1 490 ₽')
    expect(formatRub(12350)).toBe('123,50 ₽')
    expect(formatRub(0)).toBe('0 ₽')
    expect(() => formatRub(1.5)).toThrow('MONEY_INVALID')
    expect(() => formatRub(-1)).toThrow('MONEY_INVALID')
  })

  it('projects only buyer-safe fields and drops unknown page content', () => {
    expect(publicInputLimit).toBe(POLICY.maxInputChars)
    const service = serviceByTemplate.faq
    const view = publicServiceProjection(
      {
        slug: 'faq',
        version: 3,
        price_kopecks: 149000,
        is_demo: false,
        spec: { name: 'Ответы на вопросы', promise: 'Обещание' },
        page: {
          headline: 'Ответы, которые снимут звонки',
          forWhom: ['Салоны', 7, '<b>html</b>'],
          secret: 'never shown',
        },
      },
      service,
    )
    expect(view).toEqual({
      slug: 'faq',
      name: 'Ответы на вопросы',
      category: service.category,
      audience: service.audience,
      promise: 'Обещание',
      inputLabel: service.inputLabel,
      example: service.example,
      inputLimit: POLICY.maxInputChars,
      priceKopecks: 149000,
      currency: 'RUB',
      version: 3,
      isDemo: false,
      page: { headline: 'Ответы, которые снимут звонки', forWhom: ['Салоны'] },
    })
    expect(
      publicServiceProjection(
        { slug: 'faq', version: 1, price_kopecks: 1, is_demo: true, spec: {}, page: null },
        service,
        { paymentMode: 'sepolia' },
      ),
    ).toMatchObject({ currency: 'TEST_ETH', page: {}, name: service.label })
  })

  it('converts rubles to test ETH with integer wei at the conditional rate', () => {
    expect(POLICY.chainId).toBe(11155111)
    expect(kopecksToWei(49000, 300000)).toBe(1633333333333333n)
    expect(kopecksToWei(30000000, 300000)).toBe(10n ** 18n)
    expect(() => kopecksToWei(0, 300000)).toThrow('MONEY_INVALID')
    expect(() => kopecksToWei(100, 0)).toThrow('RATE_INVALID')
    expect(formatEth(1500000000000000n)).toBe('0.0015')
    expect(formatEth('2000000000000000000')).toBe('2')
    expect(formatEth(1n)).toBe('0.000000000000000001')
    const receiver = '0x1111111111111111111111111111111111111111'
    expect(sepoliaPaymentUri(receiver, 123n)).toBe(`ethereum:${receiver}@11155111?value=123`)
    expect(() => sepoliaPaymentUri('0x12', 1n)).toThrow('SEPOLIA_RECEIVER_REQUIRED')
    expect(() => sepoliaPaymentUri(receiver, 0n)).toThrow('MONEY_INVALID')
  })
})
