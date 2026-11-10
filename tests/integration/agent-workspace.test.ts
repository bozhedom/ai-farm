import { managerModelArgs } from '../../core/manager/runtime'
import { enqueue } from '../../core/queue'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { pool, query, transaction } from '../../core/db'
import { applyMigrations, resetDatabase } from './helpers/db'
import {
  addContext,
  deleteContext,
  profilesView,
  saveProfile,
  withAgentProfiles,
  withModelRole,
  currentModel,
  modelRoles,
  rolePricing,
  roleContext,
  saveModelSelection,
} from '../../core/agent-profiles'
import { applyTradingInstructions } from '../../core/trading/instructions'
import { tradingInstructions } from '../../core/trading/owner-rules'
import { prepareModelRequest } from '../../core/providers'
import { paidRequestEnvelope } from '../../core/providers/openrouter-paid'
import { openaiMaximum } from '../../core/providers/openai-cost'
import { reviewSchema } from '../../core/policy'
import { updateFarmSettings, requestScout } from '../../core/autonomy'
import { budgetSummary, reserveBudget } from '../../core/budget'
import { decideIdea } from '../../core/idea-actions'
import { scheduleIdeaResearch } from '../../core/jobs/report'
import { officeIdea } from '../../core/office'
import * as settings from '../../core/config'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(() => pool.end())

it('uses the global mini model and budget tariff for every role, including assistant and instruction parsing', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
    OPENROUTER_PAID_MODEL: 'openai/gpt-4.1-mini',
  })
  const roles = [
    ...modelRoles.map((r) => r.name),
    'Помощник кабинета',
    'Разбор торговых инструкций',
  ]
  await withAgentProfiles(async () => {
    for (const role of roles)
      withModelRole(role, () => {
        expect(currentModel()).toBe('openai/gpt-4.1-mini')
        expect(paidRequestEnvelope(100).provider.max_price).toEqual({
          prompt: 0.4,
          completion: 1.6,
          request: 0,
        })
        expect(openaiMaximum(1000, 100, rolePricing(role))).toBe(660)
      })
  })
  await query('INSERT INTO agent_profiles(role,model,pricing) VALUES($1,$2,$3)', [
    'critic',
    'openai/gpt-6-astra',
    { inputNano: 10000, outputNano: 50000 },
  ])
  await withAgentProfiles(async () => {
    withModelRole('Критик', () => {
      expect(currentModel()).toBe('openai/gpt-6-astra')
      expect(paidRequestEnvelope(100).reasoning).toEqual({ effort: 'low', exclude: true })
      expect(openaiMaximum(1000, 100, rolePricing('Критик'))).toBe(17500)
    })
    withModelRole('Помощник кабинета', () => expect(currentModel()).toBe('openai/gpt-4.1-mini'))
  })
})

it('passes role instructions and scoped context into the actual costed request, and deletes future context', async () => {
  await saveProfile({
    role: 'critic',
    instruction: 'Проверь покупателей из отрасли ремонта.',
    model: '',
    revision: 0,
  })
  const added = await addContext({
    role: 'critic',
    title: 'Ремонт',
    content: 'Команда умеет писать инструкции для мастерских.',
  })
  await addContext({ role: 'manager', title: 'Paper', content: 'Наблюдать комиссии.' })
  const args = {
    role: 'Критик',
    key: 'preview',
    reservationId: '',
    context: {},
    schema: reviewSchema,
    demoValue: { verdict: 'PASS' as const, reason: 'ok' },
  }
  const baseline = prepareModelRequest(args)
  await withAgentProfiles(async () => {
    const request = prepareModelRequest(args)
    expect(request.system).toContain('Проверь покупателей')
    expect(request.system).toContain('Ты независимый критик')
    expect(JSON.parse(request.context).ownerContext).toEqual([
      { id: added.id, title: 'Ремонт', content: 'Команда умеет писать инструкции для мастерских.' },
    ])
    expect(request.context.length).toBeGreaterThan(baseline.context.length)
  })
  await deleteContext(added.id)
  await withAgentProfiles(async () => expect(roleContext('Критик')).toEqual([]))
  expect((await profilesView()).roles).toHaveLength(12)
  expect(await query("SELECT * FROM audit_events WHERE kind='agent_context_deleted'")).toHaveLength(
    1,
  )
})

