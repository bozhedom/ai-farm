import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import { budgetSummary, meteredCall, reserveBudget } from '../../core/budget'
import * as budget from '../../core/budget'
import {
  claimJob,
  enqueue,
  finishJob,
  recoverJobs,
  expireResearchSlots,
  requestResearch,
} from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { templates, type Template } from '../../core/policy'
import * as providers from '../../core/providers'
import { createOrder, orderDetails } from '../../core/orders'
import { resolveOrder } from '../../core/order-resolution'
import { opportunityList, saveOpportunities, updateOpportunity } from '../../core/opportunities'
import {
  cancelResearchCampaign,
  requestResearchCampaign,
  researchCampaignStatus,
} from '../../core/research-campaign'
import { paymentHash, paymentReceiver, paymentRpc } from '../fixtures/sepolia'
import type { Invoice } from '../../core/payments'
import { sandboxPayment, submitTransaction, reconcilePayments } from '../../core/payments'
import { simulateEvolution, evaluateWeek } from '../../core/evolution'
import { attemptLogin, validSession, digest } from '../../core/auth'
import { activityContext, reportUsage, WorkerDraining } from '../../core/activity'
import { claimWorkerJob, executeWorkerJob } from '../../core/worker-runtime'
import { productHistory } from '../../core/products'
import { recipes } from '../../core/templates'
import { sourceSocialDelivery } from '../../core/source-posts'
import {
  scheduleWork,
  setSchedule,
  setResearchScope,
  autonomyStatus,
  type AutonomyState,
} from '../../core/autonomy'

const input = 'Керамическая кружка 350 мл. Белая глазурь, ручная работа. Мыть вручную.'
beforeAll(async () => {
  const [db] = await query('SELECT current_database() AS name')
  if (!db?.name.endsWith('_test')) throw new Error('REFUSING_NON_TEST_DATABASE')
  for (const file of readdirSync('db')
    .filter((x) => x.endsWith('.sql'))
    .sort())
    await query(readFileSync(`db/${file}`, 'utf8'))
})
beforeEach(async () => {
  await query(
    'TRUNCATE sessions,login_attempts,audit_events,evaluations,orders,tool_calls,budget_reservations,products,hypotheses,jobs,strategies,system_state RESTART IDENTITY CASCADE',
  )
  await query('INSERT INTO system_state(id) VALUES(true)')
  for (const name of ['Альфа', 'Бета', 'Гамма', 'Дельта'])
    await query('INSERT INTO strategies(id,name,approach,generation) VALUES($1,$2,$3,1)', [
      randomUUID(),
      name,
      'Только проверенные факты и ясная структура.',
    ])
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await pool.end()
})

async function research() {
  await enqueue('research', 'test-research')
  const job = (await claimJob(['research']))!
  await runJob(job)
  await finishJob(job)
  return await query('SELECT * FROM products ORDER BY created_at')
}
async function order() {
  const products = await research()
  return createOrder(products[0]!.id, input, randomUUID())
}

