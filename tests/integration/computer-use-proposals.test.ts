import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as settings from '../../core/config'
import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { FakeVmAgent } from '../../core/computer-use/client'
import { builtInDirections } from '../../core/computer-use/goals'
import { manualAct, setManualAgent, startManual, stopManual } from '../../core/computer-use/manual'
import { COMPUTER_USE_POLICY as P, type ElementInfo } from '../../core/computer-use/policy'
import {
  addOwnerGoal,
  computerUseTick,
  controlComputerUse,
  setPlatformLogin,
} from '../../core/computer-use/runtime'
import { computerUseView } from '../../core/computer-use/view'
import type { ComputerUseModel, DocumentWriter, ModelInput } from '../../core/computer-use/model'
import security from '../../server/middleware/security'
import view from '../../server/api/computer-use/index.get'
import control from '../../server/api/computer-use/control.post'
import platforms from '../../server/api/computer-use/platforms.post'
import manual from '../../server/api/computer-use/manual/index.post'
import manualAction from '../../server/api/computer-use/manual/act.post'
import manualScreen from '../../server/api/computer-use/manual/screen.png.get'
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
  router.post('/api/computer-use/control', control)
  router.post('/api/computer-use/platforms', platforms)
  router.post('/api/computer-use/manual', manual)
  router.post('/api/computer-use/manual/act', manualAction)
  router.get('/api/computer-use/manual/screen.png', manualScreen)
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
  setManualAgent(null)
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
      ? await next(input)
      : { name: 'finish', arguments: { report: 'Готово. Больше делать нечего.' } }
    return { note: 'Тестовый шаг', ...(value as { name: string; arguments: unknown }) }
  }
}
const task = async () =>
  (await query('SELECT * FROM computer_use_tasks ORDER BY created_at DESC LIMIT 1'))[0]!
const steps = (taskId: string) =>
  query('SELECT * FROM computer_use_steps WHERE task_id=$1 ORDER BY step_no', [taskId])
const sendButton: ElementInfo = {
  tag: 'button',
  type: 'submit',
  name: '',
  text: 'Отправить отклик',
  href: '',
  autocomplete: '',
}
const job = 'https://www.fl.ru/projects/42/'
const note = (url = job, extra: Record<string, unknown> = {}) => ({
  name: 'note_opportunity',
  arguments: {
    title: 'Описания товаров для магазина мебели',
    url,
    summary: 'Нужно 20 описаний диванов и кресел для каталога, срок неделя, бюджет 3000 рублей.',
    kind: 'freelance',
    requiresHuman: false,
    decision: 'take',
    fit: 85,
    ai_forbidden: false,
    estimated_value: { amount: 300000, currency: 'RUB' },
    reason: 'Текстовая работа, можно сделать и сдать на площадке.',
    ...extra,
  },
})
const proposalText =
  'Здравствуйте! Прочитал задание: нужно 20 описаний диванов и кресел для каталога. Сделаю в едином стиле: характеристики, материалы, для какого интерьера подходит, без воды и повторов. Первые два описания пришлю на согласование завтра, остальные в течение недели. Правки входят в стоимость.'
const draft = (url = job, extra: Record<string, unknown> = {}) => ({
  name: 'draft_proposal',
  arguments: {
    opportunity_url: url,
    platform_domain: 'fl.ru',
    text: proposalText,
    price_amount: 300000,
    price_currency: 'RUB',
    ...extra,
  },
})
const click = { name: 'click', arguments: { x: 100, y: 100 } }

async function freelanceReady() {
  await controlComputerUse('enable')
  await controlComputerUse('auto_proposals_on')
  await setPlatformLogin('fl.ru', true)
}

