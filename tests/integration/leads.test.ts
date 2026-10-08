import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import * as providers from '../../core/providers'
import { claimJob, enqueue, finishJob } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { updateOpportunity } from '../../core/opportunities'
import { officeLeads, requestLeadDraft, setProductVisibility } from '../../core/office'
import { activityFeed } from '../../core/activity-feed'
import { applyMigrations, resetDatabase } from './helpers/db'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await pool.end()
})

async function publicProduct() {
  await enqueue('research', 'lead-product', { templates: JSON.stringify(['description']) })
  const job = (await claimJob(['research']))!
  await runJob(job)
  await finishJob(job)
  const [product] = await query("SELECT * FROM products WHERE template='description'")
  await setProductVisibility(product!.id, { visibility: 'public' })
  return product!
}

async function run(kind: 'lead', key: string, payload: Record<string, string>) {
  await enqueue(kind, key, payload)
  const job = (await claimJob([kind]))!
  let failure: unknown
  try {
    await runJob(job)
  } catch (error) {
    failure = error
  }
  await finishJob(job, failure)
  return job
}

describe('leads and reply drafts', () => {
  it('finds requests for a product and saves only validated drafts', async () => {
    const product = await publicProduct()
    await run('lead', `lead:2026-10-08:${product.id}`, { productId: product.id })
    const leads = await query('SELECT * FROM opportunities ORDER BY first_seen_at,id')
    expect(leads.length).toBeGreaterThan(0)
    expect(leads.every((lead) => lead.product_id === product.id && lead.is_demo)).toBe(true)
    const drafted = leads.filter((lead) => lead.reply_draft)
    expect(drafted.length).toBeGreaterThan(0)
    for (const lead of drafted) {
      expect(lead.reply_draft).toContain('http://localhost:3210/services/description')
      expect(lead.reply_draft).not.toMatch(/@|https?:\/\/(?!localhost:3210\/services\/)/)
      expect(lead.reply_error).toBeNull()
      expect(lead.reply_job_id).toBeTruthy()
    }
    const list = await officeLeads()
    expect(list.items[0]).toMatchObject({
      product: { id: product.id, slug: 'description' },
      stage: 'new',
      isDemo: true,
    })
    const feed = (await activityFeed()).map((item) => item.text)
    expect(feed.some((text) => text.startsWith('Найден возможный клиент на '))).toBe(true)
    // The model sees the request topic, not the source URL.
    const [call] = await query(
      "SELECT call_key FROM tool_calls WHERE role='Автор отклика' ORDER BY created_at LIMIT 1",
    )
    expect(call).toBeTruthy()
  })

  it('rejects drafts with contacts, foreign links or promises and keeps the reason', async () => {
    const product = await publicProduct()
    const bad = [
      'Здравствуйте! Напишите мне на owner@example.com, сделаю описание товара быстро и аккуратно по вашим данным.',
      'Здравствуйте! Позвоните +7 999 123-45-67, сделаю описание товара быстро и аккуратно по вашим данным сегодня.',
      'Здравствуйте! Посмотрите примеры на https://evil.example/portfolio, сделаю описание товара по вашим данным.',
      'Здравствуйте! Даю скидку 50 процентов на первое описание товара, пишу по вашим характеристикам быстро.',
    ]
    let index = 0
    const original = providers.model
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) =>
      args.role === 'Автор отклика'
        ? args.schema.parse({ draft: bad[index++ % bad.length] })
        : original(args),
    )
    await query("UPDATE system_state SET mode='running'")
    await run('lead', `lead:2026-10-08:${product.id}`, { productId: product.id })
    const leads = await query('SELECT reply_draft,reply_error FROM opportunities ORDER BY id')
    expect(leads.length).toBeGreaterThan(0)
    for (const lead of leads) {
      expect(lead.reply_draft).toBeNull()
      expect(lead.reply_error).toMatch(/^POLICY_REPLY_(CONTACT|URL|PROMISE)$/)
    }
  })

  it('limits owner redrafts to three per lead and never turns a stage into revenue', async () => {
    const product = await publicProduct()
    await run('lead', `lead:2026-10-08:${product.id}`, { productId: product.id })
    const [lead] = await query('SELECT * FROM opportunities ORDER BY id LIMIT 1')
    for (let n = 1; n <= 3; n++) {
      const queued = await requestLeadDraft(lead!.id)
      expect((await requestLeadDraft(lead!.id)).id).toBe(queued.id)
      const job = (await claimJob(['lead']))!
      expect(job.payload.opportunityId).toBe(lead!.id)
      await runJob(job)
      await finishJob(job)
    }
    await expect(requestLeadDraft(lead!.id)).rejects.toThrow('LEAD_DRAFT_LIMIT')
    const [updated] = await query(
      'SELECT reply_draft,reply_job_id FROM opportunities WHERE id=$1',
      [lead!.id],
    )
    expect(updated!.reply_draft).toContain('/services/description')
    await updateOpportunity(lead!.id, { stage: 'won', note: 'Ответили' })
    const [money] = await query(
      'SELECT COALESCE(sum(revenue_kopecks),0)::int AS r,count(*)::int AS n FROM orders',
    )
    expect(money).toEqual({ r: 0, n: 0 })
  })
})