describe('durable autonomous pipeline', () => {
  it('reserves paid cloud work and enforces one lifetime dollar cap across concurrent requests', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'openai',
      SEARCH_PROVIDER: 'searxng',
      OPENAI_TOTAL_BUDGET_MICROUSD: 1000000,
    })
    const reservationId = await reserveBudget('cloud-cap', 'research')
    expect(
      (
        await query('SELECT limit_kopecks FROM budget_reservations WHERE id=$1', [reservationId])
      )[0]!.limit_kopecks,
    ).toBe(10000)
    const invoke = vi.fn(async () => ({ value: 'ok', cost: 1, microusd: 700000 }))
    const args = {
      reservationId,
      role: 'test',
      maximum: 1,
      maximumMicrousd: 700000,
      demo: false,
      activity: { provider: 'openai', model: 'gpt-6-astra', taskLabel: 'test' },
      invoke,
    }
    const results = await Promise.allSettled([
      meteredCall({ ...args, key: 'cloud-a' }),
      meteredCall({ ...args, key: 'cloud-b' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message,
    ).toBe('OPENAI_BUDGET_BLOCKED')
    const [done] = await query('SELECT call_key FROM tool_calls')
    await meteredCall({ ...args, key: done!.call_key })
    expect(invoke).toHaveBeenCalledTimes(1)
    await query("UPDATE tool_calls SET created_at=now()-interval '2 months'")
    await expect(meteredCall({ ...args, key: 'next-month' })).rejects.toThrow(
      'OPENAI_BUDGET_BLOCKED',
    )
    expect((await budgetSummary()).openaiSpentMicrousd).toBe(700000)
  })
  it('retains the dollar reserve after uncertainty and blocks unpaid cloud bypasses', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'openai',
      SEARCH_PROVIDER: 'searxng',
      OPENAI_TOTAL_BUDGET_MICROUSD: 1000000,
    })
    const reservationId = await reserveBudget('cloud-uncertain', 'research')
    const invoke = vi.fn(async () => {
      throw new Error('MODEL_OUTPUT_INCOMPLETE')
    })
    const args = {
      key: 'cloud-uncertain',
      reservationId,
      role: 'test',
      maximum: 1,
      maximumMicrousd: 600000,
      demo: false,
      activity: { provider: 'openai', taskLabel: 'test' },
      invoke,
    }
    await expect(meteredCall(args)).rejects.toThrow('MODEL_OUTPUT_INCOMPLETE')
    await expect(meteredCall(args)).rejects.toThrow('UNCERTAIN_CALL_REQUIRES_REVIEW')
    await expect(meteredCall({ ...args, key: 'again' })).rejects.toThrow('OPENAI_BUDGET_BLOCKED')
    await expect(meteredCall({ ...args, key: 'no-reserve', maximumMicrousd: 0 })).rejects.toThrow(
      'INVALID_DOLLAR_RESERVE',
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await query('SELECT status,charged_microusd FROM tool_calls'))[0]).toEqual({
      status: 'uncertain',
      charged_microusd: 600000,
    })
  })
  it('persists measured token usage across repairs without charging local inference', async () => {
    const reservationId = await reserveBudget('usage', 'research')
    const invoke = vi.fn(async () => {
      await reportUsage('usage', 120, 30)
      await reportUsage('usage', 60, 20)
      await reportUsage('usage', undefined, undefined)
      await reportUsage('usage', -1, 1.5)
      return { value: { text: 'validated' }, cost: 0 }
    })
    const args = {
      key: 'usage',
      reservationId,
      role: 'Исследователь',
      maximum: 0,
      demo: false,
      invoke,
    }
    await meteredCall(args)
    await meteredCall(args)
    await reportUsage('usage', 999, 999)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(
      (await query('SELECT input_tokens,output_tokens,charged_kopecks FROM tool_calls'))[0],
    ).toEqual({ input_tokens: 180, output_tokens: 50, charged_kopecks: 0 })
  })
  it('preserves known usage on invalid output and leaves legacy usage unknown', async () => {
    const reservationId = await reserveBudget('invalid-usage', 'research')
    await expect(
      meteredCall({
        key: 'invalid-usage',
        reservationId,
        role: 'Критик',
        maximum: 0,
        demo: false,
        invoke: async () => {
          await reportUsage('invalid-usage', 200, 40)
          throw new Error('MODEL_SCHEMA_INVALID')
        },
      }),
    ).rejects.toThrow('MODEL_SCHEMA_INVALID')
    expect((await query('SELECT input_tokens,output_tokens,status FROM tool_calls'))[0]).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      status: 'uncertain',
    })
    await meteredCall({
      key: 'missing-usage',
      reservationId,
      role: 'search',
      maximum: 0,
      demo: true,
      invoke: async () => ({ value: [], cost: 0 }),
    })
    expect(
      (
        await query(
          "SELECT input_tokens,output_tokens FROM tool_calls WHERE call_key='missing-usage'",
        )
      )[0],
    ).toEqual({ input_tokens: null, output_tokens: null })
  })
  it('never relabels cached demo output as a live model response after a provider switch', async () => {
    const reservationId = await reserveBudget('provider-switch', 'research')
    const common = { key: 'provider-switch', reservationId, role: 'Исследователь', maximum: 0 }
    await meteredCall({
      ...common,
      demo: true,
      activity: { provider: 'demo', taskLabel: 'test' },
      invoke: async () => ({ value: { text: 'demo' }, cost: 0 }),
    })
    const invoke = vi.fn(async () => ({ value: { text: 'live' }, cost: 0 }))
    await expect(
      meteredCall({
        ...common,
        demo: false,
        activity: { provider: 'ollama', model: 'local-model', taskLabel: 'test' },
        invoke,
      }),
    ).rejects.toThrow('PROVIDER_CHANGED_DURING_JOB')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('preserves expensive estimates and blocks publication instead of lowering the amount', async () => {
    const original = providers.model
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) =>
      args.role === 'Исследователь'
        ? args.schema.parse({ ...args.demoValue, estimatedCostRub: 4000 })
        : original(args),
    )
    expect(await research()).toHaveLength(0)
    const ideas = await query('SELECT research,critique,status FROM hypotheses')
    expect(ideas).toHaveLength(2)
    expect(
      ideas.every(
        (h) =>
          h.status === 'rejected' &&
          h.research.estimatedCostRub === 4000 &&
          h.critique.verdict === 'BLOCKED',
      ),
    ).toBe(true)
    expect(await query("SELECT id FROM tool_calls WHERE role='Архитектор'")).toHaveLength(0)
  })
  it('allows immediate manual runs beyond the old daily quota while deduplicating concurrent clicks', async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const requested = await Promise.all(Array.from({ length: 8 }, () => requestResearch()))
      expect(new Set(requested.map((job) => job.id)).size).toBe(1)
      expect(requested.filter((job) => !job.reused)).toHaveLength(1)
      ids.add(requested[0]!.id)
      const job = (await claimJob(['research']))!
      expect(await requestResearch()).toMatchObject({ id: job.id, reused: true, status: 'running' })
      await finishJob(job, i % 2 ? new Error('OUTPUT_REVIEW_REQUIRED') : undefined)
    }
    expect(ids.size).toBe(5)
    expect(await query("SELECT id FROM audit_events WHERE kind='research_requested'")).toHaveLength(
      5,
    )
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(5)
  })
  it('reuses scheduled research and respects pause, emergency stop and the closed window', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    const scheduled = await enqueue('research', 'research:2026-09-24')
    expect(await requestResearch()).toMatchObject({ id: scheduled.id, reused: true })
    for (const mode of ['paused', 'emergency_stop']) {
      await query('UPDATE system_state SET mode=$1', [mode])
      await expect(requestResearch()).rejects.toThrow('RESEARCH_PAUSED')
    }
    await query("UPDATE system_state SET mode='running',research_enabled=false")
    await expect(requestResearch()).rejects.toThrow('RESEARCH_WINDOW_CLOSED')
  })
  it('runs the owner-selected template without changing an already active request', async () => {
    await expect(requestResearch('arbitrary-code' as Template)).rejects.toThrow()
    expect(await query('SELECT id FROM jobs')).toHaveLength(0)
    const requested = await requestResearch('social')
    expect(await requestResearch('faq')).toMatchObject({ id: requested.id, reused: true })
    const job = (await claimJob(['research']))!
    await runJob(job)
    await finishJob(job)
    expect((await query('SELECT template FROM products')).map((p) => p.template)).toEqual([
      'social',
    ])
    await requestResearch('faq')
    const next = (await claimJob(['research']))!
    await runJob(next)
    await finishJob(next)
    expect(
      (await query('SELECT template FROM products ORDER BY template')).map((p) => p.template),
    ).toEqual(['faq', 'social'])
  })
  it.each(['over-budget', 'invalid-output'])(
    'rotates to another template after a missing product fails with %s',
    async (failure) => {
      await research()
      const original = providers.model
      vi.spyOn(providers, 'model').mockImplementation(async (args: any) => {
        if (args.role === 'Исследователь' && args.context.template === 'social') {
          if (failure === 'invalid-output') throw new Error('MODEL_SCHEMA_INVALID')
          return args.schema.parse({ ...args.demoValue, estimatedCostRub: 4000 })
        }
        return original(args)
      })
      await requestResearch()
      const rejected = (await claimJob(['research']))!
      if (failure === 'invalid-output') {
        await expect(runJob(rejected)).rejects.toThrow('MODEL_SCHEMA_INVALID')
        await finishJob(rejected, new Error('MODEL_SCHEMA_INVALID'))
      } else {
        await runJob(rejected)
        await finishJob(rejected)
      }
      expect(await query("SELECT id FROM products WHERE template='social'")).toHaveLength(0)
      // Every untried direction gets a turn before an existing service is refreshed.
      for (const template of templates.slice(3)) {
        await requestResearch()
        const untried = (await claimJob(['research']))!
        await runJob(untried)
        await finishJob(untried)
        expect(
          (await query('SELECT template,status FROM hypotheses WHERE job_id=$1', [untried.id]))[0],
        ).toEqual({
          template,
          status: 'accepted',
        })
      }
      await requestResearch()
      const next = (await claimJob(['research']))!
      await runJob(next)
      await finishJob(next)
      expect(
        (await query('SELECT template,status FROM hypotheses WHERE job_id=$1', [next.id]))[0],
      ).toEqual({
        template: 'description',
        status: 'accepted',
      })
      expect(
        (await query("SELECT version FROM products WHERE template='description'"))[0]!.version,
      ).toBe(2)
    },
  )
  it('links finished role calls to a run and preserves old product and order versions', async () => {
    const [product] = await research()
    const o = await createOrder(product!.id, input, randomUUID())
    await enqueue('research', 'version-two', { templates: JSON.stringify([product!.template]) })
    const job = (await claimJob(['research']))!
    await runJob(job)
    await finishJob(job)
    const calls = await query('SELECT * FROM tool_calls WHERE job_id=$1', [job.id])
    expect(calls).toHaveLength(7)
    expect(calls.filter((call) => call.role === 'search')).toHaveLength(2)
    expect(
      calls.every(
        (c) => c.status === 'done' && c.finished_at && c.task_label && c.provider === 'demo',
      ),
    ).toBe(true)
    expect(
      (await query('SELECT version FROM products WHERE id=$1', [product!.id]))[0]!.version,
    ).toBe(2)
    expect(
      await query('SELECT version FROM product_versions WHERE product_id=$1', [product!.id]),
    ).toHaveLength(2)
    expect((await productHistory(product!.id)).versions.map((v) => v.version)).toEqual([2, 1])
    expect((await productHistory(product!.id, 2)).versions.map((v) => v.version)).toEqual([1])
    await expect(productHistory(randomUUID())).rejects.toThrow('PRODUCT_NOT_FOUND')
    expect(
      (await query('SELECT product_snapshot FROM orders WHERE id=$1', [o.id]))[0]!.product_snapshot
        .version,
    ).toBe(1)
    await runJob(job)
    expect(
      await query('SELECT version FROM product_versions WHERE product_id=$1', [product!.id]),
    ).toHaveLength(2)
  })
  it('skips expired daily research slots instead of spending on a backlog after pause', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    const old = await enqueue('research', 'research:2026-09-22')
    await reserveBudget(`research:${old.id}`, 'research')
    const fresh = await enqueue('research', 'research:2026-09-24')
    await expireResearchSlots('2026-09-24')
    expect((await claimJob(['research']))?.id).toBe(fresh.id)
    expect(
      (await query('SELECT status,error_code FROM jobs WHERE id=$1', [old.id]))[0],
    ).toMatchObject({ status: 'failed', error_code: 'RESEARCH_SLOT_EXPIRED' })
    expect(
      (
        await query('SELECT status FROM budget_reservations WHERE dedupe_key=$1', [
          `research:${old.id}`,
        ])
      )[0]!.status,
    ).toBe('closed')
  })
  it('schedules one daily run across concurrent workers, without a paid retry or pause backlog', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    const now = new Date()
    await Promise.all(Array.from({ length: 6 }, () => scheduleWork(now)))
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(1)
    expect(await query("SELECT id FROM audit_events WHERE kind='research_scheduled'")).toHaveLength(
      1,
    )
    const claims = await Promise.all([claimJob(['research']), claimJob(['research'])])
    expect(claims.filter(Boolean)).toHaveLength(1)
    await finishJob(claims.find(Boolean)!, new Error('OPENAI_BUDGET_BLOCKED'))
    await scheduleWork(now)
    expect(await claimJob(['research'])).toBeUndefined()
    const tomorrow = new Date(now.getTime() + 86400000)
    await query("UPDATE system_state SET mode='paused'")
    await scheduleWork(tomorrow)
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(1)
    await query("UPDATE system_state SET mode='running'")
    await scheduleWork(tomorrow)
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(2)
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(0)
  })
  it('keeps disabled scheduled jobs idle while allowing manual work and free weekly evaluation', async () => {
    await expect(setSchedule(true)).rejects.toThrow('SCHEDULE_DISABLED_ON_SERVER')
    await scheduleWork()
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(0)
    const suspended = await enqueue('research', `research:${new Date().toISOString().slice(0, 10)}`)
    expect(await claimJob(['research'])).toBeUndefined()
    const manual = await requestResearch('social')
    expect(manual.id).not.toBe(suspended.id)
    expect((await claimJob(['research']))?.id).toBe(manual.id)
    expect(await claimJob(['evaluate'])).toBeDefined()
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(0)
  })
  it('persists the owner schedule switch and avoids overlapping manual and scheduled research', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    await setSchedule(false)
    await scheduleWork()
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(0)
    await setSchedule(true)
    const manual = await requestResearch()
    await scheduleWork()
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(1)
    const job = (await claimJob(['research']))!
    expect(job.id).toBe(manual.id)
    await enqueue('research', 'another-queued-run')
    expect(await claimJob(['research'])).toBeUndefined()
    await finishJob(job)
    expect(await claimJob(['research'])).toBeDefined()
  })
  it('reports no next run while disabled, offline or out of budget and exposes the actual UTC slot', async () => {
    const now = new Date()
    await query('UPDATE system_state SET worker_heartbeat=$1,provider_readiness=$2', [
      now,
      { model: true, search: true, checkedAt: now.toISOString() },
    ])
    const [state] = await query<AutonomyState>('SELECT * FROM system_state')
    const budget = await budgetSummary()
    expect(await autonomyStatus(state!, budget, now)).toMatchObject({
      enabled: false,
      nextAt: null,
      workerAlive: true,
    })
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    expect((await autonomyStatus(state!, budget, now)).nextAt).toBe(now.toISOString())
    await scheduleWork(now)
    const job = (await claimJob(['research']))!
    await finishJob(job)
    const status = await autonomyStatus(state!, budget, now)
    expect(status.lastScheduledRun).toMatchObject({ id: job.id, status: 'done' })
    expect(status.nextAt).toBe(
      new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
      ).toISOString(),
    )
    expect(
      (await autonomyStatus({ ...state!, worker_heartbeat: null }, budget, now)).nextAt,
    ).toBeNull()
    expect((await autonomyStatus(state!, { ...budget, daySpent: 999999 }, now)).nextAt).toBeNull()
  })
  it('closes an inconclusive research window without abandoning paid orders', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    await query("UPDATE system_state SET generation_started_at=now()-interval '29 days'")
    await evaluateWeek('closed-week')
    await enqueue('research', 'closed-research')
    expect(await claimJob(['research'])).toBeUndefined()
    expect((await query('SELECT research_enabled FROM system_state'))[0]!.research_enabled).toBe(
      false,
    )
    expect((await query('SELECT decision FROM evaluations'))[0]!.decision).toBe('CLOSED')
    const job = (await claimJob(['fulfill']))!
    await runJob(job)
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'delivered',
    )
  })
  it('researches, checks fixtures, creates two products and delivers once after a test payment', async () => {
    const products = await research()
    expect(products).toHaveLength(2)
    expect(
      products.every((p) => p.checks.normal === 'PASS' && p.checks.injection === 'BLOCKED'),
    ).toBe(true)
    const key = randomUUID(),
      created = await createOrder(products[0]!.id, input, key)
    expect(await createOrder(products[0]!.id, input, key)).toEqual(created)
    await expect(createOrder(products[0]!.id, input + ' Иное.', key)).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    )
    await Promise.all([sandboxPayment(created.id), sandboxPayment(created.id)])
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(1)
    const job = (await claimJob(['fulfill']))!
    await runJob(job)
    await finishJob(job)
    await runJob(job)
    const [saved] = await query('SELECT * FROM orders WHERE id=$1', [created.id])
    expect(saved!.status).toBe('delivered')
    expect(saved!.result).toContain('ДЕМОНСТРАЦИЯ')
    expect(await query("SELECT id FROM audit_events WHERE kind='order_delivered'")).toHaveLength(1)
    expect((await budgetSummary()).outstanding).toBe(0)
    await evaluateWeek('week-1')
    const [evaluation] = await query('SELECT * FROM evaluations')
    expect(evaluation!.decision).toBe('HOLD')
    expect(evaluation!.details.realRevenueKopecks).toBe(0)
  })
  it('preserves quality objections and never publishes a rejected control example', async () => {
    const original = providers.model
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) =>
      args.role === 'Проверяющий'
        ? args.schema.parse({ verdict: 'REVISE', reason: 'В ответе выдуманы условия доставки.' })
        : original(args),
    )
    expect(await research()).toHaveLength(0)
    const hypotheses = await query('SELECT status,critique FROM hypotheses')
    expect(hypotheses).toHaveLength(2)
    expect(
      hypotheses.every((h) => h.status === 'rejected' && h.critique.verdict === 'BLOCKED'),
    ).toBe(true)
    expect(
      hypotheses.every((h) => h.critique.reason.includes('В ответе выдуманы условия доставки.')),
    ).toBe(true)
    expect(await query('SELECT * FROM product_versions')).toHaveLength(0)
  })
  it('excludes catalog identity and audience from customer text generation and review', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    const [saved] = await query('SELECT product_snapshot FROM orders WHERE id=$1', [o.id])
    const original = providers.model
    const calls: Record<string, unknown>[] = []
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) => {
      calls.push(args.context)
      return original(args)
    })
    await runJob((await claimJob(['fulfill']))!)
    expect(calls).toHaveLength(2)
    for (const context of calls) {
      expect(context.input).toBe(input)
      expect(context.formatPromise).toBe(saved!.product_snapshot.promise)
      expect(JSON.stringify(context)).not.toContain(saved!.product_snapshot.name)
      expect(JSON.stringify(context)).not.toContain(saved!.product_snapshot.audience)
    }
  })
  it('keeps rejected order output private and marks the obligation for review', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    const original = providers.model
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) =>
      args.role === 'Проверяющий'
        ? args.schema.parse({
            verdict: 'BLOCKED',
            reason: 'В ответ добавлены неподтверждённые свойства.',
          })
        : original(args),
    )
    const job = (await claimJob(['fulfill']))!
    await expect(runJob(job)).rejects.toThrow('OUTPUT_REVIEW_REQUIRED')
    await finishJob(job, new Error('OUTPUT_REVIEW_REQUIRED'))
    expect((await query('SELECT status,result,review FROM orders WHERE id=$1', [o.id]))[0]).toEqual(
      {
        status: 'manual_review',
        result: null,
        review: { verdict: 'BLOCKED', reason: 'В ответ добавлены неподтверждённые свойства.' },
      },
    )
    expect(await query("SELECT id FROM audit_events WHERE kind='order_delivered'")).toHaveLength(0)
    expect((await budgetSummary()).outstanding).toBe(0)
  })
  it('builds every campaign recipe and delivers each order once through its saved version and QA', async () => {
    const campaign = await requestResearchCampaign()
    for (const template of templates) {
      const job = (await claimJob(['research']))!
      expect(job.payload.campaignId).toBe(campaign.campaignId)
      expect(JSON.parse(job.payload.templates!)).toEqual([template])
      await runJob(job)
      await finishJob(job)
      const [product] = await query('SELECT * FROM products WHERE template=$1', [template])
      expect(product!.checks).toMatchObject({ input: recipes[template].fixture, normal: 'PASS' })
      expect(product!.spec.promise).toBe(recipes[template].delivery)
      const created = await createOrder(product!.id, recipes[template].fixture, randomUUID())
      await Promise.all([sandboxPayment(created.id), sandboxPayment(created.id)])
      const delivery = (await claimJob(['research', 'fulfill']))!
      expect(delivery.kind).toBe('fulfill')
      await runJob(delivery)
      await finishJob(delivery)
      await runJob(delivery)
      expect((await orderDetails(created.id)).product_snapshot).toMatchObject({
        template,
        version: 1,
        promise: recipes[template].delivery,
      })
      expect((await orderDetails(created.id)).status).toBe('delivered')
      expect((await orderDetails(created.id)).review?.verdict).toBe('PASS')
      expect(
        await query(
          "SELECT id FROM audit_events WHERE kind='order_delivered' AND data->>'orderId'=$1",
          [created.id],
        ),
      ).toHaveLength(1)
    }
    expect(await query('SELECT id FROM products')).toHaveLength(templates.length)
    expect(await query('SELECT * FROM product_versions')).toHaveLength(templates.length)
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(templates.length)
    expect(
      await query("SELECT id FROM budget_reservations WHERE category='research'"),
    ).toHaveLength(templates.length)
    expect(await query("SELECT id FROM budget_reservations WHERE status='open'")).toHaveLength(0)
    const status = await researchCampaignStatus(campaign.campaignId)
    expect(status).toMatchObject({
      total: templates.length,
      completed: templates.length,
      failed: 0,
      pending: 0,
      running: 0,
      status: 'done',
    })
    expect(
      status!.items.every((item) => item.hypothesisStatus === 'accepted' && item.productId),
    ).toBe(true)
    expect(
      (
        await query(
          'SELECT count(*)::int AS uses FROM hypotheses GROUP BY strategy_id ORDER BY strategy_id',
        )
      ).map((row) => row.uses),
    ).toEqual([3, 3, 3, 3])
    expect((await budgetSummary()).openaiSpentMicrousd).toBe(0)
  })
  it('blocks malformed social output before spending on QA or publishing a product', async () => {
    const original = providers.model
    const spy = vi
      .spyOn(providers, 'model')
      .mockImplementation(async (args: any) =>
        args.role === 'Исполнитель'
          ? { text: 'Один черновик вместо трёх. Исходные сведения сохранены.' }
          : original(args),
      )
    await requestResearch('social')
    const job = (await claimJob(['research']))!
    await runJob(job)
    await finishJob(job)
    expect(await query('SELECT id FROM products')).toHaveLength(0)
    expect((await query('SELECT status,critique FROM hypotheses'))[0]).toMatchObject({
      status: 'rejected',
      critique: { verdict: 'BLOCKED', reason: 'OUTPUT_FORMAT_REQUIRED' },
    })
    expect(spy.mock.calls.some(([args]) => args.role === 'Проверяющий')).toBe(false)
  })
  it('does not queue delivery for an unpaid order', async () => {
    const o = await order()
    expect(await claimJob(['fulfill'])).toBeUndefined()
    await expect(
      runJob({
        id: randomUUID(),
        kind: 'fulfill',
        payload: { orderId: o.id },
        attempts: 1,
        max_attempts: 3,
        lease_token: randomUUID(),
      }),
    ).rejects.toThrow('ORDER_NOT_PAID')
  })
  it('archives half atomically and starts children with no inherited orders', async () => {
    await research()
    const results = await Promise.all([simulateEvolution(1), simulateEvolution(1)])
    expect(results[0]!.id).toBe(results[1]!.id)
    expect(await query("SELECT id FROM strategies WHERE status='active'")).toHaveLength(4)
    expect(await query("SELECT id FROM strategies WHERE status='archived'")).toHaveLength(2)
    expect(await query('SELECT id FROM strategies WHERE parent_id IS NOT NULL')).toHaveLength(2)
    expect(await query('SELECT id FROM orders')).toHaveLength(0)
    expect(await query('SELECT id FROM products')).toHaveLength(2)
  })
  it('does not rotate while an accepted obligation is unfinished', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    await expect(simulateEvolution(1)).rejects.toThrow('OPEN_OBLIGATIONS')
  })
  it('pauses new work but completes already confirmed orders', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    await query("UPDATE system_state SET mode='paused'")
    const [product] = await query('SELECT id FROM products LIMIT 1')
    await expect(createOrder(product!.id, input, randomUUID())).rejects.toThrow('NEW_ORDERS_PAUSED')
    await enqueue('research', 'another-research')
    expect(await claimJob(['research'])).toBeUndefined()
    const job = (await claimJob(['fulfill']))!
    await runJob(job)
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'delivered',
    )
  })
  it('emergency stop preserves payments and prevents execution', async () => {
    const o = await order()
    await query("UPDATE system_state SET mode='emergency_stop'")
    await sandboxPayment(o.id)
    expect(await claimJob(['fulfill'])).toBeUndefined()
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe('paid')
  })
  it('recovers an abandoned lease and bounds retries', async () => {
    const o = await order()
    await sandboxPayment(o.id)
    const job = (await claimJob(['fulfill']))!
    await query("UPDATE jobs SET locked_until=now()-interval '1 minute' WHERE id=$1", [job.id])
    await recoverJobs()
    const retry = (await claimJob(['fulfill']))!
    expect(retry.id).toBe(job.id)
    expect(retry.attempts).toBe(2)
    await finishJob(job) // An obsolete worker cannot finish a new lease.
    expect((await query('SELECT status FROM jobs WHERE id=$1', [job.id]))[0]!.status).toBe(
      'running',
    )
    await query("UPDATE jobs SET attempts=3,locked_until=now()-interval '1 minute' WHERE id=$1", [
      job.id,
    ])
    await recoverJobs()
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'manual_review',
    )
    expect(await claimJob(['fulfill'])).toBeUndefined()
  })
  it('claims a queued task only once across concurrent workers', async () => {
    await enqueue('research', 'singleton')
    const claimed = await Promise.all([claimJob(['research']), claimJob(['research'])])
    expect(claimed.filter(Boolean)).toHaveLength(1)
  })
  it('rejects replayed transaction hashes and wrong payment mode', async () => {
    const products = await research()
    const a = await createOrder(products[0]!.id, input, randomUUID()),
      b = await createOrder(products[0]!.id, input, randomUUID())
    await expect(submitTransaction(a.id, '0x' + 'a'.repeat(64))).rejects.toThrow(
      'ORDER_NOT_PAYABLE',
    )
    await query("UPDATE orders SET payment_mode='sepolia' WHERE id=ANY($1::uuid[])", [[a.id, b.id]])
    const hash = '0x' + 'a'.repeat(64)
    await submitTransaction(a.id, hash)
    await expect(submitTransaction(b.id, hash)).rejects.toThrow('TX_ALREADY_USED')
    await submitTransaction(a.id, '0x' + 'b'.repeat(64))
    await expect(submitTransaction(b.id, hash.toUpperCase().replace('0X', '0x'))).rejects.toThrow(
      'TX_ALREADY_USED',
    )
    expect(
      await query('SELECT tx_hash FROM payment_attempts WHERE order_id=$1', [a.id]),
    ).toHaveLength(2)
    await expect(sandboxPayment(a.id)).rejects.toThrow('PAYMENT_MODE_MISMATCH')
  })
  async function sepoliaOrder() {
    const o = await order()
    await query("UPDATE orders SET payment_mode='sepolia',receiver=$2 WHERE id=$1", [
      o.id,
      paymentReceiver,
    ])
    await submitTransaction(o.id, paymentHash)
    return (await query('SELECT * FROM orders WHERE id=$1', [o.id]))[0]!
  }
  it('confirms one canonical payment atomically across workers and retains evidence', async () => {
    const o = await sepoliaOrder()
    const call = vi.fn(paymentRpc({}, o as Invoice))
    await Promise.all([reconcilePayments(call), reconcilePayments(call)])
    expect(call.mock.calls.filter(([method]) => method === 'eth_chainId')).toHaveLength(1)
    expect((await query('SELECT * FROM orders WHERE id=$1', [o.id]))[0]).toMatchObject({
      status: 'paid',
      confirmations: 3,
      payment_proof: { hash: paymentHash, chainId: 11155111, amountWei: o.amount_wei },
      payment_lease_token: null,
    })
    expect(
      (await query('SELECT * FROM payment_attempts WHERE order_id=$1', [o.id]))[0],
    ).toMatchObject({
      confirmations: 3,
      proof: { hash: paymentHash, blockNumber: '100' },
      confirmed_at: expect.any(Date),
    })
    await reconcilePayments(call)
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(1)
    expect(
      await query("SELECT id FROM audit_events WHERE kind='test_payment_confirmed'"),
    ).toHaveLength(1)
    const job = (await claimJob(['fulfill']))!
    await runJob(job)
    await finishJob(job)
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'delivered',
    )
    const detail = await orderDetails(o.id)
    expect(detail.steps.every((step) => !!step.at)).toBe(true)
    expect(detail.paymentAttempts).toHaveLength(1)
    expect(detail.progress.title).toBe('Результат выдан')
    // Old delivered orders may predate the call timestamps and job association.
    await query('UPDATE tool_calls SET job_id=null,finished_at=null WHERE job_id=$1', [job.id])
    const historic = await orderDetails(o.id)
    expect(historic.steps.every((step) => step.done)).toBe(true)
    expect(historic.steps[2]!.at).toBeNull()
  })
  it('waits for invoice confirmations and recovers an abandoned payment lease', async () => {
    const o = await sepoliaOrder()
    await query(
      "UPDATE orders SET required_confirmations=5,payment_lease_token=$2,payment_locked_until=now()+interval '2 minutes' WHERE id=$1",
      [o.id, randomUUID()],
    )
    const call = vi.fn(paymentRpc({}, o as Invoice))
    await reconcilePayments(call)
    expect(call).not.toHaveBeenCalled()
    await query("UPDATE orders SET payment_locked_until=now()-interval '1 second' WHERE id=$1", [
      o.id,
    ])
    await reconcilePayments(call)
    expect((await query('SELECT status,confirmations FROM orders WHERE id=$1', [o.id]))[0]).toEqual(
      { status: 'awaiting_payment', confirmations: 3 },
    )
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(0)
    await query("UPDATE orders SET last_payment_check=now()-interval '1 minute' WHERE id=$1", [
      o.id,
    ])
    await reconcilePayments(paymentRpc({ eth_blockNumber: '0x68' }, o as Invoice))
    expect((await query('SELECT status,confirmations FROM orders WHERE id=$1', [o.id]))[0]).toEqual(
      { status: 'paid', confirmations: 5 },
    )
  })
  it('ignores a stale verification after replacing the transaction hash', async () => {
    const o = await sepoliaOrder()
    let signalStarted!: () => void, releaseCall!: () => void
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseCall = resolve
    })
    const fixture = paymentRpc({}, o as Invoice)
    const pending = reconcilePayments(async (method, params) => {
      if (method === 'eth_chainId') {
        signalStarted()
        await released
      }
      return fixture(method, params)
    })
    await started
    try {
      await submitTransaction(o.id, '0x' + 'd'.repeat(64))
    } finally {
      releaseCall()
    }
    await pending
    expect(
      (await query('SELECT status,confirmations,payment_proof FROM orders WHERE id=$1', [o.id]))[0],
    ).toEqual({ status: 'awaiting_payment', confirmations: 0, payment_proof: null })
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(0)
    expect(
      (await query('SELECT checked_at FROM payment_attempts WHERE tx_hash=$1', [paymentHash]))[0]!
        .checked_at,
    ).toBeNull()
  })
  it('keeps rejected payment details and bounds the final verification window', async () => {
    const o = await sepoliaOrder()
    await reconcilePayments(
      paymentRpc({ eth_getTransactionByHash: { value: '0x1' } }, o as Invoice),
    )
    expect((await query('SELECT status,payment_error FROM orders WHERE id=$1', [o.id]))[0]).toEqual(
      { status: 'awaiting_payment', payment_error: 'WRONG_AMOUNT' },
    )
    expect(
      (await query('SELECT error_code FROM payment_attempts WHERE order_id=$1', [o.id]))[0]!
        .error_code,
    ).toBe('WRONG_AMOUNT')
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(0)
    await query("UPDATE orders SET expires_at=now()-interval '25 hours' WHERE id=$1", [o.id])
    const call = vi.fn(paymentRpc({}, o as Invoice))
    await reconcilePayments(call)
    expect(call).not.toHaveBeenCalled()
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'manual_review',
    )
    expect(
      (await query('SELECT status FROM budget_reservations WHERE id=$1', [o.reservation_id]))[0]!
        .status,
    ).toBe('closed')
  })
  it('expires unpaid invoices and releases their reservation', async () => {
    const o = await order()
    await query("UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1", [o.id])
    await expect(sandboxPayment(o.id)).rejects.toThrow('INVOICE_EXPIRED')
    await reconcilePayments()
    expect((await query('SELECT status FROM orders WHERE id=$1', [o.id]))[0]!.status).toBe(
      'expired',
    )
    expect(
      (
        await query('SELECT status FROM budget_reservations WHERE dedupe_key=$1', [`order:${o.id}`])
      )[0]!.status,
    ).toBe('closed')
  })
})

