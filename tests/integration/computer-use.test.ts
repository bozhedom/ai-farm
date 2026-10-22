import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, type EventHandler } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as settings from '../../core/config'
import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { FakeVmAgent } from '../../core/computer-use/client'
import { COMPUTER_USE_POLICY as P } from '../../core/computer-use/policy'
import {
  addOwnerGoal,
  cancelTask,
  computerUseTick,
  controlComputerUse,
  resolveApproval,
  screenshotRoot,
} from '../../core/computer-use/runtime'
import { computerUseView } from '../../core/computer-use/view'
import type { ComputerUseModel, ModelInput } from '../../core/computer-use/model'
import { astraStep, demoScript, prepareStepRequest } from '../../core/computer-use/model'
import { rotationGoals } from '../../core/computer-use/goals'
import { usdToKopecks } from '../../core/providers/openai-cost'
import security from '../../server/middleware/security'
import view from '../../server/api/computer-use/index.get'
import control from '../../server/api/computer-use/control.post'
import goals from '../../server/api/computer-use/goals.post'
import approvals from '../../server/api/computer-use/approvals/[id].post'
import screenshot from '../../server/api/computer-use/steps/[id]/screenshot.png.get'
import { applyMigrations, resetDatabase } from './helpers/db'

const original = settings.config()
const origin = 'http://localhost:3210'
let server: Server
let base = ''

