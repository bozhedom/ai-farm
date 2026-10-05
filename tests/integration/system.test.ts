import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import { budgetSummary, meteredCall, reserveBudget } from '../../core/budget'
import {
  claimJob,
  enqueue,
  finishJob,
  recoverJobs,
  expireResearchSlots,
  requestResearch,
} from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import type { Template } from '../../core/policy'
import * as providers from '../../core/providers'
import { createOrder, orderDetails } from '../../core/orders'
import { paymentHash, paymentReceiver, paymentRpc } from '../fixtures/sepolia'
import type { Invoice } from '../../core/payments'
import { sandboxPayment, submitTransaction, reconcilePayments } from '../../core/payments'
import { simulateEvolution, evaluateWeek } from '../../core/evolution'
import { attemptLogin, validSession, digest } from '../../core/auth'
import { reportUsage } from '../../core/activity'
import { productHistory } from '../../core/products'
import { recipes } from '../../core/templates'
import { scheduleWork, setSchedule, autonomyStatus, type AutonomyState } from '../../core/autonomy'

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
    expect(calls).toHaveLength(6)
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
  it('builds and fulfills all three server recipes through the same versioned pipeline', async () => {
    for (const template of ['description', 'faq', 'social'] as const) {
      await requestResearch(template)
      const job = (await claimJob(['research']))!
      await runJob(job)
      await finishJob(job)
      const [product] = await query('SELECT * FROM products WHERE template=$1', [template])
      expect(product!.checks).toMatchObject({ input: recipes[template].fixture, normal: 'PASS' })
      expect(product!.spec.promise).toBe(recipes[template].delivery)
      const created = await createOrder(product!.id, recipes[template].fixture, randomUUID())
      await sandboxPayment(created.id)
      const delivery = (await claimJob(['fulfill']))!
      await runJob(delivery)
      await finishJob(delivery)
      expect((await query('SELECT status FROM orders WHERE id=$1', [created.id]))[0]!.status).toBe(
        'delivered',
      )
    }
    expect(await query('SELECT id FROM products')).toHaveLength(3)
    expect(await query('SELECT * FROM product_versions')).toHaveLength(3)
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