describe('research window admission', () => {
  it.each(['next-call', 'publication', 'expired-lease'] as const)(
    'preserves an in-flight response at the deadline before %s and continues paid fulfillment',
    async (boundary) => {
      const created = await order()
      await sandboxPayment(created.id)
      const before = await query('SELECT id,version FROM products ORDER BY id')
      await requestResearchCampaign()
      const job = (await claimJob(['research']))!
      const original = budget.meteredCall
      const lastKey = `${job.id}:description:${boundary === 'next-call' ? 'search' : 'fixture-review'}`
      vi.spyOn(budget, 'meteredCall').mockImplementation(async (args: any) => {
        const result = await original(args)
        if (args.key === lastKey) {
          await query(
            "UPDATE system_state SET generation_started_at=clock_timestamp()-interval '28 days'",
          )
          if (boundary === 'expired-lease')
            await query(
              "UPDATE jobs SET locked_until=clock_timestamp()-interval '1 second' WHERE id=$1",
              [job.id],
            )
        }
        return result
      })
      await executeWorkerJob(job, { isStopping: () => false, onHeartbeatError: vi.fn() })
      expect((await query('SELECT research_enabled FROM system_state'))[0]!.research_enabled).toBe(
        false,
      )
      expect(await query("SELECT id FROM evaluations WHERE decision='CLOSED'")).toHaveLength(1)
      expect(await query('SELECT id,version FROM products ORDER BY id')).toEqual(before)
      const calls = await query('SELECT status,call_key FROM tool_calls WHERE job_id=$1', [job.id])
      expect(calls).toHaveLength(boundary === 'next-call' ? 1 : 7)
      expect(calls.every((call) => call.status === 'done')).toBe(true)
      const [saved] = await query('SELECT status,error_code,attempts FROM jobs WHERE id=$1', [
        job.id,
      ])
      if (boundary === 'publication') {
        expect(saved).toEqual({ status: 'done', error_code: null, attempts: 1 })
        expect(await query('SELECT status FROM hypotheses WHERE job_id=$1', [job.id])).toEqual([
          { status: 'backlog' },
        ])
      } else {
        expect(saved).toEqual({
          status: boundary === 'next-call' ? 'failed' : 'queued',
          error_code: boundary === 'next-call' ? 'RESEARCH_WINDOW_CLOSED' : 'LEASE_LOST',
          attempts: 1,
        })
        expect(await query('SELECT id FROM hypotheses WHERE job_id=$1', [job.id])).toHaveLength(0)
      }
      expect(await claimJob(['research'])).toBeUndefined()
      expect(
        await query("SELECT id FROM jobs WHERE kind='research' AND status IN ('queued','running')"),
      ).toHaveLength(0)
      const paid = (await claimJob(['fulfill']))!
      await executeWorkerJob(paid, { isStopping: () => false, onHeartbeatError: vi.fn() })
      expect((await orderDetails(created.id)).status).toBe('delivered')
      expect(await query("SELECT id FROM evaluations WHERE decision='CLOSED'")).toHaveLength(1)
    },
  )

  it('checks the database deadline after waiting for the accounting lock', async () => {
    const blocker = await pool.connect()
    let pending: Promise<Awaited<ReturnType<typeof requestResearch>> | Error> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(735093)')
      await query(
        "UPDATE system_state SET generation_started_at=clock_timestamp()-interval '28 days'+interval '300 milliseconds'",
      )
      pending = requestResearch().catch((error: Error) => error)
      await vi.waitFor(async () => {
        const [waiting] = await query(
          "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND objid=735093 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
        )
        expect(waiting!.count).toBe(1)
      })
      await query(
        "SELECT pg_sleep(GREATEST(0,extract(epoch FROM generation_started_at+interval '28 days'-clock_timestamp()))+0.02) FROM system_state",
      )
      await blocker.query('COMMIT')
      const result = await pending
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('RESEARCH_WINDOW_CLOSED')
      expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(0)
      expect(await query("SELECT id FROM evaluations WHERE decision='CLOSED'")).toHaveLength(1)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
    }
  })

  it('identifies reopened windows by the exact start timestamp within the same generation', async () => {
    const old = await enqueue('research', 'old-window-work')
    for (const timestamp of ['2000-01-01T00:00:00.000001Z', '2000-01-01T00:00:00.000002Z']) {
      await query('UPDATE system_state SET research_enabled=true,generation_started_at=$1', [
        timestamp,
      ])
      await expect(requestResearch()).rejects.toThrow('RESEARCH_WINDOW_CLOSED')
      await expect(requestResearchCampaign()).rejects.toThrow('RESEARCH_WINDOW_CLOSED')
    }
    const records = await query(
      "SELECT generation,evaluation_key FROM evaluations WHERE decision='CLOSED'",
    )
    expect(records).toHaveLength(2)
    expect(new Set(records.map((record) => record.generation))).toEqual(new Set([1]))
    expect(new Set(records.map((record) => record.evaluation_key)).size).toBe(2)
    await query(
      'UPDATE system_state SET research_enabled=true,generation_started_at=clock_timestamp()',
    )
    const fresh = await requestResearch('description')
    expect(fresh.id).not.toBe(old.id)
    expect((await query('SELECT status,error_code FROM jobs WHERE id=$1', [old.id]))[0]).toEqual({
      status: 'failed',
      error_code: 'RESEARCH_WINDOW_CLOSED',
    })
    expect((await query('SELECT research_enabled FROM system_state'))[0]!.research_enabled).toBe(
      true,
    )
  })

  it.each(['manual', 'campaign', 'schedule', 'claim'] as const)(
    'closes an expired window at %s admission without waiting for another weekly evaluation',
    async (admission) => {
      vi.spyOn(settings, 'config').mockReturnValue({
        ...settings.config(),
        MODEL_PROVIDER: 'yandex',
        SEARCH_PROVIDER: 'searxng',
        AUTONOMY_ENABLED: true,
      })
      await query(
        "UPDATE system_state SET generation_started_at=clock_timestamp()-interval '27 days'",
      )
      await evaluateWeek('last-weekly-check')
      const queued = await enqueue('research', `manual-research:${randomUUID()}`)
      const reservationId = await reserveBudget(`research:${queued.id}`, 'research')
      const invoke = vi.fn(async () => ({ value: 'Сохранённое наблюдение', cost: 125 }))
      const call = {
        key: `${queued.id}:before-deadline`,
        reservationId,
        role: 'search',
        maximum: 500,
        demo: false,
        invoke,
      }
      await meteredCall(call)
      await query(
        "UPDATE system_state SET generation_started_at=clock_timestamp()-interval '28 days'",
      )
      if (admission === 'manual')
        await expect(requestResearch()).rejects.toThrow('RESEARCH_WINDOW_CLOSED')
      else if (admission === 'campaign')
        await expect(requestResearchCampaign()).rejects.toThrow('RESEARCH_WINDOW_CLOSED')
      else if (admission === 'schedule') await scheduleWork()
      else expect(await claimJob(['research'])).toBeUndefined()
      expect((await query('SELECT research_enabled FROM system_state'))[0]!.research_enabled).toBe(
        false,
      )
      expect(
        (await query('SELECT status,error_code,attempts FROM jobs WHERE id=$1', [queued.id]))[0],
      ).toEqual({ status: 'failed', error_code: 'RESEARCH_WINDOW_CLOSED', attempts: 0 })
      expect(
        (
          await query('SELECT status,spent_kopecks FROM budget_reservations WHERE id=$1', [
            reservationId,
          ])
        )[0],
      ).toEqual({ status: 'closed', spent_kopecks: 125 })
      await expect(meteredCall(call)).resolves.toBe('Сохранённое наблюдение')
      expect(invoke).toHaveBeenCalledOnce()
      expect((await budgetSummary()).daySpent).toBe(125)
      await Promise.all(Array.from({ length: 4 }, () => scheduleWork()))
      await expect(requestResearch()).rejects.toThrow('RESEARCH_WINDOW_CLOSED')
      await expect(requestResearchCampaign()).rejects.toThrow('RESEARCH_WINDOW_CLOSED')
      expect(await claimJob(['research'])).toBeUndefined()
      await evaluateWeek('another-weekly-check')
      expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(1)
      expect(await query("SELECT id FROM evaluations WHERE decision='CLOSED'")).toHaveLength(1)
      expect(
        await query(
          "SELECT id FROM audit_events WHERE kind='evaluation' AND data->>'decision'='CLOSED'",
        ),
      ).toHaveLength(1)
      expect(await query("SELECT id FROM evaluations WHERE decision='HOLD'")).toHaveLength(1)
    },
  )
})