beforeAll(async () => {
  await applyMigrations()
  const app = createApp()
  app.use(security)
  const router = createRouter()
  router.get('/api/computer-use', view)
  router.get('/api/computer-use/steps/:id/screenshot.png', screenshot)
  router.post('/api/computer-use/control', control)
  router.post('/api/computer-use/goals', goals)
  router.post('/api/computer-use/approvals/:id', approvals)
  app.use(router)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  await resetDatabase()
  await query('INSERT INTO computer_use(id) VALUES(true) ON CONFLICT DO NOTHING')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

/** A scripted model: each call answers with the next entry; the rest is `finish`. */
function scripted(steps: ((input: ModelInput) => unknown)[]): ComputerUseModel {
  let index = 0
  return async (input) => {
    const next = steps[index++]
    const value = next
      ? next(input)
      : { name: 'finish', arguments: { report: 'Готово. Больше делать нечего.' } }
    return { note: 'Тестовый шаг', ...(value as { name: string; arguments: unknown }) }
  }
}
const task = async () =>
  (await query('SELECT * FROM computer_use_tasks ORDER BY created_at DESC LIMIT 1'))[0]!
const steps = (taskId: string) =>
  query('SELECT * FROM computer_use_steps WHERE task_id=$1 ORDER BY step_no', [taskId])

describe('computer use: one task at a time, validated actions, owner approvals', () => {
  it('runs the demo script: screenshots, a recorded opportunity, an approval and a report', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent()
    expect(await computerUseTick({ agent })).toBe(true)
    let row = await task()
    expect(row).toMatchObject({
      source: 'rotation',
      status: 'waiting_approval',
      is_demo: true,
      step_count: 4,
    })
    const first = await steps(row.id)
    expect(first.map((s) => [s.action.name, s.decision])).toEqual([
      ['navigate', 'allowed'],
      ['scroll', 'allowed'],
      ['note_opportunity', 'allowed'],
      ['request_approval', 'approval'],
    ])
    expect(first[0]!.url_after).toBe('https://example.com/demo-bounties')
    expect(first[0]!.screenshot_path).toBe(`${row.id}/1.png`)
    expect(existsSync(join(screenshotRoot(), row.id, '1.png'))).toBe(true)
    expect(agent.actions.map((a) => a.action.name)).toEqual(['navigate', 'scroll'])
    const opportunities = await query('SELECT * FROM computer_use_opportunities')
    expect(opportunities).toHaveLength(1)
    expect(opportunities[0]).toMatchObject({ kind: 'bounty', is_demo: true, requires_human: true })
    const calls = await query(
      "SELECT * FROM tool_calls WHERE call_key LIKE 'computer-use:%' ORDER BY created_at",
    )
    expect(calls).toHaveLength(4)
    expect(calls.every((c) => c.is_demo && c.status === 'done' && c.charged_kopecks === 0)).toBe(
      true,
    )
    // Waiting for the owner: nothing runs until the decision.
    expect(await computerUseTick({ agent })).toBe(false)
    const [approval] = await query("SELECT * FROM computer_use_approvals WHERE status='pending'")
    expect(approval.action).toEqual({ name: 'click', x: 640, y: 420 })
    const shown = await computerUseView()
    expect(shown.current?.status).toBe('waiting_approval')
    expect(shown.approvals).toHaveLength(1)
    expect(shown.current?.latestScreenshotStepId).toBe(first[3]!.id)
    await resolveApproval(approval.id, 'approve')
    expect(await computerUseTick({ agent })).toBe(true)
    row = await task()
    expect(row.status).toBe('done')
    expect(row.report).toContain('Демонстрация завершена')
    const all = await steps(row.id)
    expect(all.map((s) => [s.action.name, s.decision])).toEqual([
      ['navigate', 'allowed'],
      ['scroll', 'allowed'],
      ['note_opportunity', 'allowed'],
      ['request_approval', 'approval'],
      ['click', 'approved'],
      ['finish', 'allowed'],
    ])
    expect(agent.actions.at(-1)?.action).toEqual({ name: 'click', x: 640, y: 420 })
    expect(agent.sessions.size).toBe(0)
    const [reservation] = await query('SELECT * FROM budget_reservations WHERE id=$1', [
      row.reservation_id,
    ])
    expect(reservation).toMatchObject({
      category: 'computer_use',
      status: 'closed',
      limit_kopecks: 0,
    })
    const after = await computerUseView()
    expect(after.current).toBeNull()
    expect(after.history[0]).toMatchObject({ id: row.id, status: 'done', demo: true })
    expect(after.opportunities[0]).toMatchObject({ kind: 'bounty', demo: true })
    expect(after.state.failures).toBe(0)
  })

  it('rejects an approval and lets the model learn it; owner goals run before rotation', async () => {
    await controlComputerUse('enable')
    const id = await addOwnerGoal('Найди гранты для небольших ИИ-проектов в России')
    await expect(addOwnerGoal('Найди способ обойти капчу на площадке')).rejects.toThrow(
      'COMPUTER_USE_SCHEME_BLOCKED',
    )
    const agent = new FakeVmAgent({
      target: {
        tag: 'button',
        type: 'submit',
        name: '',
        text: 'Зарегистрироваться',
        href: '',
        autocomplete: '',
      },
    })
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: 'https://grants.example/list' } }),
      () => ({ name: 'click', arguments: { x: 100, y: 100 } }),
      (input) => {
        expect(input.history.at(-1)).toMatchObject({
          decision: 'rejected',
          reason: 'COMPUTER_USE_OWNER_REJECTED',
        })
        return {
          name: 'finish',
          arguments: { report: 'Регистрацию отклонили, список грантов записан.' },
        }
      },
    ])
    await computerUseTick({ agent, model })
    let row = await task()
    expect(row).toMatchObject({ id, source: 'owner', status: 'waiting_approval' })
    const [approval] = await query("SELECT * FROM computer_use_approvals WHERE status='pending'")
    expect(approval).toMatchObject({
      reason: 'COMPUTER_USE_OUTWARD_ACTION',
      action: { name: 'click', x: 100, y: 100 },
    })
    await resolveApproval(approval.id, 'reject')
    await computerUseTick({ agent, model })
    row = await task()
    expect(row.status).toBe('done')
    expect((await steps(row.id)).map((s) => s.decision)).toEqual([
      'allowed',
      'approval',
      'rejected',
      'allowed',
    ])
    // The click never reached the VM.
    expect(agent.actions.map((a) => a.action.name)).toEqual(['navigate'])
  })

  it('marks an approval executed before the VM acts, so an approved action never runs twice', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent({
      target: {
        tag: 'button',
        type: 'submit',
        name: '',
        text: 'Отправить',
        href: '',
        autocomplete: '',
      },
    })
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: 'https://forum.example/thread' } }),
      () => ({ name: 'click', arguments: { x: 100, y: 100 } }),
    ])
    await computerUseTick({ agent, model })
    const [approval] = await query("SELECT * FROM computer_use_approvals WHERE status='pending'")
    await resolveApproval(approval.id, 'approve')
    const executedAtAct: (Date | null)[] = []
    const act = agent.act.bind(agent)
    agent.act = async (sessionId, action) => {
      if (action.name === 'click') {
        const [row] = await query('SELECT executed_at FROM computer_use_approvals WHERE id=$1', [
          approval.id,
        ])
        executedAtAct.push(row!.executed_at)
      }
      return act(sessionId, action)
    }
    await computerUseTick({ agent, model })
    await computerUseTick({ agent, model })
    expect(executedAtAct).toHaveLength(1)
    expect(executedAtAct[0]).toBeInstanceOf(Date)
    expect(agent.actions.filter((a) => a.action.name === 'click')).toHaveLength(1)
    const row = await task()
    expect(row.status).toBe('done')
    expect((await steps(row.id)).map((s) => s.decision)).toEqual([
      'allowed',
      'approval',
      'approved',
      'allowed',
    ])
  })

  it('hands a long task back after the tick budget; the next tick resumes it', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent()
    const wait = () => ({ name: 'wait', arguments: { ms: 100 } })
    const model = scripted([wait, wait, wait, wait])
    let clock = 0
    // Every look at the clock is four minutes later: two steps fit into the ten-minute budget.
    expect(await computerUseTick({ agent, model, now: () => (clock += 4 * 60_000) })).toBe(true)
    let row = await task()
    expect(row).toMatchObject({ status: 'running', step_count: 2 })
    const [owner] = await query('SELECT lease_id,last_error FROM computer_use WHERE id=true')
    expect(owner).toMatchObject({ lease_id: null, last_error: '' })
    expect(await computerUseTick({ agent, model })).toBe(true)
    row = await task()
    expect(row).toMatchObject({ status: 'done', step_count: 5 })
    expect(agent.sessions.size).toBe(0)
  })

  it('recognises a card number typed in pieces into one field', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent({
      focused: { tag: 'input', type: 'text', name: 'number', text: '', href: '', autocomplete: '' },
    })
    const piece = (text: string) => () => ({ name: 'type', arguments: { text } })
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: 'https://shop.example/order/42' } }),
      piece('4111'),
      piece('1111'),
      piece('1111'),
      piece('1111'),
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect(row.status).toBe('waiting_approval')
    expect((await steps(row.id)).map((s) => [s.decision, s.reason])).toEqual([
      ['allowed', ''],
      ['allowed', ''],
      ['allowed', ''],
      ['allowed', ''],
      ['approval', 'COMPUTER_USE_PAYMENT_DATA'],
    ])
    expect(agent.actions.filter((a) => a.action.name === 'type')).toHaveLength(3)
  })

  it('blocks forbidden targets and invalid calls without contacting the VM, then gives up', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent()
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: 'http://169.254.169.254/latest/meta-data' } }),
      () => ({ name: 'navigate', arguments: { url: 'https://2captcha.com/' } }),
      () => ({ name: 'shell', arguments: { command: 'ls' } }),
      () => ({ name: 'click', arguments: { x: -1, y: 0 } }),
      () => ({ name: 'navigate', arguments: { url: 'file:///etc/passwd' } }),
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect(row).toMatchObject({
      status: 'failed',
      error: 'COMPUTER_USE_MODEL_INVALID',
      step_count: 5,
    })
    expect((await steps(row.id)).map((s) => [s.decision, s.reason])).toEqual([
      ['blocked', 'COMPUTER_USE_PRIVATE_NETWORK'],
      ['blocked', 'COMPUTER_USE_HOST_BLOCKED'],
      ['invalid', 'COMPUTER_USE_TOOL_CALL_INVALID'],
      ['invalid', 'COMPUTER_USE_TOOL_CALL_INVALID'],
      ['invalid', 'COMPUTER_USE_TOOL_CALL_INVALID'],
    ])
    expect(agent.actions).toHaveLength(0)
    expect((await computerUseView()).state.failures).toBe(1)
  })

  it('reserves the paid envelope before every step and stops at the task cap', async () => {
    let cap = 0
    vi.spyOn(settings, 'config').mockImplementation(() => ({
      ...original,
      MODEL_PROVIDER: 'openai',
      OPENAI_TRANSPORT: 'openrouter',
      OPENROUTER_API_KEY: 'test-only-key',
      SEARCH_PROVIDER: 'searxng',
      VM_AGENT_URL: 'http://10.0.0.9:8787/',
      VM_AGENT_TOKEN: 'x'.repeat(40),
      DAILY_BUDGET_KOPECKS: 100000,
      MONTHLY_BUDGET_KOPECKS: 1000000,
      OPENAI_TOTAL_BUDGET_MICROUSD: 10_000_000,
      COMPUTER_USE_TASK_CAP_MICROUSD: cap,
      COMPUTER_USE_DAILY_CAP_MICROUSD: 50_000_000,
    }))
    // The pessimistic reserve of one step; two real steps fit under the cap, the third does not.
    const estimate = prepareStepRequest({
      taskId: 'estimate',
      reservationId: 'estimate',
      goal: rotationGoals[0]!,
      stepNo: 1,
      stepLimit: 30,
      history: [],
      page: { url: 'about:blank', title: 'Демонстрация' },
      png: Buffer.alloc(10),
      opportunities: 0,
    }).maximumMicrousd
    expect(estimate).toBeGreaterThan(85000)
    cap = estimate + 2 * 85000 - 1
    const answer = (name: string, args: unknown) =>
      new Response(
        JSON.stringify({
          id: 'gen-' + name,
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'Смотрю страницу.',
                tool_calls: [
                  { type: 'function', function: { name, arguments: JSON.stringify(args) } },
                ],
              },
            },
          ],
          // 8000 input tokens at $10/M plus 100 output at $50/M: $0.085 by the project tariff.
          usage: { prompt_tokens: 8000, completion_tokens: 100, cost: '0.03' },
        }),
      )
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => answer('scroll', { x: 600, y: 400, deltaY: 500 }))
      .mockResolvedValueOnce(answer('navigate', { url: 'https://example.com/jobs' }))
    vi.stubGlobal('fetch', fetchMock)
    await controlComputerUse('enable')
    // Earlier real failures stay counted; a limit reached with nothing recorded is one more.
    await query('UPDATE computer_use SET failures=2 WHERE id=true')
    const agent = new FakeVmAgent()
    await computerUseTick({ agent, model: astraStep(demoScript) })
    const row = await task()
    expect(row).toMatchObject({
      status: 'done',
      error: '',
      provider: 'openai',
      model: 'openai/gpt-6-astra',
      is_demo: false,
    })
    expect(row.report).toContain('исчерпан лимит расходов на одно задание')
    expect(row.report).toContain('https://example.com/jobs')
    expect(row.report).toContain(`из $${(cap / 1_000_000).toFixed(2)}`)
    const [owner] = await query('SELECT failures,last_error FROM computer_use WHERE id=true')
    expect(owner).toMatchObject({ failures: 3, last_error: 'COMPUTER_USE_LIMIT_EMPTY' })
    const [audited] = await query(
      "SELECT data FROM audit_events WHERE kind='computer_use_task' ORDER BY id DESC LIMIT 1",
    )
    expect(audited?.data).toMatchObject({ status: 'done', endedBy: 'limit', emptyRun: true })
    expect((await computerUseView()).state.blocked).toContain('COMPUTER_USE_FAILURES')
    expect(agent.sessions.size).toBe(0)
    const calls = await query(
      "SELECT * FROM tool_calls WHERE call_key LIKE 'computer-use:%' ORDER BY created_at",
    )
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.provider).toBe('openai')
      expect(call.status).toBe('done')
      expect(call.reserved_microusd).toBeGreaterThan(call.charged_microusd)
      expect(call.charged_microusd).toBe(85000)
      expect(call.actual_microusd).toBe(85000)
      expect(call.charged_kopecks).toBe(usdToKopecks(85000, original.OPENAI_USD_KOPECKS))
    }
    const [reservation] = await query('SELECT * FROM budget_reservations WHERE id=$1', [
      row.reservation_id,
    ])
    expect(reservation).toMatchObject({
      category: 'computer_use',
      status: 'closed',
      limit_kopecks: usdToKopecks(cap, original.OPENAI_USD_KOPECKS),
      spent_kopecks: calls.length * usdToKopecks(85000, original.OPENAI_USD_KOPECKS),
    })
    expect(row.step_count).toBe(calls.length)
    expect(fetchMock).toHaveBeenCalledTimes(calls.length)
    // Each request carried the budget: the second step was the last that fits under the cap.
    const budgets = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(JSON.parse(init.body).messages[1].content[0].text).budget,
    )
    expect(budgets[0]).toMatchObject({ steps_left: 30, cost_left_percent: 100 })
    expect(budgets[1]).toMatchObject({ steps_left: 29, wrap_up: true, final_step: true })
    expect(budgets[1].cost_left_percent).toBe(Math.floor(((cap - 85000) * 100) / cap))
    const shown = await computerUseView()
    expect(shown.state.spentTodayMicrousd).toBe(calls.length * 85000)
    expect(shown.history[0]?.spentMicrousd).toBe(calls.length * 85000)
  })

  it('ends a task at the step limit as done with a report assembled from its records', async () => {
    vi.spyOn(settings, 'config').mockImplementation(() => ({
      ...original,
      COMPUTER_USE_STEP_LIMIT: 3,
    }))
    await controlComputerUse('enable')
    await query("UPDATE computer_use SET failures=2,last_error='COMPUTER_USE_VM_UNAVAILABLE'")
    const agent = new FakeVmAgent()
    const seen: ModelInput[] = []
    const model = scripted([
      (input) => (
        seen.push(input),
        { name: 'navigate', arguments: { url: 'https://jobs.example/list' } }
      ),
      (input) => (
        seen.push(input),
        {
          name: 'note_opportunity',
          arguments: {
            title: 'Перевод описаний товаров',
            url: 'https://jobs.example/list/7',
            summary: 'Нужно перевести 20 описаний товаров с английского, оплата через площадку.',
            kind: 'freelance',
            requiresHuman: false,
            decision: 'take',
            fit: 80,
            ai_forbidden: false,
            estimated_value: { amount: 300000, currency: 'RUB' },
            reason: 'Текстовая работа по профилю.',
          },
        }
      ),
      (input) => (seen.push(input), { name: 'scroll', arguments: { x: 600, y: 400, deltaY: 500 } }),
      () => {
        throw new Error('NO_FOURTH_MODEL_CALL')
      },
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect(row).toMatchObject({ status: 'done', error: '', step_count: 3 })
    expect(row.report).toContain('израсходованы все шаги задания (шагов 3 из 3)')
    expect(row.report).toContain(
      '1. Перевод описаний товаров - https://jobs.example/list/7 (беру сам, соответствие 80/100, оценка 300000 RUB в минимальных единицах)',
    )
    expect(row.report).toContain('- https://jobs.example/list')
    const [owner] = await query('SELECT failures,last_error FROM computer_use WHERE id=true')
    expect(owner).toMatchObject({ failures: 0, last_error: '' })
    const [audited] = await query(
      "SELECT data FROM audit_events WHERE kind='computer_use_task' ORDER BY id DESC LIMIT 1",
    )
    expect(audited?.data).toMatchObject({ status: 'done', endedBy: 'limit' })
    expect(agent.sessions.size).toBe(0)
    // The model saw what was left and where it had been; the last step asked it to finish.
    expect(seen.map((input) => input.budget)).toEqual([
      { stepsLeft: 3, costLeftPercent: null, wrapUp: true, finalStep: false },
      { stepsLeft: 2, costLeftPercent: null, wrapUp: true, finalStep: false },
      { stepsLeft: 1, costLeftPercent: null, wrapUp: true, finalStep: true },
    ])
    expect(seen[0]!.visited).toEqual([])
    expect(seen[1]!.visited).toEqual([
      { url: 'https://jobs.example/list', visits: 1, navigates: 1 },
    ])
    const sent = JSON.parse(prepareStepRequest(seen[2]!).text)
    expect(sent.budget).toEqual({
      steps_left: 1,
      cost_left_percent: null,
      wrap_up: true,
      final_step: true,
    })
    expect(sent.visited_urls).toEqual([
      { url: 'https://jobs.example/list', visits: 1, navigates: 1 },
    ])
  })

  it('refuses a third navigate to the same address and shows the visited list', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent()
    const seen: ModelInput[] = []
    const go = (url: string) => (input: ModelInput) => (
      seen.push(input),
      { name: 'navigate', arguments: { url } }
    )
    const model = scripted([
      go('https://plati.example/catalog'),
      go('https://boosty.example/'),
      // The same page again, written differently: fragment and trailing slash do not count.
      go('https://PLATI.example/catalog/#top'),
      go('https://plati.example/catalog'),
      go('https://plati.example/catalog?page=2'),
      (input) => (
        seen.push(input),
        { name: 'finish', arguments: { report: 'Каталог просмотрен.' } }
      ),
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect(row.status).toBe('done')
    expect((await steps(row.id)).map((s) => [s.action.name, s.decision, s.reason])).toEqual([
      ['navigate', 'allowed', ''],
      ['navigate', 'allowed', ''],
      ['navigate', 'allowed', ''],
      ['navigate', 'blocked', 'COMPUTER_USE_LOOP_URL'],
      ['navigate', 'allowed', ''],
      ['finish', 'allowed', ''],
    ])
    expect(agent.actions.map((a) => a.action)).toEqual([
      { name: 'navigate', url: 'https://plati.example/catalog' },
      { name: 'navigate', url: 'https://boosty.example/' },
      { name: 'navigate', url: 'https://PLATI.example/catalog/#top' },
      { name: 'navigate', url: 'https://plati.example/catalog?page=2' },
    ])
    expect(seen[3]!.visited).toEqual([
      { url: 'https://plati.example/catalog', visits: 2, navigates: 2 },
      { url: 'https://boosty.example/', visits: 1, navigates: 1 },
    ])
    expect(seen[5]!.visited![0]).toEqual({
      url: 'https://plati.example/catalog?page=2',
      visits: 1,
      navigates: 1,
    })
  })

  it('leaves out an unchanged screenshot after a record step, never twice, never for a click', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent()
    const seen: ModelInput[] = []
    const note = (n: number) => (input: ModelInput) => (
      seen.push(input),
      {
        name: 'note_opportunity',
        arguments: {
          title: `Конкурс номер ${n}`,
          url: `https://contests.example/${n}`,
          summary: 'Открытый конкурс для разработчиков, условия на странице.',
          kind: 'bounty',
          requiresHuman: true,
          decision: 'human',
          fit: 50,
          ai_forbidden: false,
          estimated_value: null,
          reason: 'Участие решает владелец.',
        },
      }
    )
    const click = (input: ModelInput) => (
      seen.push(input),
      { name: 'click', arguments: { x: 10, y: 10 } }
    )
    const model = scripted([
      (input) => (
        seen.push(input),
        { name: 'navigate', arguments: { url: 'https://contests.example/' } }
      ),
      note(1),
      note(2),
      note(3),
      click,
      click,
      (input) => (seen.push(input), { name: 'finish', arguments: { report: 'Готово.' } }),
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect(row.status).toBe('done')
    // The fake VM returns the same picture every time: only record steps make it skippable.
    expect(seen.map((input) => (input.png ? 'image' : 'none'))).toEqual([
      'image', // first step
      'image', // after navigate
      'none', // after a record, same screen
      'image', // never twice in a row
      'none', // after a record again: the click here is refused
      'image', // after the refused click (no picture sent then): the click runs
      'image',
    ])
    expect(seen[2]!.screenshotUnchangedSince).toBe(2)
    expect(JSON.parse(prepareStepRequest(seen[2]!).text).screenshot).toBe(
      'не приложен: экран не изменился после шага 2',
    )
    expect(prepareStepRequest(seen[2]!).maximumMicrousd).toBe(0) // demo: nothing is charged
    expect((await steps(row.id)).map((s) => [s.action.name, s.decision, s.reason])).toEqual([
      ['navigate', 'allowed', ''],
      ['note_opportunity', 'allowed', ''],
      ['note_opportunity', 'allowed', ''],
      ['note_opportunity', 'allowed', ''],
      ['click', 'blocked', 'COMPUTER_USE_SCREENSHOT_REQUIRED'],
      ['click', 'allowed', ''],
      ['finish', 'allowed', ''],
    ])
    // Every screen is still stored for the owner, sent to the model or not.
    expect((await steps(row.id)).every((s) => s.screenshot_path)).toBe(true)
    expect(agent.actions.filter((a) => a.action.name === 'click')).toHaveLength(1)
  })

  it('keeps a task resumable on pause, stop and the daily limit', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent()
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: 'https://example.com/a' } }),
      () => ({ name: 'wait', arguments: { ms: 100 } }),
      () => ({ name: 'finish', arguments: { report: 'Готово.' } }),
    ])
    await query("UPDATE system_state SET mode='paused' WHERE id=true")
    expect(await computerUseTick({ agent, model })).toBe(false)
    expect(await query('SELECT id FROM computer_use_tasks')).toHaveLength(0)
    await query("UPDATE system_state SET mode='running' WHERE id=true")
    let stops = 0
    expect(await computerUseTick({ agent, model }, () => stops++ >= 2)).toBe(true)
    let row = await task()
    expect(row.status).toBe('running')
    expect(row.step_count).toBe(1)
    const [owner] = await query('SELECT * FROM computer_use WHERE id=true')
    expect(owner.lease_id).toBeNull()
    await controlComputerUse('pause')
    expect(await computerUseTick({ agent, model })).toBe(false)
    await controlComputerUse('enable')
    await computerUseTick({ agent, model })
    row = await task()
    expect(row.status).toBe('done')
    expect(row.step_count).toBe(3)
    // Cancelling a queued goal closes it; the cancellation is visible to the owner.
    const id = await addOwnerGoal('Найди конкурсы для разработчиков с призами')
    await cancelTask(id)
    expect(
      (await query('SELECT status FROM computer_use_tasks WHERE id=$1', [id]))[0]!.status,
    ).toBe('cancelled')
    await expect(cancelTask(id)).rejects.toThrow('COMPUTER_USE_TASK_FINISHED')
  })

  it('fails the task when the VM link is lost and pauses after repeated failures', async () => {
    await controlComputerUse('enable')
    const broken = new FakeVmAgent()
    broken.startSession = async () => {
      throw new (await import('../../core/computer-use/client')).VmAgentUnavailable()
    }
    for (let i = 0; i < P.maxFailuresInRow; i++) {
      await query(
        "UPDATE computer_use_tasks SET finished_at=now()-interval '1 hour' WHERE finished_at IS NOT NULL",
      )
      expect(await computerUseTick({ agent: broken })).toBe(true)
    }
    const failed = await query("SELECT * FROM computer_use_tasks WHERE status='failed'")
    expect(failed).toHaveLength(P.maxFailuresInRow)
    expect(failed.every((t) => t.error === 'COMPUTER_USE_VM_UNAVAILABLE')).toBe(true)
    const shown = await computerUseView()
    expect(shown.state.failures).toBe(P.maxFailuresInRow)
    expect(shown.state.blocked).toContain('COMPUTER_USE_FAILURES')
    expect(await computerUseTick({ agent: broken })).toBe(false)
    await controlComputerUse('enable')
    expect((await computerUseView()).state.failures).toBe(0)
  })

  it('serves the office API only with the owner session and the right origin', async () => {
    const call = async (method: 'GET' | 'POST', path: string, cookie?: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(cookie ? { cookie: `farm_session=${cookie}` } : {}),
          ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      })
      const text = await response.text()
      let json: any = text
      try {
        json = JSON.parse(text)
      } catch {
        /* binary or text */
      }
      return { status: response.status, json, type: response.headers.get('content-type') || '' }
    }
    expect((await call('GET', '/api/computer-use')).status).toBe(401)
    expect(
      (await call('POST', '/api/computer-use/control', undefined, { action: 'enable' })).status,
    ).toBe(401)
    const foreign = await fetch(base + '/api/computer-use/goals', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{"goal":"x"}',
    })
    expect(foreign.status).toBe(403)
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    const shown = await call('GET', '/api/computer-use', session)
    expect(shown.status).toBe(200)
    expect(shown.json.state).toMatchObject({
      enabled: false,
      demo: true,
      blocked: expect.arrayContaining(['COMPUTER_USE_WORKER_UNAVAILABLE']),
    })
    const enabled = await call('POST', '/api/computer-use/control', session, { action: 'enable' })
    expect(enabled.json.state.enabled).toBe(true)
    expect(
      (await call('POST', '/api/computer-use/goals', session, { goal: 'Найди обход KYC' })).json
        .statusMessage,
    ).toBe('COMPUTER_USE_SCHEME_BLOCKED')
    expect((await call('POST', '/api/computer-use/goals', session, { goal: 'мало' })).status).toBe(
      409,
    )
    const queued = await call('POST', '/api/computer-use/goals', session, {
      goal: 'Найди гранты для разработчиков открытого кода',
    })
    expect(queued.status).toBe(200)
    expect(queued.json.state.queuedOwnerGoals).toBe(1)
    await computerUseTick({ agent: new FakeVmAgent() })
    const waiting = await call('GET', '/api/computer-use', session)
    expect(waiting.json.current.status).toBe('waiting_approval')
    const stepId = waiting.json.current.latestScreenshotStepId
    const png = await call('GET', `/api/computer-use/steps/${stepId}/screenshot.png`, session)
    expect(png.status).toBe(200)
    expect(png.type).toBe('image/png')
    expect((await call('GET', `/api/computer-use/steps/${stepId}/screenshot.png`)).status).toBe(401)
    expect(
      (
        await call(
          'GET',
          '/api/computer-use/steps/00000000-0000-4000-8000-000000000000/screenshot.png',
          session,
        )
      ).status,
    ).toBe(404)
    const decided = await call(
      'POST',
      `/api/computer-use/approvals/${waiting.json.approvals[0].id}`,
      session,
      { decision: 'reject' },
    )
    expect(decided.status).toBe(200)
    expect(decided.json.approvals).toHaveLength(0)
    expect(decided.json.current.status).toBe('running')
    expect(
      (
        await call('POST', `/api/computer-use/approvals/${waiting.json.approvals[0].id}`, session, {
          decision: 'approve',
        })
      ).status,
    ).toBe(404)
    const cancelled = await call('POST', '/api/computer-use/control', session, {
      action: 'cancel',
      taskId: waiting.json.current.id,
    })
    expect(cancelled.json.current).toBeNull()
    expect(cancelled.json.history[0]).toMatchObject({ status: 'cancelled' })
  })
})
