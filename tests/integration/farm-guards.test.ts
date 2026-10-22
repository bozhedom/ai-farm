import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query, transaction } from '../../core/db'
import * as settings from '../../core/config'
import * as providers from '../../core/providers'
import { reportMetrics, reportPeriod, scheduleIdeaResearch } from '../../core/jobs/report'
import { claimJob, enqueue, finishJob } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { requestScout, scheduleWork } from '../../core/autonomy'
import { publicCatalog } from '../../core/public-catalog'
import { officeIdea, requestLeadDraft, setProductVisibility } from '../../core/office'
import { activityFeed } from '../../core/activity-feed'
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

  it('skips topics the idea policy always refuses before any money is reserved', async () => {
    await expect(requestScout('crypto-quests')).rejects.toThrow('POLICY_IDEA_TOPIC_BLOCKED')
    const strategy = (await query('SELECT id FROM strategies LIMIT 1'))[0]!.id
    // A job queued before the topic left the rotation.
    await enqueue('scout', 'scout-blocked-topic', {
      strategyId: strategy,
      topicId: 'creators-posts',
    })
    const model = vi.spyOn(providers, 'model')
    const search = vi.spyOn(providers, 'searchQuery')
    await runAll(['scout'])
    expect(model).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(await query("SELECT id FROM budget_reservations WHERE category='scout'")).toHaveLength(0)
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(0)
    expect(
      await query(
        "SELECT id FROM audit_events WHERE kind='scout_skipped' AND data->>'topicId'='creators-posts'",
      ),
    ).toHaveLength(1)
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
    const second = await acceptedIdea('shop-print')
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

  it('keeps demo ideas, products and numbers out of a stand with a real model', async () => {
    const idea = await acceptedIdea('marketplaces-cards')
    expect(idea.is_demo).toBe(true)
    const live = () =>
      vi.spyOn(settings, 'config').mockReturnValue({
        ...settings.config(),
        MODEL_PROVIDER: 'openrouter',
        SEARCH_PROVIDER: 'searxng',
      })
    live()
    // The research job queued by the demo report refuses the demo idea.
    await runAll(['research'])
    expect(await query('SELECT id FROM products WHERE idea_id=$1', [idea.id])).toHaveLength(0)
    expect(
      await query("SELECT id FROM audit_events WHERE kind='idea_research_skipped'"),
    ).toHaveLength(1)
    await query("DELETE FROM jobs WHERE dedupe_key LIKE 'idea-research:%'")
    expect(await transaction((db) => scheduleIdeaResearch(db, 5, false))).toEqual([])
    const day = reportPeriod('daily', 'report:daily:' + new Date().toISOString().slice(0, 10))
    expect((await reportMetrics(day.start, day.end)).ideas).toBe(0)
    // On the demo stand the same idea is built, but its product gets no replies on a live stand.
    vi.restoreAllMocks()
    expect(await transaction((db) => scheduleIdeaResearch(db, 5, false))).toHaveLength(1)
    await runAll(['research'])
    const [product] = await query('SELECT * FROM products WHERE idea_id=$1', [idea.id])
    expect(product!.is_demo).toBe(true)
    live()
    await enqueue('lead', 'lead:2026-10-09:demo-product', { productId: product!.id })
    await runAll(['lead'])
    expect(await query('SELECT id FROM opportunities WHERE reply_draft IS NOT NULL')).toHaveLength(
      0,
    )
    expect(
      await query("SELECT id FROM audit_events WHERE kind='lead_search_completed'"),
    ).toHaveLength(0)
  })

  it('leaves an idea with the owner when its product page fails the text check', async () => {
    const idea = await acceptedIdea('marketplaces-cards')
    const original = providers.model
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) => {
      const value: any = await original(args)
      // A free model's real answer: the page of another idea, with stray English.
      if (args.role === 'Архитектор')
        return {
          ...value,
          page: { ...value.page, headline: 'Цифровой чек-листа ухода после груминга' },
        }
      return value
    })
    await runAll(['research'])
    expect(await query('SELECT id FROM products WHERE idea_id=$1', [idea.id])).toHaveLength(0)
    const [after] = await query('SELECT status,build_error FROM ideas WHERE id=$1', [idea.id])
    expect(after!.status).toBe('needs_human')
    expect(after!.build_error).toMatch(/^Сборка не прошла проверку: Страница продукта: Заголовок/)
    const [event] = await query("SELECT data FROM audit_events WHERE kind='idea_build_failed'")
    expect(event!.data).toMatchObject({ ideaId: idea.id, reason: after!.build_error })
    // The owner reads the reason without the model's instructions, in the card and the feed.
    const view = await officeIdea(idea.id)
    expect(view.buildError).toMatch(/^Страница продукта: Заголовок страницы не называет услугу/)
    expect(view.buildError).not.toMatch(/используй|оставь/)
    expect(view.buildFailedAt).toBeTruthy()
    const line = (await activityFeed(50)).find((item) => item.kind === 'idea_build_failed')
    expect(line?.text).toMatch(/^Сборка по идее «.+» не прошла проверку: страница продукта: /)
    expect(line?.link).toBe(`/office/ideas/${idea.id}`)
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