describe('resumable worker shutdown', () => {
  it.each(['campaign', 'manual'] as const)(
    'resumes %s research after midnight with the same plan and call keys without spending an attempt',
    async (kind) => {
      const requested =
        kind === 'campaign' ? await requestResearchCampaign() : await requestResearch('description')
      const job = (await claimJob(['research']))!
      let stopping = false,
        stopOnce = true
      const original = budget.meteredCall
      const invoked = vi.fn()
      vi.spyOn(budget, 'meteredCall').mockImplementation(async (args: any) =>
        original({
          ...args,
          invoke: async () => {
            invoked(args.key)
            const result = await args.invoke()
            if (stopOnce) {
              stopping = true
              stopOnce = false
            }
            return result
          },
        }),
      )
      const lifecycle = { isStopping: () => stopping, onHeartbeatError: vi.fn() }
      await executeWorkerJob(job, lifecycle)
      const [paused] = await query('SELECT * FROM jobs WHERE id=$1', [job.id])
      expect(paused).toMatchObject({
        status: 'queued',
        attempts: 0,
        max_attempts: 3,
        error_code: 'WORKER_DRAINING',
        lease_token: null,
        locked_until: null,
      })
      expect(job.id).toBe(requested.id)
      if ('campaignId' in requested) expect(paused!.payload.campaignId).toBe(requested.campaignId)
      const [reservation] = await query('SELECT * FROM budget_reservations WHERE dedupe_key=$1', [
        `research:${job.id}`,
      ])
      expect(reservation!.status).toBe('open')
      expect(await query('SELECT id,status FROM tool_calls WHERE job_id=$1', [job.id])).toEqual([
        { id: expect.any(String), status: 'done' },
      ])
      expect(invoked).toHaveBeenCalledOnce()
      expect(await query('SELECT id FROM products')).toHaveLength(0)
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
      await expireResearchSlots(tomorrow)
      expect((await query('SELECT status,error_code FROM jobs WHERE id=$1', [job.id]))[0]).toEqual({
        status: 'queued',
        error_code: 'WORKER_DRAINING',
      })
      expect(
        (await query('SELECT status FROM budget_reservations WHERE id=$1', [reservation!.id]))[0]!
          .status,
      ).toBe('open')
      stopping = false
      const resumed = (await claimJob(['research']))!
      expect(resumed.id).toBe(job.id)
      expect(resumed.attempts).toBe(1)
      expect((await query('SELECT error_code,payload FROM jobs WHERE id=$1', [job.id]))[0]).toEqual(
        {
          error_code: null,
          payload: paused!.payload,
        },
      )
      await executeWorkerJob(resumed, lifecycle)
      expect((await query('SELECT status FROM jobs WHERE id=$1', [job.id]))[0]!.status).toBe('done')
      expect(await query('SELECT id FROM products')).toHaveLength(1)
      expect(await query('SELECT id FROM tool_calls WHERE job_id=$1', [job.id])).toHaveLength(7)
      expect(
        invoked.mock.calls.filter(([key]) => key === `${job.id}:description:search`),
      ).toHaveLength(1)
      expect(
        (
          await query('SELECT id,status FROM budget_reservations WHERE dedupe_key=$1', [
            `research:${job.id}`,
          ])
        )[0],
      ).toEqual({ id: reservation!.id, status: 'closed' })
    },
  )

  it.each(['manual', 'rotate'] as const)(
    'preserves started %s research through graceful shutdown, midnight and another lost lease',
    async (kind) => {
      vi.spyOn(settings, 'config').mockReturnValue({
        ...settings.config(),
        MODEL_PROVIDER: 'yandex',
        SEARCH_PROVIDER: 'searxng',
        AUTONOMY_ENABLED: true,
      })
      const today = new Date().toISOString().slice(0, 10)
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
      const key = kind === 'manual' ? `manual-research:${randomUUID()}` : `research:${today}`
      const payload = {
        templates: JSON.stringify(['description']),
        plan: JSON.stringify([
          { template: 'description', strategy: { id: randomUUID(), approach: 'Сохранённый план' } },
        ]),
      }
      await enqueue('research', key, payload)
      await setSchedule(true)
      const job = (await claimJob(['research']))!
      const reservationId = await reserveBudget(`research:${job.id}`, 'research')
      let stopping = false
      const first = vi.fn(async () => {
        stopping = true
        return { value: 'Сохранённый ответ', cost: 125 }
      })
      const second = vi.fn(async () => ({ value: 'Следующий ответ', cost: 200 }))
      const stages = () =>
        activityContext.run({ jobId: job.id, isStopping: () => stopping }, async () => {
          await meteredCall({
            key: `${job.id}:first`,
            reservationId,
            role: 'Исследователь',
            maximum: 500,
            demo: false,
            invoke: first,
          })
          await meteredCall({
            key: `${job.id}:second`,
            reservationId,
            role: 'Критик',
            maximum: 500,
            demo: false,
            invoke: second,
          })
        })
      await expect(stages()).rejects.toBeInstanceOf(WorkerDraining)
      await finishJob(job, new WorkerDraining())
      expect(first).toHaveBeenCalledOnce()
      expect(second).not.toHaveBeenCalled()
      expect((await query('SELECT status,charged_kopecks FROM tool_calls'))[0]).toEqual({
        status: 'done',
        charged_kopecks: 125,
      })
      expect(await query('SELECT id FROM tool_calls')).toHaveLength(1)
      expect(
        (
          await query('SELECT status,spent_kopecks FROM budget_reservations WHERE id=$1', [
            reservationId,
          ])
        )[0],
      ).toEqual({ status: 'open', spent_kopecks: 125 })
      await expireResearchSlots(tomorrow)
      stopping = false
      const resumed = (await claimJob(['research']))!
      expect(resumed.attempts).toBe(1)
      expect(
        (await query('SELECT error_code FROM jobs WHERE id=$1', [job.id]))[0]!.error_code,
      ).toBeNull()
      // Simulate SIGKILL after the next claim, before any new accounting call.
      await query("UPDATE jobs SET locked_until=now()-interval '1 second' WHERE id=$1", [
        resumed.id,
      ])
      await recoverJobs()
      const staleManual = await enqueue('research', `manual-research:${randomUUID()}`)
      const staleRotate = await enqueue('research', 'research:2020-01-01')
      await expireResearchSlots(tomorrow)
      const [recovered] = await query('SELECT * FROM jobs WHERE id=$1', [job.id])
      expect(recovered).toMatchObject({
        status: 'queued',
        error_code: 'LEASE_EXPIRED',
        attempts: 1,
        max_attempts: 3,
        dedupe_key: key,
        payload,
        lease_token: null,
        locked_until: null,
      })
      expect(recovered!.started_at).not.toBeNull()
      expect(await query('SELECT call_key,status,output,charged_kopecks FROM tool_calls')).toEqual([
        {
          call_key: `${job.id}:first`,
          status: 'done',
          output: 'Сохранённый ответ',
          charged_kopecks: 125,
        },
      ])
      expect(
        (
          await query('SELECT status,spent_kopecks FROM budget_reservations WHERE id=$1', [
            reservationId,
          ])
        )[0],
      ).toEqual({ status: 'open', spent_kopecks: 125 })
      const unused = await query(
        'SELECT status,error_code,attempts,started_at FROM jobs WHERE id=ANY($1)',
        [[staleManual.id, staleRotate.id]],
      )
      expect(unused).toHaveLength(2)
      for (const skipped of unused)
        expect(skipped).toEqual({
          status: 'failed',
          error_code: 'RESEARCH_SLOT_EXPIRED',
          attempts: 0,
          started_at: null,
        })
      const restarted = (await claimJob(['research']))!
      expect(restarted).toMatchObject({ id: job.id, attempts: 2, max_attempts: 3, payload })
      expect(restarted.lease_token).not.toBe(resumed.lease_token)
      await stages()
      expect(first).toHaveBeenCalledOnce()
      expect(second).toHaveBeenCalledOnce()
      expect((await budgetSummary()).daySpent).toBe(325)
      expect(await query('SELECT call_key FROM tool_calls ORDER BY call_key')).toEqual([
        { call_key: `${job.id}:first` },
        { call_key: `${job.id}:second` },
      ])
      expect(
        (
          await query('SELECT spent_kopecks FROM budget_reservations WHERE id=$1', [reservationId])
        )[0]!.spent_kopecks,
      ).toBe(325)
      await finishJob(restarted)
    },
  )

  it('does not turn an uncertain call into a safe retry or refund its attempt on shutdown', async () => {
    const created = await order()
    await sandboxPayment(created.id)
    const job = (await claimJob(['fulfill']))!
    const [saved] = await query('SELECT reservation_id FROM orders WHERE id=$1', [created.id])
    const invoke = vi.fn(async () => {
      throw new Error('NETWORK_TIMEOUT')
    })
    const call = {
      key: `${job.id}:generate`,
      reservationId: saved!.reservation_id,
      role: 'Исполнитель',
      maximum: 0,
      demo: true,
      invoke,
    }
    await expect(meteredCall(call)).rejects.toThrow('NETWORK_TIMEOUT')
    await expect(
      activityContext.run({ jobId: job.id, isStopping: () => true }, () => meteredCall(call)),
    ).rejects.toThrow('UNCERTAIN_CALL_REQUIRES_REVIEW')
    await finishJob(job, new WorkerDraining())
    expect(
      (await query('SELECT status,attempts,error_code FROM jobs WHERE id=$1', [job.id]))[0],
    ).toEqual({ status: 'failed', attempts: 1, error_code: 'UNCERTAIN_CALL_REQUIRES_REVIEW' })
    expect((await orderDetails(created.id)).status).toBe('manual_review')
    expect(invoke).toHaveBeenCalledOnce()
    expect(
      (await query('SELECT status FROM tool_calls WHERE call_key=$1', [call.key]))[0]!.status,
    ).toBe('uncertain')
  })

  it('returns only a raced claim and preserves its envelope, history and maximum attempts', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'yandex',
      SEARCH_PROVIDER: 'searxng',
    })
    const campaign = await requestResearchCampaign()
    let checks = 0
    expect(await claimWorkerJob(['research'], () => ++checks > 1)).toBeUndefined()
    const [saved] = await query('SELECT * FROM jobs WHERE id=$1', [campaign.id])
    expect(saved).toMatchObject({
      status: 'queued',
      attempts: 0,
      max_attempts: 3,
      lease_token: null,
      error_code: 'WORKER_DRAINING',
    })
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(0)
    expect(
      (await query('SELECT status,limit_kopecks,spent_kopecks FROM budget_reservations'))[0],
    ).toEqual({ status: 'open', limit_kopecks: 10000, spent_kopecks: 0 })
    const resumed = (await claimJob(['research']))!
    expect(resumed.id).toBe(campaign.id)
    expect(resumed.attempts).toBe(1)
    await finishJob({ ...resumed, lease_token: randomUUID() }, new WorkerDraining())
    expect(
      (await query('SELECT status,attempts,lease_token FROM jobs WHERE id=$1', [resumed.id]))[0],
    ).toEqual({ status: 'running', attempts: 1, lease_token: resumed.lease_token })
    await finishJob(resumed, new Error('WORKER_DRAINING'))
    expect((await query('SELECT status,attempts FROM jobs WHERE id=$1', [resumed.id]))[0]).toEqual({
      status: 'queued',
      attempts: 1,
    })
  })
})