it('rejects stale concurrent profile edits and overlarge shared context', async () => {
  const profile = { role: 'director', instruction: 'Проверять расходы.', model: '', revision: 0 }
  const results = await Promise.allSettled([saveProfile(profile), saveProfile(profile)])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  await addContext({ role: 'all', title: 'Первый', content: 'а'.repeat(12000) })
  await expect(
    addContext({ role: 'all', title: 'Второй', content: 'б'.repeat(5000) }),
  ).rejects.toThrow('CONTEXT_LIMIT')
})

it('changes the real OpenRouter envelope per role without relaxing its price or tool restrictions', async () => {
  const c = settings.config()
  vi.spyOn(settings, 'config').mockReturnValue({
    ...c,
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'vendor/test-model',
                name: 'Test',
                context_length: 128000,
                pricing: { prompt: '0.000001', completion: '0.000002' },
                supported_parameters: ['structured_outputs'],
                architecture: { input_modalities: ['text'] },
              },
            ],
          }),
        ),
    ),
  )
  try {
    await saveProfile({ role: 'critic', instruction: '', model: 'vendor/test-model', revision: 0 })
    await expect(
      saveProfile({ role: 'browser', instruction: '', model: 'vendor/test-model', revision: 0 }),
    ).rejects.toThrow('MODEL_UNSUPPORTED')
    await withAgentProfiles(async () => {
      await Promise.all([
        withModelRole('Критик', async () => {
          await Promise.resolve()
          expect(currentModel()).toBe('vendor/test-model')
          expect(paidRequestEnvelope(2000)).toMatchObject({
            model: 'vendor/test-model',
            provider: {
              require_parameters: true,
              allow_fallbacks: false,
              max_price: { prompt: 1, completion: 2, request: 0 },
            },
          })
        }),
        withModelRole('Исследователь', async () =>
          expect(currentModel()).toBe('openai/gpt-6-astra'),
        ),
      ])
    })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('changes a trading model with an exhausted budget without applying text or altering trading rules', async () => {
  await applyTradingInstructions({
    role: 'manager',
    instruction: 'Не покупать BTC',
    model: '',
    revision: 0,
    instructionsRevision: 0,
    requestId: randomUUID(),
  })
  const rules = await tradingInstructions()
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
    OPENAI_TOTAL_BUDGET_MICROUSD: 0,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'vendor/cheap',
              name: 'Cheap',
              context_length: 32000,
              pricing: { prompt: '0.0000001', completion: '0.0000004' },
              supported_parameters: ['structured_outputs'],
            },
          ],
        }),
      ),
    ),
  )
  const changed = await saveModelSelection({ role: 'manager', model: 'vendor/cheap', revision: 1 })
  expect(changed.revision).toBe(2)
  expect(await tradingInstructions()).toEqual({ ...rules, profileRevision: 2 })
  expect((await profilesView()).roles.find((r) => r.id === 'manager')).toMatchObject({
    instruction: 'Не покупать BTC',
    model: 'vendor/cheap',
    revision: 2,
  })
  expect(await query('SELECT * FROM tool_calls')).toHaveLength(0)
  await expect(saveModelSelection({ role: 'manager', model: '', revision: 1 })).rejects.toThrow(
    'PROFILE_CHANGED',
  )
  expect((await tradingInstructions()).rules).toEqual(rules.rules)
})

it('admits a small-context model but refuses an oversized request before making a paid call', async () => {
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'vendor/tiny',
              name: 'Tiny',
              context_length: 2048,
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        }),
      ),
    ),
  )
  await saveModelSelection({ role: 'critic', model: 'vendor/tiny', revision: 0 })
  await withAgentProfiles(async () => {
    expect(() =>
      prepareModelRequest({
        role: 'Критик',
        key: 'tiny',
        reservationId: '',
        context: {},
        schema: reviewSchema,
        demoValue: { verdict: 'PASS', reason: '' },
      }),
    ).toThrow('MODEL_CONTEXT_TOO_SMALL')
  })
  expect(fetch).toHaveBeenCalledOnce()
  expect(await query('SELECT * FROM tool_calls')).toHaveLength(0)
})

