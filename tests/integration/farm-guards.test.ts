import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import * as providers from '../../core/providers'
import { claimJob, enqueue, finishJob } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { requestScout, scheduleWork } from '../../core/autonomy'
import { publicCatalog } from '../../core/public-catalog'
import { requestLeadDraft, setProductVisibility } from '../../core/office'
import { saveOpportunities } from '../../core/opportunities'
import { POLICY } from '../../core/policy'
import { taxonomyTopics } from '../../core/taxonomy'
import { applyMigrations, resetDatabase } from './helpers/db'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await pool.end()
})

async function runAll(kinds: Parameters<typeof claimJob>[0], limit = 30) {
  for (let i = 0; i < limit; i++) {
    const job = await claimJob(kinds)
    if (!job) return
    let failure: unknown
    try {
      await runJob(job)
    } catch (error) {
      failure = error
    }
    await finishJob(job, failure)
  }
}

/** One accepted executable idea on the given topic, ready for research. */
async function acceptedIdea(topicId: string) {
  await requestScout(topicId)
  await runAll(['scout', 'report'])
  const [idea] = await query('SELECT * FROM ideas ORDER BY created_at DESC LIMIT 1')
  return idea!
}

describe('farm guards from the review', () => {
  it('runs the report after manual scouting without the schedule', async () => {
    const queued = await requestScout()
    expect(queued.jobs).toHaveLength(4)
    await runAll(['scout'])
    const [report] = await query("SELECT dedupe_key,payload FROM jobs WHERE kind='report'")
    expect(report!.dedupe_key).toMatch(/^report:after-scouts:/)
    expect(report!.payload.scheduled).toBeUndefined()
    await runAll(['report', 'research'])
    expect(await query('SELECT id FROM manager_reports')).toHaveLength(1)
    expect(await query('SELECT id FROM ideas WHERE ranked_at IS NULL')).toHaveLength(0)
    expect(
      (
        await query("SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE 'idea-research:%'")
      )[0]!.n,
    ).toBeGreaterThan(0)
  })

  it('caps ideas per day for owner and scheduled scouting', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    const strategy = (await query('SELECT id FROM strategies LIMIT 1'))[0]!.id
    for (let i = 0; i < POLICY.maxIdeasPerDay - 2; i++)
      await enqueue('scout', `scout-cap:${i}`, {
        strategyId: strategy,
        topicId: taxonomyTopics[0]!.id,
      })
    const owner = await requestScout()
    expect(owner.jobs).toHaveLength(2)
    expect((await requestScout()).reused).toBe(true)
    await query("UPDATE jobs SET status='done' WHERE kind='scout'")
    await expect(requestScout()).rejects.toThrow('IDEAS_DAILY_LIMIT')
    await scheduleWork()
    expect((await query("SELECT count(*)::int AS n FROM jobs WHERE kind='scout'"))[0]!.n).toBe(
      POLICY.maxIdeasPerDay,
    )
  })

  it('does not save an idea for an agent archived while the model answered', async () => {
    await requestScout(taxonomyTopics[0]!.id)
    const job = (await claimJob(['scout']))!
    const original = providers.model
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) => {
      if (args.role === 'Критик')
        await query("UPDATE strategies SET status='archived',archived_at=now() WHERE id=$1", [
          job.payload.strategyId,
        ])
      return original(args)
    })
    await runJob(job)
    await finishJob(job)
    expect(await query('SELECT id FROM ideas')).toHaveLength(0)
    expect(
      await query(
        "SELECT id FROM audit_events WHERE kind='scout_skipped' AND message LIKE '%уволен%'",
      ),
    ).toHaveLength(1)
  })

  it('keeps a product the owner hid off the storefront after a new idea version', async () => {
    const idea = await acceptedIdea('marketplaces-cards')
    await runAll(['research'])
    const [product] = await query('SELECT * FROM products WHERE idea_id=$1', [idea.id])
    expect(product!.visibility).toBe('public')
    await setProductVisibility(product!.id, { visibility: 'private' })
    // A second accepted idea for the same service type.
    const second = await acceptedIdea('marketplaces-reviews')
    await query(
      "UPDATE ideas SET status='accepted',suggested_template=$1,farm_executable=true,critique=$2 WHERE id=$3",
      [product!.template, { verdict: 'PASS', reason: 'Проверка.' }, second.id],
    )
    await enqueue('research', `idea-research:${second.id}`, {
      templates: JSON.stringify([product!.template]),
      ideaId: second.id,
    })
    await runAll(['research'])
    const [after] = await query('SELECT * FROM products WHERE id=$1', [product!.id])
    expect(after).toMatchObject({
      visibility: 'private',
      version: product!.version + 1,
      idea_id: second.id,
    })
    expect(after!.page.headline).toBeTruthy()
    expect(
      await query(
        "SELECT id FROM audit_events WHERE kind='product_updated' AND data->>'hidden'='true'",
      ),
    ).toHaveLength(1)
    // No reply drafts for a hidden product.
    const leadJob = await enqueue('lead', 'lead-source', {})
    await saveOpportunities(leadJob.id, after!.template, [
      {
        url: `https://customer-brief.example/${after!.template}`,
        title: 'Демонстрация запроса',
        snippet: 'Синтетический запрос для проверки.',
        observedAt: new Date().toISOString(),
        demo: true,
      },
    ])
    const [lead] = await query('SELECT id FROM opportunities LIMIT 1')
    await expect(requestLeadDraft(lead!.id)).rejects.toThrow('PRODUCT_NOT_PUBLIC')
    await enqueue('lead', 'lead:2026-10-08:hidden', { productId: after!.id })
    await runAll(['lead'])
    expect(await query('SELECT id FROM opportunities WHERE reply_draft IS NOT NULL')).toHaveLength(
      0,
    )
  })

  it('shows demo products to buyers only on a demo stand', async () => {
    const idea = await acceptedIdea('marketplaces-cards')
    await runAll(['research'])
    const [product] = await query('SELECT * FROM products WHERE idea_id=$1', [idea.id])
    expect(product!.is_demo).toBe(true)
    expect((await publicCatalog()).services.length).toBeGreaterThan(0)
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'openrouter',
      SEARCH_PROVIDER: 'searxng',
    })
    expect((await publicCatalog()).services).toEqual([])
    await setProductVisibility(product!.id, { visibility: 'private' })
    await expect(setProductVisibility(product!.id, { visibility: 'public' })).rejects.toThrow(
      'PRODUCT_DEMO_ONLY',
    )
  })

  it('masks phone numbers without a plus sign in lead snippets', async () => {
    const job = await enqueue('lead', 'mask', {})
    await saveOpportunities(job.id, 'description', [
      {
        url: 'https://fl.ru/projects/123/opisaniya.html',
        title: 'Нужно описание товаров',
        snippet:
          'Нужно 30 описаний для Ozon, звоните 8 (999) 123-45-67 или 8.900.123.45.67, бюджет 3000.',
        observedAt: new Date().toISOString(),
        demo: false,
      },
    ])
    const [lead] = await query('SELECT snippet FROM opportunities')
    expect(lead!.snippet).not.toMatch(/999|900/)
    expect(lead!.snippet).toContain('бюджет 3000')
  })
})