describe('template-specific order inputs', () => {
  it('rejects missing translation instructions before reserving or creating an order', async () => {
    await requestResearch('translation')
    const researchJob = (await claimJob(['research']))!
    await runJob(researchJob)
    await finishJob(researchJob)
    const [product] = await query("SELECT id FROM products WHERE template='translation'")
    await expect(createOrder(product!.id, input, randomUUID())).rejects.toThrow(
      'TRANSLATION_LANGUAGE_REQUIRED',
    )
    await expect(
      createOrder(product!.id, 'Язык перевода: английский\nКоротко.', randomUUID()),
    ).rejects.toThrow('INPUT_LENGTH')
    expect(await query('SELECT id FROM orders')).toHaveLength(0)
    expect(await query("SELECT id FROM budget_reservations WHERE category='order'")).toHaveLength(0)
    const created = await createOrder(product!.id, recipes.translation.fixture, randomUUID())
    await sandboxPayment(created.id)
    const job = (await claimJob(['fulfill']))!
    // A legacy or damaged snapshot must be revalidated before any provider call.
    await query('UPDATE orders SET input=$2 WHERE id=$1', [created.id, input])
    const model = vi.spyOn(providers, 'model')
    await expect(runJob(job)).rejects.toThrow('TRANSLATION_LANGUAGE_REQUIRED')
    await finishJob(job, new Error('TRANSLATION_LANGUAGE_REQUIRED'))
    expect(model).not.toHaveBeenCalled()
    expect((await orderDetails(created.id)).status).toBe('manual_review')
    expect(await query('SELECT id FROM tool_calls WHERE job_id=$1', [job.id])).toHaveLength(0)
  })
})

describe('public customer-source candidates', () => {
  const source = {
    url: 'https://example.com/request?service=text&utm_source=search&gclid=tracking#offer',
    title: 'Ищем автора текстов для мастерской',
    snippet: 'Нужен редактор описаний по подтверждённым характеристикам товаров.',
    observedAt: '2026-10-08T00:00:00Z',
    demo: true,
  }

  it('discovers marked demo candidates with each research and never duplicates a replay', async () => {
    await research()
    const first = await opportunityList()
    expect(first.total).toBe(4)
    expect(first.items.every((item) => item.is_demo && item.stage === 'new')).toBe(true)
    expect(new Set(first.items.map((item) => item.template))).toEqual(
      new Set(['description', 'faq']),
    )
    const [job] = await query("SELECT * FROM jobs WHERE dedupe_key='test-research'")
    await runJob(job as any)
    expect(await opportunityList()).toEqual(first)
    expect(
      await query("SELECT id FROM audit_events WHERE kind='opportunities_discovered'"),
    ).toHaveLength(2)
    expect(await query("SELECT id FROM tool_calls WHERE call_key LIKE '%:customers'")).toHaveLength(
      2,
    )
  })

  it('refreshes a canonical source on a new run while retaining the owner stage and note', async () => {
    const first = await enqueue('research', 'source-first')
    const second = await enqueue('research', 'source-second')
    await query("UPDATE jobs SET created_at='2026-10-08T00:00:00Z' WHERE id=$1", [first.id])
    await query("UPDATE jobs SET created_at='2026-10-08T01:00:00Z' WHERE id=$1", [second.id])
    expect(await saveOpportunities(first.id, 'description', [source])).toBe(1)
    const [before] = await query('SELECT * FROM opportunities')
    expect(before!.url).toBe('https://example.com/request?service=text')
    await updateOpportunity(before!.id, {
      stage: 'saved',
      note: 'Проверить условия заявки на сайте.',
    })
    expect(
      await saveOpportunities(first.id, 'description', [
        { ...source, title: 'Повтор первого ответа' },
      ]),
    ).toBe(0)
    expect(
      await saveOpportunities(second.id, 'description', [
        {
          ...source,
          url: 'https://example.com/request?service=text&utm_medium=new',
          title: 'Обновлённая заявка мастерской',
        },
      ]),
    ).toBe(1)
    expect((await query('SELECT * FROM opportunities'))[0]).toMatchObject({
      id: before!.id,
      url: before!.url,
      first_job_id: first.id,
      last_job_id: second.id,
      first_seen_at: before!.first_seen_at,
      title: 'Обновлённая заявка мастерской',
      stage: 'saved',
      note: 'Проверить условия заявки на сайте.',
    })
    expect((await opportunityList()).total).toBe(1)
    const latest = await query('SELECT * FROM opportunities')
    expect(await saveOpportunities(first.id, 'description', [source])).toBe(0)
    expect(await query('SELECT * FROM opportunities')).toEqual(latest)
  })

  it('drops unsafe or prohibited sources, redacts contacts and separates demo from live evidence', async () => {
    const job = await enqueue('research', 'filtered-sources')
    const accepted = {
      ...source,
      title: 'Текст для компании: contact@example.org',
      snippet: 'Публичный запрос описаний по материалу. Контакт +7 (999) 123-45-67.',
    }
    expect(
      await saveOpportunities(job.id, 'description', [
        { ...source, url: 'http://example.com/insecure' },
        { ...source, url: 'https://localhost/private' },
        { ...source, url: 'https://127.0.0.1/private' },
        { ...source, url: 'https://login:password@example.com/private' },
        { ...source, snippet: 'Требуется реклама казино для массового продвижения.' },
        accepted,
      ]),
    ).toBe(1)
    expect(await saveOpportunities(job.id, 'description', [{ ...accepted, demo: false }])).toBe(1)
    const candidates = await opportunityList()
    expect(candidates.total).toBe(2)
    expect(new Set(candidates.items.map((item) => item.is_demo))).toEqual(new Set([true, false]))
    expect(
      candidates.items.every(
        (item) =>
          item.title.includes('[контакт в источнике]') &&
          item.snippet.includes('[контакт в источнике]'),
      ),
    ).toBe(true)
    expect(JSON.stringify(candidates.items)).not.toContain('contact@example.org')
    expect(JSON.stringify(candidates.items)).not.toContain('999')
  })

  it('validates owner updates and never counts a manually won candidate as revenue', async () => {
    const job = await enqueue('research', 'source-status')
    await saveOpportunities(job.id, 'description', [source])
    const [candidate] = await query('SELECT * FROM opportunities')
    await expect(updateOpportunity(randomUUID(), { stage: 'saved' })).rejects.toThrow(
      'OPPORTUNITY_NOT_FOUND',
    )
    await expect(updateOpportunity(candidate!.id, { stage: 'paid' })).rejects.toBeInstanceOf(
      z.ZodError,
    )
    await expect(
      updateOpportunity(candidate!.id, { stage: 'won', note: 'x'.repeat(1001) }),
    ).rejects.toBeInstanceOf(z.ZodError)
    const before = await budgetSummary()
    const value = { stage: 'won', note: '  Владелец отметил завершение переговоров.  ' }
    const first = await updateOpportunity(candidate!.id, value)
    expect(await updateOpportunity(candidate!.id, value)).toEqual(first)
    expect(first).toEqual({ id: candidate!.id, stage: 'won', note: value.note.trim() })
    expect(
      await query("SELECT id FROM audit_events WHERE kind='opportunity_updated'"),
    ).toHaveLength(1)
    expect(await budgetSummary()).toEqual(before)
    expect(await query('SELECT id FROM orders')).toHaveLength(0)
    await evaluateWeek('candidate-is-not-revenue')
    expect((await query('SELECT decision,details FROM evaluations'))[0]).toMatchObject({
      decision: 'HOLD',
      details: { realRevenueKopecks: 0 },
    })
  })

  it('keeps older saved candidates accessible through pagination and validated filters', async () => {
    const job = await enqueue('research', 'source-pages')
    for (let start = 0; start < 55; start += 6) {
      await saveOpportunities(
        job.id,
        'description',
        Array.from({ length: Math.min(6, 55 - start) }, (_, index) => ({
          ...source,
          url: `https://example.com/request/${start + index}`,
        })),
      )
    }
    const [saved] = await query('SELECT id FROM opportunities ORDER BY first_seen_at,id LIMIT 1')
    await updateOpportunity(saved!.id, {
      stage: 'saved',
      note: 'Сохранённый кандидат до новых результатов.',
    })
    const first = await opportunityList()
    const second = await opportunityList({ offset: '50' })
    expect(first).toMatchObject({ total: 55, limit: 50, offset: 0, hasMore: true })
    expect(first.items).toHaveLength(50)
    expect(second).toMatchObject({ total: 55, limit: 50, offset: 50, hasMore: false })
    expect(second.items).toHaveLength(5)
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(55)
    const filtered = await opportunityList({ stage: 'saved', template: 'description' })
    expect(filtered).toMatchObject({ total: 1, hasMore: false })
    expect(filtered.items[0]!.id).toBe(saved!.id)
    expect((await opportunityList({ stage: 'saved', template: 'faq' })).items).toHaveLength(0)
    await expect(opportunityList({ offset: -1 })).rejects.toBeInstanceOf(z.ZodError)
    await expect(opportunityList({ offset: 0.5 })).rejects.toBeInstanceOf(z.ZodError)
    await expect(opportunityList({ stage: 'paid' } as any)).rejects.toBeInstanceOf(z.ZodError)
    await expect(opportunityList({ template: 'unknown' } as any)).rejects.toBeInstanceOf(z.ZodError)
  })

  it('records a failed optional customer search without fabricating candidates or stopping research', async () => {
    const original = providers.search
    vi.spyOn(providers, 'search').mockImplementation(async (...args) => {
      if (args[3] === 'customers') throw new Error('SEARCH_HTTP_503')
      return original(...args)
    })
    expect(await research()).toHaveLength(2)
    expect((await opportunityList()).total).toBe(0)
    expect(
      await query(
        "SELECT id FROM audit_events WHERE kind='opportunities_search_failed' AND data->>'code'='SEARCH_HTTP_503'",
      ),
    ).toHaveLength(2)
  })
})