it('enforces owner money ceilings in the ledger and keeps server maxima', async () => {
  const c = settings.config()
  vi.spyOn(settings, 'config').mockReturnValue({
    ...c,
    MODEL_PROVIDER: 'openai',
    DAILY_BUDGET_KOPECKS: 120000,
    MONTHLY_BUDGET_KOPECKS: 1080000,
    SCOUT_RESERVE_KOPECKS: 100,
  })
  await updateFarmSettings({ dailyBudgetKopecks: 150, monthlyBudgetKopecks: 1080000 })
  const results = await Promise.allSettled([
    reserveBudget('a', 'scout'),
    reserveBudget('b', 'scout'),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect((await budgetSummary()).dailyLimit).toBe(150)
  await expect(updateFarmSettings({ dailyBudgetKopecks: 120001 })).rejects.toThrow(
    'SETTINGS_SERVER_LIMIT',
  )
  await updateFarmSettings({ dailyBudgetKopecks: 0 })
  await expect(reserveBudget('c', 'scout')).rejects.toThrow('BUDGET_BLOCKED')
})

it('supports all daily hours and zero ideas without sending a request', async () => {
  await updateFarmSettings({ scheduleHourUtc: 23, ideaDailyLimit: 0 })
  await expect(requestScout()).rejects.toThrow('IDEAS_DAILY_LIMIT')
  expect(await query("SELECT * FROM jobs WHERE kind='scout'")).toEqual([])
})

async function idea(rank = 100, verdict = 'PASS') {
  const [agent] = await query('SELECT id FROM strategies LIMIT 1')
  const id = randomUUID()
  const job = await enqueue('scout', `test-idea:${id}`, {})
  await query(
    `INSERT INTO ideas(id,job_id,strategy_id,generation,topic_id,category,title,fingerprint,research,evidence,critique,farm_executable,suggested_template,rank_score,status,is_demo)
    VALUES($1::uuid,$5,$2,1,'product-cards','marketplaces',$1::text,$1::text,'{}','[]',$3,true,'description',$4,'new',true)`,
    [id, agent!.id, { verdict, reason: 'Проверка' }, rank, job.id],
  )
  return id
}

it('queues a 100-point product once and does not bypass critic, daily quota or stops', async () => {
  const id = await idea()
  const results = await Promise.all([
    decideIdea(id, { action: 'build' }),
    decideIdea(id, { action: 'build' }),
  ])
  expect(results[0].jobId).toBe(results[1].jobId)
  expect((await officeIdea(id)).buildState).toBe('queued')
  const rejected = await idea(100, 'BLOCKED')
  await expect(decideIdea(rejected, { action: 'approve' })).rejects.toThrow('IDEA_REVIEW_REQUIRED')
  const another = await idea()
  await updateFarmSettings({ ideaProductsPerDay: 0 })
  await expect(decideIdea(another, { action: 'build' })).rejects.toThrow(
    'IDEA_PRODUCTS_DAILY_LIMIT',
  )
  expect((await officeIdea(another)).status).toBe('new')
  await query("UPDATE system_state SET mode='emergency_stop'")
  await expect(
    decideIdea(another, { action: 'revise', brief: 'Уточнить задачу и источник спроса.' }),
  ).rejects.toThrow('RESEARCH_PAUSED')
})

it('prioritizes the highest rank and retains the original evidence when the owner revises', async () => {
  const low = await idea(80),
    high = await idea(100)
  await decideIdea(low, { action: 'approve' })
  await decideIdea(high, { action: 'approve' })
  const picked = await transaction((db) => scheduleIdeaResearch(db, 1, false))
  expect(picked.map((r) => r.id)).toEqual([high])
  const before = await officeIdea(low)
  await decideIdea(low, { action: 'revise', brief: 'Проверить спрос у небольших мастерских.' })
  const after = await officeIdea(low)
  expect(after.research).toEqual(before.research)
  expect(after.critique).toEqual(before.critique)
  expect(after.status).toBe('needs_human')
  const [job] = await query("SELECT payload FROM jobs WHERE payload->>'ownerIdeaId'=$1", [low])
  expect(job!.payload.ownerBrief).toContain('мастерских')
})

it('separates a running paper portfolio from a connected live direction', async () => {
  const { directionReadiness } = await import('../../core/earnings/readiness')
  const { ensurePortfolios } = await import('../../core/trading/store')
  await ensurePortfolios()
  await query('UPDATE system_state SET worker_heartbeat=now() WHERE id=true')
  await query("UPDATE trading_portfolios SET status='running' WHERE mode='paper'")
  const rows = await directionReadiness()
  const bybit = rows.find((r) => r.id === 'spot-bybit')!
  expect(bybit.status).toBe('требует подключения')
  expect(bybit.active).toBe(false)
  expect(bybit.detail).toContain('Paper: активен')
  expect(rows.find((r) => r.id === 'polymarket')).toMatchObject({
    status: 'не используется',
    active: false,
  })
  await query("UPDATE system_state SET worker_heartbeat=now()-interval '10 minutes' WHERE id=true")
  expect((await directionReadiness()).every((r) => !r.active)).toBe(true)
})

it('shows a budget-blocked browser as inactive without treating it as a technical failure', async () => {
  const { directionReadiness } = await import('../../core/earnings/readiness')
  vi.spyOn(settings, 'config').mockReturnValue({
    ...settings.config(),
    COMPUTER_USE_ENABLED: true,
    VM_AGENT_URL: 'http://vm.invalid',
  })
  await query('UPDATE system_state SET worker_heartbeat=now() WHERE id=true')
  await query(
    "INSERT INTO computer_use(id,enabled,failures,last_error) VALUES(true,true,0,'OPENAI_BUDGET_BLOCKED')",
  )
  expect((await directionReadiness()).find((r) => r.id === 'computer')).toMatchObject({
    active: false,
    status: 'подключено',
    activity: 'Ожидает бюджета или обновления лимита',
  })
  await query("UPDATE computer_use SET last_error='' WHERE id=true")
  expect((await directionReadiness()).find((r) => r.id === 'computer')!.active).toBe(true)
})

it('launch shows model activity separately from search and retains current nonfailure budget stops', async () => {
  const { launchInput } = await import('../../core/launch/view')
  const reservation = await reserveBudget('launch-observation', 'scout')
  for (const [provider, created] of [
    ['ollama', '2026-10-03T12:00:00Z'],
    ['searxng', '2026-11-03T12:00:00Z'],
  ]) {
    await query(
      `INSERT INTO tool_calls(id,call_key,reservation_id,role,status,reserved_kopecks,is_demo,provider,created_at)
      VALUES($1,$2,$3,$2,'done',0,false,$2,$4)`,
      [randomUUID(), provider, reservation, created],
    )
  }
  await query(
    "INSERT INTO computer_use(id,enabled,failures,last_error) VALUES(true,true,0,'OPENAI_BUDGET_BLOCKED')",
  )
  const view = await launchInput()
  expect(view.model.lastSuccessAt).toBe('2026-10-03T12:00:00.000Z')
  expect(view.computer.lastError).toBe('OPENAI_BUDGET_BLOCKED')
})

it('includes trading instructions and materials in the exact manager request without weakening its capabilities', async () => {
  await saveProfile({
    role: 'manager',
    instruction: 'Проверяй комиссии до гипотезы.',
    model: '',
    revision: 0,
  })
  await addContext({
    role: 'manager',
    title: 'Эксперимент',
    content: 'Сравнить просадку двух подходов.',
  })
  await addContext({ role: 'critic', title: 'Не торговля', content: 'Карточки товаров.' })
  await withAgentProfiles(async () => {
    const args = managerModelArgs(
      { at: '', portfolios: [], recentTasks: [] },
      { id: 'preview', reservationId: '' },
    )
    const request = prepareModelRequest(args)
    expect(request.system).toContain('Проверяй комиссии до гипотезы.')
    const context = JSON.parse(request.context)
    expect(context.ownerContext).toHaveLength(1)
    expect(context.ownerContext[0].title).toBe('Эксперимент')
    expect(context.capabilities).toContain('Не предлагай запуск')
    expect(context.capabilities).toContain('Live')
  })
})
