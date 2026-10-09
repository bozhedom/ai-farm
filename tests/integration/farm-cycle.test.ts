import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import { claimJob, enqueue, expireResearchSlots, finishJob, type Job } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { nextDailyRun, requestScout, scheduleWork, updateFarmSettings } from '../../core/autonomy'
import { officeOverview, officeSettings } from '../../core/office'
import { publicCatalog } from '../../core/public-catalog'
import { priceList } from '../../core/storefront'
import { taxonomyTopics } from '../../core/taxonomy'
import { applyMigrations, resetDatabase } from './helpers/db'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await pool.end()
})

const farmKinds: Job['kind'][] = ['evaluate', 'evolve', 'report', 'research', 'scout', 'lead']

/** Runs queued farm work like the worker's farm lane, re-running the scheduler in between. */
async function drain(now: Date, limit = 60) {
  const done: { kind: string; key: string; error: string | null }[] = []
  for (let i = 0; i < limit; i++) {
    await scheduleWork(now)
    const job = await claimJob(farmKinds)
    if (!job) break
    let failure: unknown
    try {
      await runJob(job)
    } catch (error) {
      failure = error
    }
    await finishJob(job, failure)
    const [row] = await query('SELECT dedupe_key,error_code FROM jobs WHERE id=$1', [job.id])
    done.push({ kind: job.kind, key: row!.dedupe_key, error: row!.error_code })
  }
  return done
}