describe('owner resolution of test obligations', () => {
  const reason = 'Проверка завершена: тестовый материал отклонён, выдача не требуется.'

  it('closes review once, preserves evidence and costs, and removes the outstanding obligation', async () => {
    const created = await order()
    await sandboxPayment(created.id)
    const original = providers.model
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) =>
      args.role === 'Проверяющий'
        ? args.schema.parse({
            verdict: 'BLOCKED',
            reason: 'В ответ добавлены неподтверждённые свойства.',
          })
        : original(args),
    )
    const job = (await claimJob(['fulfill']))!
    await expect(runJob(job)).rejects.toThrow('OUTPUT_REVIEW_REQUIRED')
    await finishJob(job, new Error('OUTPUT_REVIEW_REQUIRED'))
    const [before] = await query('SELECT * FROM orders WHERE id=$1', [created.id])
    const reservations = await query('SELECT * FROM budget_reservations ORDER BY id')
    const calls = await query('SELECT * FROM tool_calls ORDER BY id')
    const jobs = await query('SELECT * FROM jobs ORDER BY id')
    const amounts = await budgetSummary()
    await expect(simulateEvolution(1)).rejects.toThrow('OPEN_OBLIGATIONS')
    expect((await orderDetails(created.id)).progress.canResolve).toBe(true)

    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveOrder(created.id, `  ${reason}  `)),
    )
    expect(
      results.every((result) => result.closed_at.getTime() === results[0]!.closed_at.getTime()),
    ).toBe(true)
    expect(results[0]).toMatchObject({
      id: created.id,
      status: 'closed',
      resolution_reason: reason,
    })
    expect((await query('SELECT * FROM orders WHERE id=$1', [created.id]))[0]).toEqual({
      ...before,
      status: 'closed',
      closed_at: results[0]!.closed_at,
      resolution_reason: reason,
    })
    expect(await query('SELECT * FROM budget_reservations ORDER BY id')).toEqual(reservations)
    expect(await query('SELECT * FROM tool_calls ORDER BY id')).toEqual(calls)
    expect(await query('SELECT * FROM jobs ORDER BY id')).toEqual(jobs)
    expect(await budgetSummary()).toEqual(amounts)
    expect(await query("SELECT id FROM audit_events WHERE kind='order_resolved'")).toHaveLength(1)
    expect((await orderDetails(created.id)).progress).toMatchObject({
      title: 'Тестовый заказ закрыт',
      canSubmit: false,
      canResolve: false,
      errorCode: 'OUTPUT_REVIEW_REQUIRED',
    })
    await expect(
      resolveOrder(created.id, 'Совсем другая причина завершения тестового заказа.'),
    ).rejects.toThrow('ORDER_ALREADY_RESOLVED')
    await runJob(job)
    await finishJob(job)
    expect(await query("SELECT id FROM audit_events WHERE kind='order_delivered'")).toHaveLength(0)
    expect((await simulateEvolution(1))!.decision).toBe('SIMULATION')
    expect(
      (
        await query('SELECT status,result,paid_at,delivered_at FROM orders WHERE id=$1', [
          created.id,
        ])
      )[0],
    ).toEqual({
      status: 'closed',
      result: null,
      paid_at: before!.paid_at,
      delivered_at: null,
    })
  })

  it('refuses unrelated states and incomplete reasons without changing an order', async () => {
    const created = await order()
    await expect(resolveOrder(created.id, reason)).rejects.toThrow('ORDER_NOT_RESOLVABLE')
    await expect(resolveOrder(created.id, '  коротко  ')).rejects.toBeInstanceOf(z.ZodError)
    await expect(resolveOrder(created.id, 'я'.repeat(1001))).rejects.toBeInstanceOf(z.ZodError)
    await expect(resolveOrder(randomUUID(), reason)).rejects.toThrow('ORDER_NOT_FOUND')
    await sandboxPayment(created.id)
    await expect(resolveOrder(created.id, reason)).rejects.toThrow('ORDER_NOT_RESOLVABLE')
    const job = (await claimJob(['fulfill']))!
    await runJob(job)
    await finishJob(job)
    await expect(resolveOrder(created.id, reason)).rejects.toThrow('ORDER_NOT_RESOLVABLE')
    expect((await orderDetails(created.id)).status).toBe('delivered')
    expect(await query("SELECT id FROM audit_events WHERE kind='order_resolved'")).toHaveLength(0)
  })

  it('keeps a pessimistically charged uncertain call after the owner closes its test order', async () => {
    const [product] = await research()
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'yandex',
      SEARCH_PROVIDER: 'searxng',
    })
    const created = await createOrder(product!.id, input, randomUUID())
    await sandboxPayment(created.id)
    const job = (await claimJob(['fulfill']))!
    const [order] = await query('SELECT reservation_id FROM orders WHERE id=$1', [created.id])
    const invoke = vi.fn(async () => {
      throw new Error('NETWORK_TIMEOUT')
    })
    const call = {
      key: `${job.id}:generate`,
      reservationId: order!.reservation_id,
      role: 'Исполнитель',
      maximum: 500,
      demo: false,
      invoke,
    }
    await expect(meteredCall(call)).rejects.toThrow('NETWORK_TIMEOUT')
    await finishJob(job, new Error('UNCERTAIN_CALL_REQUIRES_REVIEW'))
    const before = await budgetSummary()
    expect(before.daySpent).toBe(500)
    await resolveOrder(created.id, reason)
    expect(await budgetSummary()).toEqual(before)
    expect(
      (
        await query('SELECT status,charged_kopecks,error_code FROM tool_calls WHERE call_key=$1', [
          call.key,
        ])
      )[0],
    ).toEqual({
      status: 'uncertain',
      charged_kopecks: 500,
      error_code: 'NETWORK_TIMEOUT',
    })
    expect(
      (
        await query('SELECT status,spent_kopecks FROM budget_reservations WHERE id=$1', [
          order!.reservation_id,
        ])
      )[0],
    ).toEqual({ status: 'closed', spent_kopecks: 500 })
    await expect(meteredCall(call)).rejects.toThrow('UNCERTAIN_CALL_REQUIRES_REVIEW')
    await runJob(job)
    expect(invoke).toHaveBeenCalledOnce()
    expect((await orderDetails(created.id)).status).toBe('closed')
  })

  it('retains an unresolved Sepolia payment and its attempts after explicit closure', async () => {
    const created = await order()
    await query("UPDATE orders SET payment_mode='sepolia',receiver=$2 WHERE id=$1", [
      created.id,
      paymentReceiver,
    ])
    await submitTransaction(created.id, paymentHash)
    const [invoice] = await query('SELECT * FROM orders WHERE id=$1', [created.id])
    await reconcilePayments(
      paymentRpc({ eth_getTransactionByHash: { value: '0x1' } }, invoice as Invoice),
    )
    await query("UPDATE orders SET expires_at=now()-interval '25 hours' WHERE id=$1", [created.id])
    await reconcilePayments()
    const attempts = await query('SELECT * FROM payment_attempts WHERE order_id=$1', [created.id])
    const [before] = await query('SELECT * FROM orders WHERE id=$1', [created.id])
    await query("UPDATE system_state SET mode='emergency_stop'")
    const closed = await resolveOrder(created.id, reason)
    expect((await query('SELECT * FROM orders WHERE id=$1', [created.id]))[0]).toEqual({
      ...before,
      status: 'closed',
      closed_at: closed.closed_at,
      resolution_reason: reason,
    })
    const call = vi.fn(paymentRpc({}, invoice as Invoice))
    await reconcilePayments(call)
    expect(call).not.toHaveBeenCalled()
    expect(await query('SELECT * FROM payment_attempts WHERE order_id=$1', [created.id])).toEqual(
      attempts,
    )
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toHaveLength(0)
    expect((await orderDetails(created.id)).payment_error).toBe('WRONG_AMOUNT')
  })

  it('does not revive a closed obligation when an expired worker finishes a late QA call', async () => {
    const created = await order()
    await sandboxPayment(created.id)
    const job = (await claimJob(['fulfill']))!
    let signalStarted!: () => void, releaseCall!: () => void
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseCall = resolve
    })
    const original = providers.model
    vi.spyOn(providers, 'model').mockImplementation(async (args: any) => {
      const output = await original(args)
      if (args.role === 'Проверяющий') {
        signalStarted()
        await released
      }
      return output
    })
    const pending = runJob(job)
    try {
      await started
      await query(
        "UPDATE jobs SET attempts=max_attempts,locked_until=now()-interval '1 minute' WHERE id=$1",
        [job.id],
      )
      await recoverJobs()
      await resolveOrder(created.id, reason)
    } finally {
      releaseCall()
      await pending
    }
    await finishJob(job)
    const closed = await orderDetails(created.id)
    expect(closed).toMatchObject({
      status: 'closed',
      result: null,
      review: null,
      delivered_at: null,
      resolution_reason: reason,
    })
    expect(closed.job).toMatchObject({ status: 'failed', error_code: 'LEASE_EXPIRED' })
    expect(await query("SELECT id FROM audit_events WHERE kind='order_delivered'")).toHaveLength(0)
    expect(
      await query("SELECT id FROM tool_calls WHERE job_id=$1 AND status='done'", [job.id]),
    ).toHaveLength(2)
  })
})

