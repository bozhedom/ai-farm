import { afterEach, describe, expect, it, vi } from 'vitest'

async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return (await import('../../core/config')).config
}
afterEach(() => vi.unstubAllEnvs())

describe('public and farm configuration', () => {
  it('starts with safe defaults: private site, sandbox, conditional test rate', async () => {
    const c = (await load({}))()
    expect(c).toMatchObject({
      PAYMENT_MODE: 'sandbox',
      TEST_ETH_RUB_RATE: 300000,
      SEPOLIA_SCAN_ENABLED: true,
      PUBLIC_SELLER: '',
      PUBLIC_CONTACT: '',
      PUBLIC_TERMS_URL: '',
      PUBLIC_ORDERS_PER_DAY: 30,
      PUBLIC_INDEXING: false,
      SCOUT_RESERVE_KOPECKS: 3000,
      LEAD_RESERVE_KOPECKS: 2000,
      REPORT_RESERVE_KOPECKS: 2000,
      LEAD_DRAFTS_PER_DAY: 3,
      IDEA_PRODUCTS_PER_DAY: 2,
    })
  })

  it('accepts only sandbox and Sepolia payments', async () => {
    await expect(load({ PAYMENT_MODE: 'yookassa' }).then((config) => config())).rejects.toThrow()
    await expect(load({ PAYMENT_MODE: 'mainnet' }).then((config) => config())).rejects.toThrow()
  })

  it('refuses indexing without seller details and terms, and non-HTTPS terms', async () => {
    await expect(load({ PUBLIC_INDEXING: 'true' }).then((c) => c())).rejects.toThrow(
      'PUBLIC_INDEXING_REQUIRES_SELLER_TERMS',
    )
    await expect(
      load({ PUBLIC_TERMS_URL: 'http://example.com/terms' }).then((c) => c()),
    ).rejects.toThrow('PUBLIC_TERMS_URL_INVALID')
    const c = (
      await load({
        PUBLIC_INDEXING: 'true',
        PUBLIC_SELLER: 'ИП Тестов',
        PUBLIC_CONTACT: 'owner@example.com',
        PUBLIC_TERMS_URL: 'https://example.com/terms',
      })
    )()
    expect(c.PUBLIC_INDEXING).toBe(true)
  })

  it('rejects a zero or fractional test rate', async () => {
    await expect(load({ TEST_ETH_RUB_RATE: '0' }).then((c) => c())).rejects.toThrow()
    await expect(load({ TEST_ETH_RUB_RATE: '1.5' }).then((c) => c())).rejects.toThrow()
  })
})
