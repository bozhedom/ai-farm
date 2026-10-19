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
    const agent = new FakeVmAgent()
    await computerUseTick({ agent, model: astraStep(demoScript) })
    const row = await task()
    expect(row).toMatchObject({
      status: 'failed',
      error: 'COMPUTER_USE_TASK_CAP',
      provider: 'openai',
      model: 'openai/gpt-6-astra',
      is_demo: false,
    })
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
    const shown = await computerUseView()
    expect(shown.state.spentTodayMicrousd).toBe(calls.length * 85000)
    expect(shown.history[0]?.spentMicrousd).toBe(calls.length * 85000)
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