describe('durable research campaigns', () => {
  it.each(['cancelled', 'reclaimed'])(
    'preserves a late QA response without allowing the old worker to publish after its lease is %s',
    async (outcome) => {
      const campaign = await requestResearchCampaign()
      const job = (await claimJob(['research']))!
      let signalStarted!: () => void, releaseCall!: () => void
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve
      })
      const released = new Promise<void>((resolve) => {
        releaseCall = resolve
      })
      const original = budget.meteredCall
      const qaInvoke = vi.fn()
      vi.spyOn(budget, 'meteredCall').mockImplementation(async (args: any) => {
        if (!args.key.endsWith(':fixture-review')) return original(args)
        return original({
          ...args,
          invoke: async () => {
            qaInvoke()
            signalStarted()
            await released
            return args.invoke()
          },
        })
      })
      const pending = runJob(job)
      let replacement: Awaited<ReturnType<typeof claimJob>>
      try {
        await started
        expect(
          (
            await query("SELECT status FROM tool_calls WHERE job_id=$1 AND role='Проверяющий'", [
              job.id,
            ])
          )[0]!.status,
        ).toBe('pending')
        await query("UPDATE jobs SET locked_until=now()-interval '1 minute' WHERE id=$1", [job.id])
        await recoverJobs()
        if (outcome === 'cancelled') {
          expect((await cancelResearchCampaign(campaign.campaignId)).cancelled).toBe(
            templates.length,
          )
        } else {
          replacement = (await claimJob(['research']))!
          expect(replacement.id).toBe(job.id)
          expect(replacement.lease_token).not.toBe(job.lease_token)
        }
      } finally {
        releaseCall()
        await expect(pending).rejects.toThrow('LEASE_LOST')
      }
      await finishJob(job, new Error('LEASE_LOST'))
      expect(await query('SELECT id FROM hypotheses')).toHaveLength(0)
      expect(await query('SELECT id FROM products')).toHaveLength(0)
      expect(await query('SELECT * FROM product_versions')).toHaveLength(0)
      expect(
        (
          await query(
            "SELECT status,output,charged_kopecks FROM tool_calls WHERE job_id=$1 AND role='Проверяющий'",
            [job.id],
          )
        )[0],
      ).toMatchObject({ status: 'done', output: { verdict: 'PASS' }, charged_kopecks: 0 })
      expect(await query('SELECT id FROM tool_calls WHERE job_id=$1', [job.id])).toHaveLength(7)
      expect((await opportunityList()).total).toBe(2)
      const [reservation] = await query(
        'SELECT status FROM budget_reservations WHERE dedupe_key=$1',
        [`research:${job.id}`],
      )
      if (outcome === 'cancelled') {
        expect(reservation!.status).toBe('closed')
        expect(
          (await query('SELECT status,error_code FROM jobs WHERE id=$1', [job.id]))[0],
        ).toEqual({ status: 'failed', error_code: 'RESEARCH_CAMPAIGN_CANCELLED' })
      } else {
        expect(reservation!.status).toBe('open')
        expect(
          (await query('SELECT status,lease_token FROM jobs WHERE id=$1', [job.id]))[0],
        ).toEqual({ status: 'running', lease_token: replacement!.lease_token })
        await runJob(replacement!)
        await finishJob(replacement!)
        expect(await query('SELECT id FROM products')).toHaveLength(1)
        expect(await query('SELECT * FROM product_versions')).toHaveLength(1)
        expect(await query('SELECT id FROM tool_calls WHERE job_id=$1', [job.id])).toHaveLength(7)
      }
      expect(qaInvoke).toHaveBeenCalledOnce()
    },
  )

  it('persists a full-portfolio schedule and creates one campaign across concurrent schedulers', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    expect((await query('SELECT research_scope FROM system_state'))[0]!.research_scope).toBe(
      'rotate',
    )
    expect(await setResearchScope('all')).toEqual({ scope: 'all' })
    await setSchedule(true)
    const now = new Date()
    const slot = `research:${now.toISOString().slice(0, 10)}`
    await Promise.all(Array.from({ length: 8 }, () => scheduleWork(now)))
    const jobs = await query("SELECT id,dedupe_key,payload FROM jobs WHERE kind='research'")
    expect(jobs).toHaveLength(templates.length)
    expect(jobs.filter((job) => job.dedupe_key === slot)).toHaveLength(1)
    expect(jobs.every((job) => job.payload.scheduleSlot === slot)).toBe(true)
    expect(new Set(jobs.map((job) => job.payload.campaignId)).size).toBe(1)
    expect(await researchCampaignStatus()).toMatchObject({
      total: templates.length,
      pending: templates.length,
    })
    expect(await setResearchScope('rotate')).toEqual({ scope: 'rotate' })
    await scheduleWork(now)
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(templates.length)
    await expect(setResearchScope('unknown' as any)).rejects.toThrow()
    expect((await query('SELECT research_scope FROM system_state'))[0]!.research_scope).toBe(
      'rotate',
    )
  })

  it('freezes every queued automatic direction while allowing an explicit single manual run', async () => {
    const original = settings.config()
    const config = vi
      .spyOn(settings, 'config')
      .mockReturnValue({ ...original, AUTONOMY_ENABLED: true })
    await setResearchScope('all')
    await setSchedule(true)
    await scheduleWork()
    const campaign = (await researchCampaignStatus())!
    await setSchedule(false)
    expect(await claimJob(['research'])).toBeUndefined()
    await expect(requestResearchCampaign()).rejects.toThrow('RESEARCH_CAMPAIGN_SCHEDULE_PAUSED')
    const manual = await requestResearch('faq')
    expect(manual.reused).toBe(false)
    const job = (await claimJob(['research']))!
    expect(job.id).toBe(manual.id)
    expect(job.payload.campaignId).toBeUndefined()
    await runJob(job)
    await finishJob(job)
    expect(await researchCampaignStatus(campaign.id)).toMatchObject({
      pending: templates.length,
      running: 0,
    })
    await setSchedule(true)
    config.mockReturnValue({ ...original, AUTONOMY_ENABLED: false })
    expect(await claimJob(['research'])).toBeUndefined()
    config.mockReturnValue({ ...original, AUTONOMY_ENABLED: true })
    const first = (await claimJob(['research']))!
    expect(first.payload.campaignId).toBe(campaign.id)
    expect(first.payload.campaignPosition).toBe('01')
    expect(first.attempts).toBe(1)
    await setSchedule(false)
    await runJob(first)
    await finishJob(first)
    expect(await claimJob(['research'])).toBeUndefined()
    expect(await researchCampaignStatus(campaign.id)).toMatchObject({
      completed: 1,
      pending: templates.length - 1,
    })
    await setSchedule(true)
    const second = (await claimJob(['research']))!
    expect(second.payload.campaignPosition).toBe('02')
  })

  it('preserves automatic portfolio jobs after midnight and never adds a pause backlog', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    await setResearchScope('all')
    await setSchedule(true)
    const now = new Date()
    await scheduleWork(now)
    const campaign = (await researchCampaignStatus())!
    const tomorrow = new Date(now.getTime() + 86400000)
    await query("UPDATE jobs SET created_at=now()-interval '2 days' WHERE kind='research'")
    await expireResearchSlots(tomorrow.toISOString().slice(0, 10))
    await query("UPDATE system_state SET mode='paused'")
    await scheduleWork(tomorrow)
    await scheduleWork(new Date(now.getTime() + 3 * 86400000))
    expect(await researchCampaignStatus(campaign.id)).toMatchObject({
      pending: templates.length,
      failed: 0,
    })
    expect(await claimJob(['research'])).toBeUndefined()
    await query("UPDATE system_state SET mode='running'")
    await scheduleWork(tomorrow)
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(templates.length)
    const first = (await claimJob(['research']))!
    expect(first.payload.campaignId).toBe(campaign.id)
    expect(first.payload.campaignPosition).toBe('01')
  })

  async function spendResearchBudget(kopecks: number) {
    const reservationId = await reserveBudget('used-research-budget', 'research')
    await meteredCall({
      key: 'used-research-call',
      reservationId,
      role: 'Исследователь',
      maximum: kopecks,
      demo: false,
      invoke: async () => ({ value: 'Сохранённый результат', cost: kopecks }),
    })
    await query("UPDATE budget_reservations SET status='closed' WHERE id=$1", [reservationId])
  }

  it('defers a daily-budget-limited campaign without spending attempts and resumes after UTC rollover', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'yandex',
      SEARCH_PROVIDER: 'searxng',
      DAILY_BUDGET_KOPECKS: 15000,
      MONTHLY_BUDGET_KOPECKS: 300000,
      RESEARCH_RESERVE_KOPECKS: 10000,
    })
    await spendResearchBudget(6000)
    const campaign = await requestResearchCampaign()
    const before = await budgetSummary()
    expect(await claimJob(['research'])).toBeUndefined()
    const waiting = await query(
      "SELECT status,error_code,attempts,run_after FROM jobs WHERE payload->>'campaignId'=$1",
      [campaign.campaignId],
    )
    expect(waiting.every((job) => job.status === 'queued' && job.attempts === 0)).toBe(true)
    expect(waiting.some((job) => job.error_code === 'RESEARCH_DAILY_BUDGET_WAIT')).toBe(true)
    const tomorrow = new Date()
    tomorrow.setUTCHours(24, 0, 0, 0)
    expect(
      waiting
        .filter((job) => job.error_code === 'RESEARCH_DAILY_BUDGET_WAIT')
        .every((job) => new Date(job.run_after) >= tomorrow),
    ).toBe(true)
    expect(await budgetSummary()).toEqual(before)
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(1)
    expect((await researchCampaignStatus(campaign.campaignId))!.failed).toBe(0)
    await query("UPDATE tool_calls SET created_at=now()-interval '1 day'")
    await query(
      "UPDATE jobs SET run_after=now()-interval '1 second' WHERE payload->>'campaignId'=$1",
      [campaign.campaignId],
    )
    const resumed = (await claimJob(['research']))!
    expect(resumed.payload.campaignId).toBe(campaign.campaignId)
    expect(resumed.attempts).toBe(1)
    expect(
      (await query('SELECT error_code FROM jobs WHERE id=$1', [resumed.id]))[0]!.error_code,
    ).toBeNull()
    expect((await budgetSummary()).monthSpent).toBe(6000)
  })

  it('keeps monthly exhaustion terminal instead of hiding it behind a daily campaign wait', async () => {
    const original = settings.config()
    const config = vi.spyOn(settings, 'config').mockReturnValue({
      ...original,
      MODEL_PROVIDER: 'yandex',
      SEARCH_PROVIDER: 'searxng',
      DAILY_BUDGET_KOPECKS: 15000,
      MONTHLY_BUDGET_KOPECKS: 300000,
    })
    await spendResearchBudget(6000)
    config.mockReturnValue({ ...settings.config(), MONTHLY_BUDGET_KOPECKS: 15000 })
    const campaign = await requestResearchCampaign()
    const job = (await claimJob(['research']))!
    expect(job.payload.campaignId).toBe(campaign.campaignId)
    expect(job.attempts).toBe(1)
    await expect(runJob(job)).rejects.toThrow('BUDGET_BLOCKED')
    await finishJob(job, new Error('BUDGET_BLOCKED'))
    expect((await query('SELECT status,error_code FROM jobs WHERE id=$1', [job.id]))[0]).toEqual({
      status: 'failed',
      error_code: 'BUDGET_BLOCKED',
    })
    expect(
      await query("SELECT id FROM audit_events WHERE kind='research_daily_budget_wait'"),
    ).toHaveLength(0)
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(1)
  })

  it.each(['spent', 'closed'])(
    'does not defer or reopen a campaign that already owns a %s reservation',
    async (condition) => {
      vi.spyOn(settings, 'config').mockReturnValue({
        ...settings.config(),
        MODEL_PROVIDER: 'yandex',
        SEARCH_PROVIDER: 'searxng',
        DAILY_BUDGET_KOPECKS: 15000,
        MONTHLY_BUDGET_KOPECKS: 300000,
      })
      await requestResearchCampaign()
      const first = (await claimJob(['research']))!
      const [reservation] = await query('SELECT * FROM budget_reservations WHERE dedupe_key=$1', [
        `research:${first.id}`,
      ])
      expect(reservation!.status).toBe('open')
      if (condition === 'spent') {
        await meteredCall({
          key: 'existing-envelope-spend',
          reservationId: reservation!.id,
          role: 'Исследователь',
          maximum: 9000,
          demo: false,
          invoke: async () => ({ value: 'Сохранённый результат', cost: 9000 }),
        })
      } else {
        await query("UPDATE budget_reservations SET status='closed' WHERE id=$1", [reservation!.id])
      }
      await finishJob(first, new Error('PROVIDER_HTTP_503'))
      await query('UPDATE jobs SET run_after=now() WHERE id=$1', [first.id])
      const retry = (await claimJob(['research']))!
      expect(retry.id).toBe(first.id)
      expect(retry.attempts).toBe(2)
      const invoke = vi.fn(async () => ({ value: 'Не должен выполняться', cost: 1500 }))
      const code = condition === 'spent' ? 'BUDGET_BLOCKED' : 'RESERVATION_CLOSED'
      if (condition === 'spent') {
        await expect(
          meteredCall({
            key: 'existing-envelope-extra',
            reservationId: reservation!.id,
            role: 'Критик',
            maximum: 1500,
            demo: false,
            invoke,
          }),
        ).rejects.toThrow(code)
      } else {
        await expect(runJob(retry)).rejects.toThrow(code)
      }
      await finishJob(retry, new Error(code))
      expect(invoke).not.toHaveBeenCalled()
      expect(
        (await query('SELECT status,error_code FROM jobs WHERE id=$1', [retry.id]))[0],
      ).toEqual({ status: 'failed', error_code: code })
      expect(await query('SELECT id FROM budget_reservations')).toHaveLength(1)
      expect(
        (
          await query('SELECT status,spent_kopecks FROM budget_reservations WHERE id=$1', [
            reservation!.id,
          ])
        )[0],
      ).toEqual({ status: 'closed', spent_kopecks: condition === 'spent' ? 9000 : 0 })
      expect(
        await query("SELECT id FROM audit_events WHERE kind='research_daily_budget_wait'"),
      ).toHaveLength(0)
    },
  )

  it('does not postpone a campaign behind midnight when the lifetime model cap is already spent', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'openai',
      SEARCH_PROVIDER: 'searxng',
      DAILY_BUDGET_KOPECKS: 15000,
      MONTHLY_BUDGET_KOPECKS: 300000,
      OPENAI_TOTAL_BUDGET_MICROUSD: 100,
    })
    const reservationId = await reserveBudget('lifetime-spent', 'research')
    await meteredCall({
      key: 'lifetime-spent-call',
      reservationId,
      role: 'Исследователь',
      maximum: 6000,
      maximumMicrousd: 100,
      demo: false,
      activity: { provider: 'openai', taskLabel: 'Проверка общего предела расходов' },
      invoke: async () => ({ value: 'Сохранённый результат', cost: 6000, microusd: 100 }),
    })
    await query("UPDATE budget_reservations SET status='closed' WHERE id=$1", [reservationId])
    await requestResearchCampaign()
    const job = (await claimJob(['research']))!
    expect(job.attempts).toBe(1)
    await expect(runJob(job)).rejects.toThrow('BUDGET_BLOCKED')
    await finishJob(job, new Error('BUDGET_BLOCKED'))
    expect((await query('SELECT status FROM jobs WHERE id=$1', [job.id]))[0]!.status).toBe('failed')
    expect(
      await query("SELECT id FROM audit_events WHERE kind='research_daily_budget_wait'"),
    ).toHaveLength(0)
    expect((await budgetSummary()).openaiSpentMicrousd).toBe(100)
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(1)
  })

  it('deduplicates concurrent portfolio requests and serializes claims across workers', async () => {
    expect(await researchCampaignStatus()).toBeNull()
    const requested = await Promise.all(Array.from({ length: 8 }, () => requestResearchCampaign()))
    expect(new Set(requested.map((value) => value.campaignId)).size).toBe(1)
    expect(requested.filter((value) => !value.existing)).toHaveLength(1)
    expect(await query("SELECT id FROM jobs WHERE kind='research'")).toHaveLength(templates.length)
    expect(
      await query("SELECT id FROM audit_events WHERE kind='research_campaign_requested'"),
    ).toHaveLength(1)
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimJob(['research'])))
    const first = claims.find(Boolean)!
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(first.payload.templates!)).toEqual([templates[0]])
    expect((await requestResearchCampaign()).campaignId).toBe(requested[0]!.campaignId)
    expect((await requestResearch('faq')).reused).toBe(true)
    expect(await researchCampaignStatus()).toMatchObject({
      total: templates.length,
      running: 1,
      pending: templates.length - 1,
    })
    await finishJob(first, new Error('MODEL_SCHEMA_INVALID'))
    const next = (await claimJob(['research']))!
    expect(JSON.parse(next.payload.templates!)).toEqual([templates[1]])
    await runJob(next)
    await finishJob(next)
    expect(await researchCampaignStatus(requested[0]!.campaignId)).toMatchObject({
      failed: 1,
      completed: 1,
      pending: templates.length - 2,
    })
  })

  it('keeps campaign jobs across midnight while expiring stale daily slots', async () => {
    const campaign = await requestResearchCampaign()
    const [tomorrow] = await query(
      "SELECT to_char((now() AT TIME ZONE 'UTC') + interval '1 day','YYYY-MM-DD') AS day",
    )
    const [yesterday] = await query(
      "SELECT to_char((now() AT TIME ZONE 'UTC') - interval '1 day','YYYY-MM-DD') AS day",
    )
    const stale = await enqueue('research', `research:${yesterday!.day}`)
    await query("UPDATE jobs SET created_at=now()-interval '2 days'")
    await expireResearchSlots(tomorrow!.day)
    expect(await researchCampaignStatus(campaign.campaignId)).toMatchObject({
      pending: templates.length,
      failed: 0,
    })
    expect((await query('SELECT status,error_code FROM jobs WHERE id=$1', [stale.id]))[0]).toEqual({
      status: 'failed',
      error_code: 'RESEARCH_SLOT_EXPIRED',
    })
    expect((await claimJob(['research']))!.payload.campaignId).toBe(campaign.campaignId)
  })

  it('cancels only queued research and releases only those reservations without erasing jobs', async () => {
    const created = await order()
    await sandboxPayment(created.id)
    const campaign = await requestResearchCampaign()
    const running = (await claimJob(['research']))!
    const [queued] = await query(
      "SELECT id FROM jobs WHERE status='queued' AND payload->>'campaignId'=$1 LIMIT 1",
      [campaign.campaignId],
    )
    const runningReservation = await reserveBudget(`research:${running.id}`, 'research')
    const queuedReservation = await reserveBudget(`research:${queued!.id}`, 'research')
    const cancelled = await cancelResearchCampaign(campaign.campaignId)
    expect(cancelled.cancelled).toBe(templates.length - 1)
    expect(await cancelResearchCampaign(campaign.campaignId)).toMatchObject({ cancelled: 0 })
    expect(await researchCampaignStatus(campaign.campaignId)).toMatchObject({
      cancelled: templates.length - 1,
      running: 1,
      failed: 0,
      pending: 0,
    })
    expect(
      (await query('SELECT status FROM budget_reservations WHERE id=$1', [runningReservation]))[0]!
        .status,
    ).toBe('open')
    expect(
      (await query('SELECT status FROM budget_reservations WHERE id=$1', [queuedReservation]))[0]!
        .status,
    ).toBe('closed')
    expect((await query('SELECT status FROM orders WHERE id=$1', [created.id]))[0]!.status).toBe(
      'paid',
    )
    expect(
      await query("SELECT id FROM audit_events WHERE kind='research_campaign_cancelled'"),
    ).toHaveLength(1)
    await runJob(running)
    await finishJob(running)
    expect(await researchCampaignStatus(campaign.campaignId)).toMatchObject({
      status: 'cancelled',
      completed: 1,
      cancelled: templates.length - 1,
    })
    expect(await claimJob(['research'])).toBeUndefined()
    expect((await claimJob(['fulfill']))!.payload.orderId).toBe(created.id)
    await expect(cancelResearchCampaign(randomUUID())).rejects.toThrow(
      'RESEARCH_CAMPAIGN_NOT_FOUND',
    )
    expect((await requestResearchCampaign()).campaignId).not.toBe(campaign.campaignId)
  })

  it('preserves pause, emergency stop, research window and budget limits for a campaign', async () => {
    const campaign = await requestResearchCampaign()
    for (const mode of ['paused', 'emergency_stop']) {
      await query('UPDATE system_state SET mode=$1', [mode])
      await expect(requestResearchCampaign()).rejects.toThrow('RESEARCH_PAUSED')
      expect(await claimJob(['research'])).toBeUndefined()
    }
    await query("UPDATE system_state SET mode='running',research_enabled=false")
    await expect(requestResearchCampaign()).rejects.toThrow('RESEARCH_WINDOW_CLOSED')
    expect(await claimJob(['research'])).toBeUndefined()
    await query('UPDATE system_state SET research_enabled=true')
    const job = (await claimJob(['research']))!
    const original = settings.config()
    const config = vi.spyOn(settings, 'config').mockReturnValue({
      ...original,
      MODEL_PROVIDER: 'yandex',
      SEARCH_PROVIDER: 'yandex',
      DAILY_BUDGET_KOPECKS: 1,
    })
    const search = vi.spyOn(providers, 'search')
    await expect(runJob(job)).rejects.toThrow('BUDGET_BLOCKED')
    await finishJob(job, new Error('BUDGET_BLOCKED'))
    expect(search).not.toHaveBeenCalled()
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(0)
    expect(await query('SELECT id FROM budget_reservations')).toHaveLength(0)
    expect(await researchCampaignStatus(campaign.campaignId)).toMatchObject({
      failed: 1,
      pending: templates.length - 1,
    })
    config.mockReturnValue(original)
    const next = (await claimJob(['research']))!
    await runJob(next)
    await finishJob(next)
    expect(await researchCampaignStatus(campaign.campaignId)).toMatchObject({
      failed: 1,
      completed: 1,
      pending: templates.length - 2,
    })
  })
})

