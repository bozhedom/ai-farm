import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { claimJob, enqueue, finishJob } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { createOrder } from '../../core/orders'
import { defaultPriceKopecks, publicSlug } from '../../core/storefront'
import { publicCatalog } from '../../core/public-catalog'
import type { Template } from '../../core/policy'
import { applyMigrations, resetDatabase } from './helpers/db'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterAll(async () => {
  await pool.end()
})

describe('storefront foundation', () => {
  it('publishes new products privately with a slug and the default price of their type', async () => {
    await enqueue('research', 'foundation', {
      templates: JSON.stringify(['description', 'job_post']),
    })
    const job = (await claimJob(['research']))!
    await runJob(job)
    await finishJob(job)
    const products = await query('SELECT * FROM products ORDER BY template')
    expect(products.length).toBeGreaterThan(0)
    for (const p of products)
      expect(p).toMatchObject({
        slug: publicSlug(p.template),
        price_kopecks: defaultPriceKopecks[p.template as Template],
        visibility: 'private',
        published_at: null,
        kind: 'service',
        page: {},
        idea_id: null,
      })
    await expect(
      query("UPDATE products SET slug='Bad_Slug' WHERE id=$1", [products[0]!.id]),
    ).rejects.toThrow(/products_slug_format/)
  })

  it('records owner orders as test payments that can never carry revenue', async () => {
    await enqueue('research', 'foundation-order', { templates: JSON.stringify(['description']) })
    const job = (await claimJob(['research']))!
    await runJob(job)
    await finishJob(job)
    const [product] = await query('SELECT id FROM products')
    const order = await createOrder(
      product!.id,
      'Керамическая кружка 350 мл. Белая глазурь, ручная работа. Мыть вручную.',
      randomUUID(),
    )
    const [row] = await query('SELECT * FROM orders WHERE id=$1', [order.id])
    expect(row).toMatchObject({ source: 'owner', is_test_payment: true, revenue_kopecks: 0 })
    await expect(
      query('UPDATE orders SET revenue_kopecks=49000 WHERE id=$1', [order.id]),
    ).rejects.toThrow(/orders_revenue_requires_real_payment/)
  })

  it('shows buyers only products the owner made public, without internal fields', async () => {
    await enqueue('research', 'foundation-catalog', { templates: JSON.stringify(['faq']) })
    const job = (await claimJob(['research']))!
    await runJob(job)
    await finishJob(job)
    expect((await publicCatalog()).services).toEqual([])
    await query("UPDATE products SET visibility='public', published_at=now()")
    const catalog = await publicCatalog()
    expect(catalog.payment).toEqual({ mode: 'sandbox', test: true, label: 'Тестовая оплата' })
    expect(catalog.acceptingOrders).toBe(false)
    expect(catalog.seller).toBeNull()
    expect(catalog.services).toHaveLength(1)
    expect(catalog.services[0]).toMatchObject({
      slug: 'faq',
      priceKopecks: 149000,
      currency: 'RUB',
    })
    const json = JSON.stringify(catalog)
    for (const hidden of ['strategy', 'hypothesis', 'checks', '"id"', 'template'])
      expect(json).not.toContain(hidden)
    await query("UPDATE products SET status='archived'")
    expect((await publicCatalog()).services).toEqual([])
  })
})