describe('computer use on freelance platforms: assessment, proposals, permits', () => {
  it('drafts a proposal, types it, sends it once through a permit and asks the second time', async () => {
    await freelanceReady()
    await addOwnerGoal('Проверь новые задания на fl.ru и откликнись на подходящие')
    const agent = new FakeVmAgent({ target: sendButton })
    const seen: ModelInput[] = []
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: job } }),
      () => note(),
      (input) => {
        expect(input.platforms).toEqual({
          loggedIn: ['fl.ru'],
          canLogIn: [],
          autoProposals: true,
          proposalsPerDay: original.COMPUTER_USE_PROPOSALS_PER_DAY,
        })
        return draft()
      },
      (input) => {
        seen.push(input)
        return { name: 'type_stored', arguments: { id: input.stored!.proposals[0]!.id } }
      },
      () => click,
      () => click,
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect(row.status).toBe('waiting_approval')
    expect((await steps(row.id)).map((s) => [s.action.name, s.decision, s.reason])).toEqual([
      ['navigate', 'allowed', ''],
      ['note_opportunity', 'allowed', ''],
      ['draft_proposal', 'allowed', 'COMPUTER_USE_PERMIT_GRANTED'],
      ['type_stored', 'allowed', ''],
      ['click', 'allowed', 'COMPUTER_USE_SEND_PERMIT'],
      ['click', 'approval', 'COMPUTER_USE_OUTWARD_ACTION'],
    ])
    const [opportunity] = await query('SELECT * FROM computer_use_opportunities')
    expect(opportunity).toMatchObject({
      decision: 'take',
      fit: 85,
      ai_forbidden: false,
      estimated_currency: 'RUB',
      platform_domain: 'fl.ru',
      requires_human: false,
    })
    expect(Number(opportunity.estimated_value_minor)).toBe(300000)
    const [proposal] = await query('SELECT * FROM computer_use_proposals')
    expect(proposal).toMatchObject({
      status: 'sent',
      platform_domain: 'fl.ru',
      opportunity_id: opportunity.id,
      sent_url: job,
      is_demo: true,
    })
    expect(Number(proposal.price_amount)).toBe(300000)
    expect(proposal.sent_at).toBeInstanceOf(Date)
    const [permit] = await query('SELECT * FROM computer_use_send_permits')
    expect(permit).toMatchObject({
      status: 'used',
      purpose: 'proposal',
      proposal_id: proposal.id,
      used_step_no: 5,
      used_url: job,
    })
    // The model saw the open permit and the draft before typing; the VM got insertText.
    expect(seen[0]!.stored).toMatchObject({
      proposals: [
        { id: proposal.id, status: 'draft', domain: 'fl.ru', chars: proposalText.length },
      ],
      permit: { id: permit.id, domain: 'fl.ru', purpose: 'proposal' },
    })
    expect(agent.actions.map((a) => a.action.name)).toEqual(['navigate', 'insert_text', 'click'])
    expect(agent.actions[1]!.action).toEqual({ name: 'insert_text', text: proposalText })
    const shown = await computerUseView()
    expect(shown.proposals[0]).toMatchObject({
      status: 'sent',
      platformDomain: 'fl.ru',
      opportunityTitle: 'Описания товаров для магазина мебели',
      priceAmount: 300000,
    })
    expect(shown.platforms.find((p) => p.domain === 'fl.ru')).toMatchObject({
      loggedIn: true,
      proposalsToday: 1,
      sentToday: 1,
    })
    expect(shown.opportunities[0]).toMatchObject({ decision: 'take', fit: 85 })
    expect(shown.approvals).toHaveLength(1)
    expect(shown.state.autoProposals).toBe(true)
  })

  it('refuses proposals without the switch, the login, the assessment, or with forbidden text', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent({ target: sendButton })
    const other = 'https://www.fl.ru/projects/43/'
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: job } }),
      () => draft(),
      () => {
        void controlComputerUse('auto_proposals_on')
        return { name: 'wait', arguments: { ms: 100 } }
      },
      () => draft(),
      () => {
        void setPlatformLogin('fl.ru', true)
        return { name: 'wait', arguments: { ms: 100 } }
      },
      () => draft(),
      () => note(),
      () => draft(job, { platform_domain: 'jobs.example' }),
      () => draft(job, { text: `${proposalText} Пишите в телеграм @ivan_writer.` }),
      () => draft(job, { text: `${proposalText} Я не использую нейросети.` }),
      () => note(other, { title: 'Статьи без ИИ', summary: 'Пишем без нейросетей, decision take' }),
      () => draft(other),
      () => draft(job, { opportunity_url: 'https://www.fl.ru/projects/44/' }),
      () => click,
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect(row.status).toBe('waiting_approval')
    const recorded = (await steps(row.id)).map((s) => [s.action.name, s.decision, s.reason])
    expect(recorded).toEqual([
      ['navigate', 'allowed', ''],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_AUTO_PROPOSALS_OFF'],
      ['wait', 'allowed', ''],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_PLATFORM_NOT_LOGGED_IN'],
      ['wait', 'allowed', ''],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_OPPORTUNITY_REQUIRED'],
      ['note_opportunity', 'allowed', ''],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_PLATFORM_UNKNOWN'],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_CONTACT_DETAILS'],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_AI_DENIAL'],
      ['note_opportunity', 'allowed', 'COMPUTER_USE_AI_FORBIDDEN'],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_AI_FORBIDDEN'],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_OPPORTUNITY_REQUIRED'],
      // No proposal was stored, so no permit exists: the send button still needs the owner.
      ['click', 'approval', 'COMPUTER_USE_OUTWARD_ACTION'],
    ])
    const banned = await query('SELECT * FROM computer_use_opportunities WHERE url=$1', [other])
    expect(banned[0]).toMatchObject({ decision: 'skip', ai_forbidden: true })
    expect(await query('SELECT id FROM computer_use_proposals')).toHaveLength(0)
    expect(await query('SELECT id FROM computer_use_send_permits')).toHaveLength(0)
  })

  it('enforces the daily proposal limit per platform and shows it in the office', async () => {
    vi.spyOn(settings, 'config').mockImplementation(() => ({
      ...original,
      COMPUTER_USE_PROPOSALS_PER_DAY: 1,
    }))
    await freelanceReady()
    const agent = new FakeVmAgent({ target: sendButton })
    const second = 'https://www.fl.ru/projects/43/'
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: job } }),
      () => note(),
      () => note(second),
      () => draft(),
      () => draft(second),
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect((await steps(row.id)).map((s) => [s.action.name, s.reason])).toEqual([
      ['navigate', ''],
      ['note_opportunity', ''],
      ['note_opportunity', ''],
      ['draft_proposal', 'COMPUTER_USE_PERMIT_GRANTED'],
      ['draft_proposal', 'COMPUTER_USE_PROPOSAL_LIMIT'],
      ['finish', ''],
    ])
    // The task ended with the draft unsent: the permit and the draft expire with it.
    expect(
      await query("SELECT id FROM computer_use_send_permits WHERE status='expired'"),
    ).toHaveLength(1)
    expect(
      await query("SELECT id FROM computer_use_proposals WHERE status='expired'"),
    ).toHaveLength(1)
    const shown = await computerUseView()
    expect(shown.state.proposalsPerDay).toBe(1)
    expect(shown.platforms.find((p) => p.domain === 'fl.ru')?.proposalsToday).toBe(1)
  })

  it('scopes a permit to its platform, its task and 15 minutes', async () => {
    await freelanceReady()
    const agent = new FakeVmAgent({ target: sendButton })
    // A permit of another (finished) task on the same platform never covers this one.
    const foreign = randomUUID()
    await query(
      `INSERT INTO computer_use_tasks(id,goal,source,status,step_limit,cost_cap_microusd,provider,model,is_demo,finished_at)
       VALUES($1,'Чужое задание для проверки','owner','done',30,0,'demo','demo',true,now()-interval '1 hour')`,
      [foreign],
    )
    await query(`UPDATE computer_use_tasks SET created_at=now()-interval '2 hours' WHERE id=$1`, [
      foreign,
    ])
    await query(
      `INSERT INTO computer_use_send_permits(id,task_id,platform_domain,purpose,expires_at)
       VALUES($1,$2,'fl.ru','reply',now()+interval '10 minutes')`,
      [randomUUID(), foreign],
    )
    const model = scripted([() => ({ name: 'navigate', arguments: { url: job } }), () => click])
    await computerUseTick({ agent, model })
    let row = await task()
    expect(row.status).toBe('waiting_approval')
    expect((await steps(row.id)).at(-1)).toMatchObject({
      decision: 'approval',
      reason: 'COMPUTER_USE_OUTWARD_ACTION',
    })
    await query(
      "UPDATE computer_use_tasks SET status='cancelled',finished_at=now()-interval '1 hour' WHERE id=$1",
      [row.id],
    )
    await query("UPDATE computer_use_approvals SET status='expired',resolved_at=now()")

    // Own permit, other platform: approval. Then expired: approval, and the draft closes.
    const model2 = scripted([
      () => ({ name: 'navigate', arguments: { url: job } }),
      () => note(),
      () => draft(),
      () => ({ name: 'navigate', arguments: { url: 'https://kwork.ru/projects/1' } }),
      () => click,
    ])
    await computerUseTick({ agent, model: model2 })
    row = await task()
    expect(row.status).toBe('waiting_approval')
    expect((await steps(row.id)).at(-1)).toMatchObject({
      action: { name: 'click' },
      decision: 'approval',
      reason: 'COMPUTER_USE_OUTWARD_ACTION',
    })
    const [permit] = await query('SELECT * FROM computer_use_send_permits WHERE task_id=$1', [
      row.id,
    ])
    expect(permit.status).toBe('open')
    // Rejecting the kwork click resumes the task; the fl.ru permit has meanwhile expired.
    await query("UPDATE computer_use_approvals SET status='rejected',resolved_at=now()")
    await query("UPDATE computer_use_tasks SET status='running' WHERE id=$1", [row.id])
    await query(
      "UPDATE computer_use_send_permits SET expires_at=now()-interval '1 second' WHERE id=$1",
      [permit.id],
    )
    const model3 = scripted([() => ({ name: 'navigate', arguments: { url: job } }), () => click])
    await computerUseTick({ agent, model: model3 })
    row = await task()
    expect(row.status).toBe('waiting_approval')
    expect((await steps(row.id)).map((s) => [s.action.name, s.decision])).toEqual([
      ['navigate', 'allowed'],
      ['note_opportunity', 'allowed'],
      ['draft_proposal', 'allowed'],
      ['navigate', 'allowed'],
      ['click', 'approval'],
      ['click', 'rejected'],
      ['navigate', 'allowed'],
      ['click', 'approval'],
    ])
    expect(
      (await query('SELECT status FROM computer_use_send_permits WHERE id=$1', [permit.id]))[0]!
        .status,
    ).toBe('expired')
    expect((await query('SELECT status FROM computer_use_proposals'))[0]!.status).toBe('expired')
    expect(agent.actions.filter((a) => a.action.name === 'click')).toHaveLength(0)
  })

  it('writes a document, shows its preview, inserts it in chunks and sends it by a delivery permit', async () => {
    await freelanceReady()
    const agent = new FakeVmAgent({ target: sendButton })
    const long = `${'Абзац про диван. '.repeat(150)}\n\n${'Второй абзац. '.repeat(150)}`
    const writer = vi.fn<DocumentWriter>(async () => ({ text: long }))
    const previews: string[] = []
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: 'https://www.fl.ru/orders/7/' } }),
      () => ({
        name: 'write_document',
        arguments: {
          title: 'Описание дивана «Ривьера»',
          brief: 'Три абзаца для каталога мебели: материалы, размеры, для какого интерьера.',
          kind: 'product_description',
        },
      }),
      (input) => {
        previews.push(input.stored!.documents[0]!.preview)
        return { name: 'type_stored', arguments: { id: input.stored!.documents[0]!.id } }
      },
      () => ({ name: 'type_stored', arguments: { id: randomUUID() } }),
      () => ({ name: 'prepare_send', arguments: { domain: 'fl.ru', purpose: 'delivery' } }),
      () => click,
    ])
    await computerUseTick({ agent, model, document: writer })
    const row = await task()
    expect(row.status).toBe('done')
    expect((await steps(row.id)).map((s) => [s.action.name, s.decision, s.reason])).toEqual([
      ['navigate', 'allowed', ''],
      ['write_document', 'allowed', ''],
      ['type_stored', 'allowed', ''],
      ['type_stored', 'blocked', 'COMPUTER_USE_STORED_NOT_FOUND'],
      ['prepare_send', 'allowed', 'COMPUTER_USE_PERMIT_GRANTED'],
      ['click', 'allowed', 'COMPUTER_USE_SEND_PERMIT'],
      ['finish', 'allowed', ''],
    ])
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer.mock.calls[0]![0]).toMatchObject({
      taskId: row.id,
      stepNo: 2,
      kind: 'product_description',
    })
    const [document] = await query('SELECT * FROM computer_use_documents')
    expect(document).toMatchObject({ task_id: row.id, text: long, is_demo: true })
    expect(previews[0]).toBe(long.slice(0, 1500))
    const inserted = agent.actions.filter((a) => a.action.name === 'insert_text')
    expect(inserted.length).toBeGreaterThan(1)
    expect(inserted.map((a) => (a.action as { text: string }).text).join('')).toBe(long)
    expect(inserted.every((a) => (a.action as { text: string }).text.length <= 2000)).toBe(true)
    const [permit] = await query('SELECT * FROM computer_use_send_permits')
    expect(permit).toMatchObject({ purpose: 'delivery', status: 'used', proposal_id: null })
    const shown = await computerUseView()
    expect(shown.documents[0]).toMatchObject({ title: 'Описание дивана «Ривьера»', demo: true })
  })

  it('runs no model step while the owner controls the browser and never stores typed text', async () => {
    await controlComputerUse('enable')
    const agent = new FakeVmAgent()
    setManualAgent(agent)
    const model = scripted([
      () => ({ name: 'navigate', arguments: { url: 'https://www.fl.ru/' } }),
      async () => {
        await startManual()
        return { name: 'wait', arguments: { ms: 100 } }
      },
      () => ({ name: 'wait', arguments: { ms: 100 } }),
    ])
    expect(await computerUseTick({ agent, model })).toBe(true)
    let row = await task()
    // The step that started the lease still ran; the next one did not.
    expect(row).toMatchObject({ status: 'running', step_count: 2 })
    expect((await query('SELECT lease_id FROM computer_use WHERE id=true'))[0]!.lease_id).toBeNull()
    expect(await computerUseTick({ agent, model })).toBe(false)
    expect((await computerUseView()).state.blocked).toContain('COMPUTER_USE_MANUAL_CONTROL')
    const typed = await manualAct({ name: 'type', text: 'secret-password-of-owner' })
    expect(typed.ok).toBe(true)
    const audits = await query(
      "SELECT * FROM audit_events WHERE kind='computer_use_manual_action' ORDER BY created_at",
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]!.data).toMatchObject({ action: 'type', chars: 24 })
    expect(JSON.stringify(audits)).not.toContain('secret-password')
    expect(JSON.stringify(await steps(row.id))).not.toContain('secret-password')
    const [owner] = await query('SELECT manual_session_id FROM computer_use WHERE id=true')
    expect(owner!.manual_session_id).not.toBeNull()
    expect(agent.sessions.size).toBe(2)
    await stopManual()
    expect(agent.sessions.size).toBe(1)
    await expect(manualAct({ name: 'key', key: 'Enter' })).rejects.toThrow(
      'COMPUTER_USE_MANUAL_NOT_ACTIVE',
    )
    expect(await computerUseTick({ agent, model })).toBe(true)
    row = await task()
    expect(row).toMatchObject({ status: 'done', step_count: 4 })
  })

  it('serves the owner routes with the session and the right origin only', async () => {
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
    setManualAgent(new FakeVmAgent())
    expect(
      (await call('POST', '/api/computer-use/manual', undefined, { action: 'start' })).status,
    ).toBe(401)
    expect((await call('GET', '/api/computer-use/manual/screen.png')).status).toBe(401)
    const foreign = await fetch(base + '/api/computer-use/manual/act', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{"name":"key","key":"Enter"}',
    })
    expect(foreign.status).toBe(403)
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    expect((await call('GET', '/api/computer-use/manual/screen.png', session)).status).toBe(409)
    const started = await call('POST', '/api/computer-use/manual', session, { action: 'start' })
    expect(started.status).toBe(200)
    expect(started.json.state.manualUntil).not.toBeNull()
    const screen = await call('GET', '/api/computer-use/manual/screen.png', session)
    expect(screen.status).toBe(200)
    expect(screen.type).toBe('image/png')
    const acted = await call('POST', '/api/computer-use/manual/act', session, {
      name: 'navigate',
      url: 'https://www.fl.ru/login',
    })
    expect(acted.status).toBe(200)
    expect(acted.json).toMatchObject({ ok: true, url: 'https://www.fl.ru/login' })
    expect(
      (await call('POST', '/api/computer-use/manual/act', session, { name: 'type', text: 'a\n' }))
        .status,
    ).toBe(400)
    const stopped = await call('POST', '/api/computer-use/manual', session, { action: 'stop' })
    expect(stopped.json.state.manualUntil).toBeNull()
    expect(
      (
        await call('POST', '/api/computer-use/platforms', session, {
          domain: 'evil.example',
          loggedIn: true,
        })
      ).json.statusMessage,
    ).toBe('COMPUTER_USE_PLATFORM_UNKNOWN')
    const marked = await call('POST', '/api/computer-use/platforms', session, {
      domain: 'kwork.ru',
      loggedIn: true,
    })
    expect(marked.json.platforms.find((p: any) => p.domain === 'kwork.ru').loggedIn).toBe(true)
    expect(marked.json.state.rotationGoals).toBe(builtInDirections.length + 2)
    const switched = await call('POST', '/api/computer-use/control', session, {
      action: 'auto_proposals_on',
    })
    expect(switched.json.state).toMatchObject({ autoProposals: true, autoProposalsAllowed: true })
  })
})