describe('farm day in demo mode', () => {
  it('scouts four topics, ranks, reports, builds a public product and drafts replies', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    await scheduleWork(now)
    const scouts = await query(
      "SELECT payload FROM jobs WHERE kind='scout' AND dedupe_key LIKE $1 ORDER BY created_at",
      [`scout:${day}:%`],
    )
    expect(scouts).toHaveLength(4)
    const topics = scouts.map((s) => s.payload.topicId)
    expect(new Set(topics).size).toBe(4)
    const categories = topics.map((id) => taxonomyTopics.find((t) => t.id === id)!.category)
    expect(new Set(categories).size).toBe(4)
    expect(scouts.every((s) => s.payload.scheduled === 'true')).toBe(true)
    const [assigned] = await query("SELECT message FROM audit_events WHERE kind='scouts_assigned'")
    expect(assigned!.message).toMatch(/^Руководитель раздал задания: Разведчик А ищет/)
    expect(assigned!.message).not.toMatch(/[—→]/)
    // Params were filled once for the founders.
    expect(
      await query("SELECT id FROM strategies WHERE params='{}'::jsonb OR params IS NULL"),
    ).toHaveLength(0)

    const ran = await drain(now)
    expect(ran.filter((r) => r.error)).toEqual([])
    const ideas = await query('SELECT * FROM ideas ORDER BY created_at')
    expect(ideas).toHaveLength(4)
    expect(new Set(ideas.map((i) => i.topic_id)).size).toBe(4)
    expect(ideas.every((i) => i.is_demo && i.ranked_at)).toBe(true)
    expect(ideas.every((i) => i.rank_score > 0 && i.rank_score <= 100)).toBe(true)
    expect(ideas.every((i) => i.status !== 'new' || i.critique.verdict === 'REVISE')).toBe(true)

    const [report] = await query('SELECT * FROM manager_reports')
    expect(report).toMatchObject({
      report_key: `report:daily:${day}`,
      kind: 'daily',
      is_demo: true,
    })
    expect(report!.narrative.headline).toBeTruthy()
    expect(report!.metrics.ideas).toBe(4)
    expect(report!.ranking[0].rankScore).toBeGreaterThanOrEqual(report!.ranking.at(-1).rankScore)

    const ideaResearch = await query("SELECT * FROM jobs WHERE dedupe_key LIKE 'idea-research:%'")
    expect(ideaResearch.length).toBeGreaterThan(0)
    expect(ideaResearch.every((j) => j.status === 'done' && j.payload.scheduled === 'true')).toBe(
      true,
    )
    const published = await query(
      "SELECT p.*,i.status AS idea_status FROM products p JOIN ideas i ON i.id=p.idea_id WHERE p.visibility='public'",
    )
    expect(published.length).toBeGreaterThan(0)
    for (const product of published) {
      expect(priceList).toContain(product.price_kopecks)
      expect(product.published_at).toBeTruthy()
      expect(product.page.headline).toBeTruthy()
      expect(product.page.youGet.length).toBeGreaterThan(0)
      expect(product.idea_status).toBe('productized')
      const [version] = await query(
        'SELECT price_kopecks,page FROM product_versions WHERE product_id=$1 AND version=$2',
        [product.id, product.version],
      )
      expect(version).toMatchObject({ price_kopecks: product.price_kopecks, page: product.page })
      const [check] = await query('SELECT idea_id FROM hypotheses WHERE id=$1', [
        product.hypothesis_id,
      ])
      expect(check!.idea_id).toBe(product.idea_id)
    }
    const catalog = await publicCatalog()
    expect(catalog.services.map((s) => s.slug)).toEqual(
      expect.arrayContaining(published.map((p) => p.slug)),
    )

    // Leads for public products: candidates linked to the product, with validated drafts.
    const leads = await query('SELECT * FROM opportunities WHERE product_id IS NOT NULL')
    expect(leads.length).toBeGreaterThan(0)
    const drafted = leads.filter((l) => l.reply_draft)
    expect(drafted.length).toBeGreaterThan(0)
    for (const lead of drafted) {
      expect(lead.reply_draft).toContain('/services/')
      expect(lead.reply_draft).not.toMatch(/@|—|→/)
      expect(lead.stage).toBe('new')
    }
    // Test payments and leads never create revenue.
    const [money] = await query('SELECT COALESCE(sum(revenue_kopecks),0)::int AS r FROM orders')
    expect(money!.r).toBe(0)
    // A second pass on the same day creates nothing new.
    const jobs = (await query('SELECT count(*)::int AS n FROM jobs'))[0]!.n
    await scheduleWork(now)
    expect((await query('SELECT count(*)::int AS n FROM jobs'))[0]!.n).toBe(jobs)
  })

  it('starts the daily run at the owner hour (UTC) and not before', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    const today = new Date()
    const at = (hour: number) =>
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hour))
    await updateFarmSettings({ scheduleHourUtc: 9 })
    expect((await officeSettings()).scheduleHourUtc).toBe(9)
    await expect(updateFarmSettings({ scheduleHourUtc: 23 })).rejects.toThrow()
    await scheduleWork(at(8))
    expect(
      await query("SELECT id FROM jobs WHERE kind IN ('scout','research','lead')"),
    ).toHaveLength(0)
    expect(nextDailyRun(at(8), 9, false)).toBe(at(9).toISOString())
    await scheduleWork(at(9))
    expect(await query("SELECT id FROM jobs WHERE kind='scout'")).toHaveLength(4)
    expect(nextDailyRun(at(10), 9, true)).toBe(new Date(at(9).getTime() + 86400000).toISOString())
    expect(nextDailyRun(at(10), 9, false)).toBe(at(10).toISOString())
    const overview = await officeOverview(at(10))
    expect(overview.worker.nextAt === null || typeof overview.worker.nextAt === 'string').toBe(true)
  })

  it('keeps scheduled farm work idle while paused, stopped or with the schedule off', async () => {
    const config = vi
      .spyOn(settings, 'config')
      .mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    await query("UPDATE system_state SET mode='paused'")
    await scheduleWork()
    expect(await query("SELECT id FROM jobs WHERE kind='scout'")).toHaveLength(0)
    await query("UPDATE system_state SET mode='running'")
    await scheduleWork()
    expect(await query("SELECT id FROM jobs WHERE kind='scout'")).toHaveLength(4)
    await query("UPDATE system_state SET mode='paused'")
    expect(await claimJob(['scout'])).toBeUndefined()
    await query("UPDATE system_state SET mode='emergency_stop'")
    expect(await claimJob(['scout'])).toBeUndefined()
    await query("UPDATE system_state SET mode='running',schedule_enabled=false")
    expect(await claimJob(['scout'])).toBeUndefined()
    config.mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: false })
    await query('UPDATE system_state SET schedule_enabled=true')
    expect(await claimJob(['scout'])).toBeUndefined()
    // Owner scouting runs without the schedule, one at a time with other model work.
    const manual = await requestScout()
    expect(manual.jobs).toHaveLength(4)
    expect((await requestScout()).reused).toBe(true)
    const first = (await claimJob(['scout']))!
    expect(first.payload.scheduled).toBeUndefined()
    expect(await claimJob(['scout', 'research', 'lead', 'report'])).toBeUndefined()
    await finishJob(first)
    expect(await claimJob(['scout'])).toBeDefined()
  })

  it('orders farm work by priority and expires yesterday’s unstarted slots', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    const strategy = (await query('SELECT id FROM strategies LIMIT 1'))[0]!.id
    await enqueue('lead', 'lead:2020-01-01:x', { productId: strategy, scheduled: 'true' })
    await enqueue('scout', 'scout:2020-01-01:x:1', {
      strategyId: strategy,
      topicId: taxonomyTopics[0]!.id,
      scheduled: 'true',
    })
    await enqueue('report', 'report:daily:2020-01-01', { kind: 'daily', scheduled: 'true' })
    await enqueue('evolve', 'evolve-owner:test', { trigger: 'owner' })
    const evolve = (await claimJob(farmKinds))!
    expect(evolve.kind).toBe('evolve')
    const report = (await claimJob(farmKinds))!
    expect(report.kind).toBe('report')
    await finishJob(report, new Error('POLICY_TEST_STOP'))
    await expireResearchSlots(new Date().toISOString().slice(0, 10))
    expect(
      await query(
        "SELECT kind,status,error_code FROM jobs WHERE kind IN ('scout','lead') ORDER BY kind",
      ),
    ).toEqual([
      { kind: 'lead', status: 'failed', error_code: 'FARM_SLOT_EXPIRED' },
      { kind: 'scout', status: 'failed', error_code: 'FARM_SLOT_EXPIRED' },
    ])
  })

  it('defers paid scouting to the next day when only the daily budget is exhausted', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'yandex',
      SEARCH_PROVIDER: 'yandex',
      YANDEX_API_KEY: 'test',
      YANDEX_FOLDER_ID: 'test',
      DAILY_BUDGET_KOPECKS: 5000,
      SCOUT_RESERVE_KOPECKS: 3000,
    })
    const strategy = (await query('SELECT id FROM strategies LIMIT 1'))[0]!.id
    await query(
      `INSERT INTO budget_reservations(id,dedupe_key,category,limit_kopecks,spent_kopecks,status)
       VALUES(gen_random_uuid(),'spent','research',4000,4000,'closed')`,
    )
    await query(
      `INSERT INTO tool_calls(id,call_key,reservation_id,role,status,reserved_kopecks,charged_kopecks,is_demo)
       SELECT gen_random_uuid(),'spent-call',id,'search','done',4000,4000,false FROM budget_reservations`,
    )
    const job = await enqueue('scout', 'scout-manual:budget', {
      strategyId: strategy,
      topicId: taxonomyTopics[0]!.id,
    })
    expect(await claimJob(['scout'])).toBeUndefined()
    const [row] = await query('SELECT status,error_code,run_after,attempts FROM jobs WHERE id=$1', [
      job.id,
    ])
    expect(row).toMatchObject({
      status: 'queued',
      error_code: 'FARM_DAILY_BUDGET_WAIT',
      attempts: 0,
    })
    expect(new Date(row!.run_after).getTime()).toBeGreaterThan(Date.now())
    expect(
      await query("SELECT id FROM audit_events WHERE kind='farm_daily_budget_wait'"),
    ).toHaveLength(1)
  })
})