describe('frozen social service recipes', () => {
  const material =
    'Мастерская выпустила пеналы. Скидка на пеналы составляет 10%. Только по субботам. Карандаши не входят в комплект.'

  async function publishSocial(provider: 'demo' | 'ollama' | 'openrouter' | 'openai') {
    const config = vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: provider,
      SEARCH_PROVIDER: provider === 'demo' ? 'demo' : 'searxng',
    })
    const search = vi.spyOn(providers, 'search').mockResolvedValue([
      {
        url: 'https://example.com/text-services',
        title: 'Предложение текстовых услуг',
        snippet: 'Текстовые услуги по материалам заказчика.',
        observedAt: new Date().toISOString(),
        demo: provider === 'demo',
      },
      {
        url: 'https://example.org/text-editors',
        title: 'Текстовые редакторы',
        snippet: 'Бесплатные инструменты для оформления текста.',
        observedAt: new Date().toISOString(),
        demo: provider === 'demo',
      },
    ])
    // The provider output is a fixture; product publication, versioning and the queue stay real.
    const model = vi
      .spyOn(providers, 'model')
      .mockImplementation(async (args: any) => args.schema.parse(args.demoValue))
    try {
      await requestResearch('social')
      const job = (await claimJob(['research']))!
      await runJob(job)
      await finishJob(job)
      return (await query("SELECT * FROM products WHERE template='social'"))[0]!
    } finally {
      model.mockRestore()
      search.mockRestore()
      config.mockRestore()
    }
  }

  it('refuses an older social recipe on Ollama before creating an order or budget reservation', async () => {
    const product = await publishSocial('demo')
    const original = structuredClone(product.spec)
    expect(original.promise).not.toBe(sourceSocialDelivery)
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'ollama',
      SEARCH_PROVIDER: 'searxng',
    })
    await expect(createOrder(product.id, material, randomUUID())).rejects.toThrow(
      'PRODUCT_RECIPE_REFRESH_REQUIRED',
    )
    expect(await query('SELECT id FROM orders')).toHaveLength(0)
    expect(await query("SELECT id FROM budget_reservations WHERE category='order'")).toHaveLength(0)
    expect((await query('SELECT spec FROM products WHERE id=$1', [product.id]))[0]!.spec).toEqual(
      original,
    )
  })

  it.each(['ollama', 'openrouter'] as const)(
    'publishes the full-source promise on %s and rejects oversized material before accepting payment obligations',
    async (provider) => {
      const product = await publishSocial(provider)
      expect(product.spec.promise).toBe(sourceSocialDelivery)
      expect((await productHistory(product.id)).versions[0]!.spec.promise).toBe(
        sourceSocialDelivery,
      )
      const tooLong = 'Материал мастерской. ' + 'А'.repeat(3001 - 'Материал мастерской. '.length)
      expect(tooLong).toHaveLength(3001)
      // The frozen recipe enforces its own limit even after changing to another provider.
      await expect(createOrder(product.id, tooLong, randomUUID())).rejects.toThrow(
        'INPUT_SOCIAL_LENGTH',
      )
      expect(await query('SELECT id FROM orders')).toHaveLength(0)
      expect(await query("SELECT id FROM budget_reservations WHERE category='order'")).toHaveLength(
        0,
      )
    },
  )

  it('sends an incompatible paid snapshot to review on its first attempt without a model call', async () => {
    const product = await publishSocial('demo')
    const originalPromise = product.spec.promise
    const created = await createOrder(product.id, material, randomUUID())
    await sandboxPayment(created.id)
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'ollama',
      SEARCH_PROVIDER: 'searxng',
    })
    const model = vi.spyOn(providers, 'model')
    const job = (await claimJob(['fulfill']))!
    expect(job.attempts).toBe(1)
    expect(job.max_attempts).toBeGreaterThan(1)
    await expect(runJob(job)).rejects.toThrow('PRODUCT_RECIPE_REFRESH_REQUIRED')
    await finishJob(job, new Error('PRODUCT_RECIPE_REFRESH_REQUIRED'))
    expect(model).not.toHaveBeenCalled()
    expect(await query('SELECT id FROM tool_calls WHERE job_id=$1', [job.id])).toHaveLength(0)
    expect(
      (await query('SELECT status,attempts,error_code FROM jobs WHERE id=$1', [job.id]))[0],
    ).toEqual({ status: 'failed', attempts: 1, error_code: 'PRODUCT_RECIPE_REFRESH_REQUIRED' })
    const [saved] = await query(
      'SELECT status,result,product_snapshot,paid_at,reservation_id FROM orders WHERE id=$1',
      [created.id],
    )
    expect(saved!.status).toBe('manual_review')
    expect(saved!.result).toBeNull()
    expect(saved!.paid_at).toBeInstanceOf(Date)
    expect(saved!.product_snapshot).toMatchObject({ version: 1, promise: originalPromise })
    expect(
      (
        await query('SELECT status FROM budget_reservations WHERE id=$1', [saved!.reservation_id])
      )[0]?.status,
    ).toBe('closed')
    expect(await claimJob(['fulfill'])).toBeUndefined()
  })

  it('keeps an order recipe unchanged when a later research publishes a different promise', async () => {
    const product = await publishSocial('ollama')
    const created = await createOrder(product.id, material, randomUUID())
    const newer = await publishSocial('openai')
    expect(newer.id).toBe(product.id)
    expect(newer.version).toBe(2)
    expect(newer.spec.promise).toBe(recipes.social.delivery)
    expect(newer.spec.promise).not.toBe(sourceSocialDelivery)
    expect(
      (await query('SELECT product_snapshot FROM orders WHERE id=$1', [created.id]))[0]!
        .product_snapshot,
    ).toMatchObject({ version: 1, promise: sourceSocialDelivery })
    expect(
      (await productHistory(product.id)).versions.map((version) => version.spec.promise),
    ).toEqual([recipes.social.delivery, sourceSocialDelivery])
  })

  it('fulfills the saved full-source recipe after switching to demo without rewriting its promise', async () => {
    const product = await publishSocial('ollama')
    const created = await createOrder(product.id, material, randomUUID())
    expect(settings.config().MODEL_PROVIDER).toBe('demo')
    await sandboxPayment(created.id)
    const job = (await claimJob(['fulfill']))!
    await runJob(job)
    await finishJob(job)
    const [saved] = await query('SELECT status,result,product_snapshot FROM orders WHERE id=$1', [
      created.id,
    ])
    expect(saved!.status).toBe('delivered')
    expect(saved!.product_snapshot).toMatchObject({ version: 1, promise: sourceSocialDelivery })
    const normalized = saved!.result.replace(/\s+/gu, ' ')
    expect(normalized.split(material).length - 1).toBe(3)
    expect(
      (await query('SELECT spec FROM products WHERE id=$1', [product.id]))[0]!.spec.promise,
    ).toBe(sourceSocialDelivery)
    await runJob(job)
    expect(
      await query(
        "SELECT id FROM audit_events WHERE kind='order_delivered' AND data->>'orderId'=$1",
        [created.id],
      ),
    ).toHaveLength(1)
  })
})

describe('free OpenRouter accounting', () => {
  function freeConfig() {
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'openrouter',
      SEARCH_PROVIDER: 'searxng',
      OPENROUTER_API_KEY: 'test-only-key',
      OPENROUTER_MODEL: 'openrouter/free',
    })
  }
  function cloudResponse(cost = 0) {
    return new Response(
      JSON.stringify({
        id: 'test-generation',
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content: '{"text":"checked"}' } },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, cost },
      }),
    )
  }
  it('uses a zero reservation and persists one external call under concurrent claims', async () => {
    freeConfig()
    const reservationId = await reserveBudget('free-cloud', 'research')
    expect(
      (await query('SELECT limit_kopecks FROM budget_reservations WHERE id=$1', [reservationId]))[0]
        ?.limit_kopecks,
    ).toBe(0)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => cloudResponse())
    const call = {
      key: 'free-cloud',
      reservationId,
      role: 'Исследователь',
      context: { input: 'facts' },
      schema: z.object({ text: z.string() }),
      demoValue: { text: 'demo' },
    }
    const results = await Promise.allSettled([providers.model(call), providers.model(call)])
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason.message).toBe('UNCERTAIN_CALL_REQUIRES_REVIEW')
    expect(await providers.model(call)).toEqual({ text: 'checked' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(
      (
        await query(
          'SELECT status,provider,is_demo,input_tokens,output_tokens,charged_kopecks,charged_microusd,actual_microusd FROM tool_calls',
        )
      )[0],
    ).toEqual({
      status: 'done',
      provider: 'openrouter',
      is_demo: false,
      input_tokens: 50,
      output_tokens: 10,
      charged_kopecks: 0,
      charged_microusd: 0,
      actual_microusd: 0,
    })
    expect(await budgetSummary()).toMatchObject({
      outstanding: 0,
      openrouterSpentMicrousd: 0,
      openrouterActualMicrousd: 0,
    })
  })
  it('rejects any paid reserve before invoking the provider', async () => {
    freeConfig()
    const reservationId = await reserveBudget('free-envelope', 'order')
    const invoke = vi.fn(async () => ({ value: 'checked', cost: 0, microusd: 0 }))
    const call = {
      key: 'free-envelope',
      reservationId,
      role: 'Исполнитель',
      demo: false,
      activity: { provider: 'openrouter', model: 'openrouter/free', taskLabel: 'test' },
      invoke,
    }
    await expect(meteredCall({ ...call, maximum: 1 })).rejects.toThrow(
      'OPENROUTER_FREE_MODEL_REQUIRED',
    )
    await expect(meteredCall({ ...call, maximum: 0, maximumMicrousd: 1 })).rejects.toThrow(
      'OPENROUTER_FREE_MODEL_REQUIRED',
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(await query('SELECT id FROM tool_calls')).toHaveLength(0)
  })
  it('preserves an unexpected charge and blocks subsequent calls without retrying', async () => {
    freeConfig()
    const reservationId = await reserveBudget('unexpected-cloud-charge', 'order')
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => cloudResponse(0.000001))
    const call = {
      key: 'unexpected-cloud-charge',
      reservationId,
      role: 'Исполнитель',
      context: { input: 'facts' },
      schema: z.object({ text: z.string() }),
      demoValue: { text: 'demo' },
    }
    await expect(providers.model(call)).rejects.toThrow('OPENROUTER_COST_REVIEW_REQUIRED')
    await expect(providers.model({ ...call, key: 'another-cloud-call' })).rejects.toThrow(
      'OPENROUTER_COST_REVIEW_REQUIRED',
    )
    await expect(providers.model(call)).rejects.toThrow('UNCERTAIN_CALL_REQUIRES_REVIEW')
    expect(fetch).toHaveBeenCalledOnce()
    expect((await query('SELECT status,actual_microusd,error_code FROM tool_calls'))[0]).toEqual({
      status: 'uncertain',
      actual_microusd: 1,
      error_code: 'OPENROUTER_COST_REVIEW_REQUIRED',
    })
    expect((await budgetSummary()).openrouterActualMicrousd).toBe(1)
  })
})

describe('global budget under concurrency', () => {
  function paidConfig(extra: Partial<settings.Config> = {}) {
    const original = settings.config()
    vi.spyOn(settings, 'config').mockReturnValue({
      ...original,
      MODEL_PROVIDER: 'yandex',
      DAILY_BUDGET_KOPECKS: 15000,
      MONTHLY_BUDGET_KOPECKS: 300000,
      RESEARCH_RESERVE_KOPECKS: 10000,
      ...extra,
    })
  }
  it('never gives simultaneous research tasks independent budgets', async () => {
    paidConfig()
    const results = await Promise.allSettled([
      reserveBudget('a', 'research'),
      reserveBudget('b', 'research'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await budgetSummary()).outstanding).toBe(10000)
  })
  it('settles actual cost and replays a saved call without another charge', async () => {
    paidConfig()
    const reservationId = await reserveBudget('a', 'research')
    const invoke = vi.fn(async () => ({ value: { text: 'ok' }, cost: 150 }))
    const call = { key: 'one', reservationId, role: 'test', maximum: 500, demo: false, invoke }
    expect(await meteredCall(call)).toEqual({ text: 'ok' })
    expect(await meteredCall(call)).toEqual({ text: 'ok' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(await budgetSummary()).toMatchObject({ daySpent: 150, outstanding: 9850 })
  })
  it('keeps ambiguous charges and refuses an unsafe retry', async () => {
    paidConfig()
    const reservationId = await reserveBudget('a', 'research')
    const invoke = vi.fn(async () => {
      throw new Error('NETWORK_TIMEOUT')
    })
    const call = { key: 'unknown', reservationId, role: 'test', maximum: 500, demo: false, invoke }
    await expect(meteredCall(call)).rejects.toThrow('NETWORK_TIMEOUT')
    await expect(meteredCall(call)).rejects.toThrow('UNCERTAIN_CALL_REQUIRES_REVIEW')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await budgetSummary()).daySpent).toBe(500)
  })
  it('blocks the tool before making a network call when its envelope is exhausted', async () => {
    paidConfig()
    const reservationId = await reserveBudget('a', 'research')
    const invoke = vi.fn(async () => ({ value: 'no', cost: 1 }))
    await expect(
      meteredCall({
        key: 'large',
        reservationId,
        role: 'test',
        maximum: 10001,
        demo: false,
        invoke,
      }),
    ).rejects.toThrow('BUDGET_BLOCKED')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('counts reservations carried over midnight', async () => {
    paidConfig()
    await reserveBudget('old', 'research')
    await query("UPDATE budget_reservations SET created_at=now()-interval '2 days'")
    await expect(reserveBudget('new', 'research')).rejects.toThrow('BUDGET_BLOCKED')
  })
})

describe('owner authentication', () => {
  it('rejects passwords, accepts a session, and respects revocation', async () => {
    await expect(attemptLogin('wrong', '127.0.0.1')).rejects.toThrow('LOGIN_FAILED')
    const token = await attemptLogin(settings.config().OWNER_PASSWORD, '127.0.0.1')
    expect(await validSession(token)).toBe(true)
    expect(await validSession(token + 'x')).toBe(false)
    await query('DELETE FROM sessions WHERE token_hash=$1', [digest(token)])
    expect(await validSession(token)).toBe(false)
  })
  it('rate limits repeated password guesses', async () => {
    for (let i = 0; i < 8; i++)
      await expect(attemptLogin('wrong', '127.0.0.2')).rejects.toThrow('LOGIN_FAILED')
    await expect(attemptLogin(settings.config().OWNER_PASSWORD, '127.0.0.2')).rejects.toThrow(
      'LOGIN_RATE_LIMIT',
    )
  })
})
