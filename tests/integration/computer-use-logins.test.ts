import { createServer, type Server } from 'node:http'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { FakeVmAgent } from '../../core/computer-use/client'
import { saveCredentials } from '../../core/computer-use/credentials'
import { COMPUTER_USE_POLICY as P } from '../../core/computer-use/policy'
import {
  addOwnerGoal,
  computerUseTick,
  controlComputerUse,
  loggedInPlatforms,
} from '../../core/computer-use/runtime'
import type { ComputerUseModel, ModelInput } from '../../core/computer-use/model'
import security from '../../server/middleware/security'
import logins from '../../server/api/computer-use/logins.post'
import { applyMigrations, resetDatabase } from './helpers/db'

const origin = 'http://localhost:3210'
const username = 'owner.login@example.org'
const password = 'Very-Secret-Pa55word'
let server: Server
let base = ''

beforeAll(async () => {
  await applyMigrations()
  const app = createApp()
  app.use(security)
  const router = createRouter()
  router.post('/api/computer-use/logins', logins)
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
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

function scripted(steps: ((input: ModelInput) => unknown)[]): ComputerUseModel {
  let index = 0
  return async (input) => {
    const next = steps[index++]
    const value = next ? await next(input) : { name: 'finish', arguments: { report: 'Готово.' } }
    return { note: 'Тестовый шаг', ...(value as { name: string; arguments: unknown }) }
  }
}
const task = async () =>
  (await query('SELECT * FROM computer_use_tasks ORDER BY created_at DESC LIMIT 1'))[0]!
const steps = (taskId: string) =>
  query('SELECT * FROM computer_use_steps WHERE task_id=$1 ORDER BY step_no', [taskId])
const go = (url: string) => () => ({ name: 'navigate', arguments: { url } })
const logIn =
  (domain = 'fl.ru') =>
  () => ({
    name: 'log_in',
    arguments: { platform_domain: domain },
  })
/** No stored or logged value anywhere in the database may hold the login in clear. */
async function assertNoClearValues() {
  const dump = JSON.stringify(
    await Promise.all(
      [
        'computer_use_steps',
        'computer_use_credentials',
        'computer_use_tasks',
        'audit_events',
        'computer_use_approvals',
      ].map((table) => query(`SELECT * FROM ${table}`)),
    ),
  )
  expect(dump).not.toContain(password)
  expect(dump).not.toContain(username)
}

describe('stored platform logins: the model signs in, the values stay on the server', () => {
  it('fills the stored login on the platform page and never shows it to the model', async () => {
    await controlComputerUse('enable')
    await saveCredentials({ domain: 'fl.ru', username, password, loginUrl: '' })
    expect(await loggedInPlatforms()).toEqual(['fl.ru'])
    await addOwnerGoal('Войди на fl.ru и проверь новые задания')
    const agent = new FakeVmAgent()
    const seen: ModelInput[] = []
    const model = scripted([
      go('https://www.fl.ru/login/'),
      (input) => {
        expect(input.platforms).toMatchObject({ loggedIn: ['fl.ru'], canLogIn: ['fl.ru'] })
        return logIn()()
      },
      (input) => {
        seen.push(input)
        return { name: 'finish', arguments: { report: 'Вход выполнен.' } }
      },
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    expect(row.status).toBe('done')
    expect((await steps(row.id)).map((s) => [s.action, s.decision, s.reason])).toEqual([
      [{ name: 'navigate', url: 'https://www.fl.ru/login/' }, 'allowed', ''],
      [{ name: 'log_in', platform_domain: 'fl.ru' }, 'allowed', ''],
      [{ name: 'finish', report: 'Вход выполнен.' }, 'allowed', ''],
    ])
    expect(agent.actions.map((a) => a.action)).toEqual([
      { name: 'navigate', url: 'https://www.fl.ru/login/' },
      { name: 'fill_login', hosts: ['fl.ru'], username, password },
    ])
    expect(JSON.stringify(seen)).not.toContain(password)
    expect(JSON.stringify(seen)).not.toContain(username)
    const [stored] = await query('SELECT * FROM computer_use_credentials')
    expect(stored).toMatchObject({ domain: 'fl.ru', last_login_error: '' })
    expect(stored!.last_login_at).toBeInstanceOf(Date)
    const [logged] = await query("SELECT data FROM audit_events WHERE kind='computer_use_login'")
    expect(logged!.data).toMatchObject({ domain: 'fl.ru', ok: true, stepNo: 2 })
    await assertNoClearValues()
  })

  it('refuses another host, a platform without a login and too many attempts', async () => {
    await controlComputerUse('enable')
    await saveCredentials({ domain: 'fl.ru', username, password, loginUrl: '' })
    await addOwnerGoal('Войди на fl.ru и проверь новые задания')
    const agent = new FakeVmAgent()
    const model = scripted([
      go('https://fl.ru.evil.example/login'),
      logIn(),
      go('http://www.fl.ru/login/'),
      logIn(),
      go('https://kwork.ru/login'),
      logIn('kwork.ru'),
      logIn('example.com'),
      go('https://www.fl.ru/login/'),
      ...Array.from({ length: P.maxLoginAttemptsPerDomainPerDay + 1 }, () => logIn()),
    ])
    await computerUseTick({ agent, model })
    const row = await task()
    const log = (await steps(row.id))
      .filter((s) => s.action.name === 'log_in')
      .map((s) => [s.action.platform_domain, s.decision, s.reason])
    expect(log).toEqual([
      ['fl.ru', 'blocked', 'COMPUTER_USE_LOGIN_HOST_MISMATCH'],
      ['fl.ru', 'blocked', 'COMPUTER_USE_LOGIN_HOST_MISMATCH'],
      ['kwork.ru', 'blocked', 'COMPUTER_USE_LOGIN_NOT_FOUND'],
      ['example.com', 'blocked', 'COMPUTER_USE_PLATFORM_UNKNOWN'],
      ...Array.from({ length: P.maxLoginAttemptsPerDomainPerDay }, () => ['fl.ru', 'allowed', '']),
      ['fl.ru', 'blocked', 'COMPUTER_USE_LOGIN_LIMIT'],
    ])
    expect(agent.actions.filter((a) => a.action.name === 'fill_login')).toHaveLength(
      P.maxLoginAttemptsPerDomainPerDay,
    )
    await assertNoClearValues()
  })

  it('records a failed fill and fills the extra login host of the owner page', async () => {
    await controlComputerUse('enable')
    await saveCredentials({
      domain: 'freelance.habr.com',
      username,
      password,
      loginUrl: 'https://account.habr.com/login',
    })
    await addOwnerGoal('Войди на freelance.habr.com и проверь новые задания')
    const agent = new FakeVmAgent({
      fail: (action) => (action.name === 'fill_login' ? 'LOGIN_FORM_NOT_FOUND' : ''),
    })
    const model = scripted([go('https://account.habr.com/login'), logIn('freelance.habr.com')])
    await computerUseTick({ agent, model })
    const row = await task()
    const [, step] = await steps(row.id)
    expect([step!.decision, step!.reason]).toEqual(['failed', 'LOGIN_FORM_NOT_FOUND'])
    expect(agent.actions[1]!.action).toMatchObject({
      name: 'fill_login',
      hosts: ['freelance.habr.com', 'account.habr.com'],
    })
    const [stored] = await query('SELECT last_login_error FROM computer_use_credentials')
    expect(stored!.last_login_error).toBe('LOGIN_FORM_NOT_FOUND')
  })

  it('stores, signs in and deletes through the owner route without echoing the values', async () => {
    const call = async (body: unknown, cookie?: string, from = origin) => {
      const response = await fetch(`${base}/api/computer-use/logins`, {
        method: 'POST',
        headers: {
          ...(cookie ? { cookie: `farm_session=${cookie}` } : {}),
          origin: from,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, text, json: JSON.parse(text) }
    }
    const save = { action: 'save', domain: 'fl.ru', username, password, signIn: true }
    expect((await call(save)).status).toBe(401)
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    expect((await call(save, session, 'https://evil.example')).status).toBe(403)
    const unknown = await call({ ...save, domain: 'example.com' }, session)
    expect([unknown.status, unknown.json.statusMessage]).toEqual([
      409,
      'COMPUTER_USE_PLATFORM_UNKNOWN',
    ])
    const badUrl = await call({ ...save, loginUrl: 'http://127.0.0.1/login' }, session)
    expect(badUrl.json.statusMessage).toBe('COMPUTER_USE_LOGIN_URL_INVALID')
    expect(badUrl.text).not.toContain(password)
    const saved = await call(save, session)
    expect(saved.status).toBe(200)
    expect(saved.text).not.toContain(password)
    expect(saved.text).not.toContain(username)
    expect(saved.json.platforms.find((p: any) => p.domain === 'fl.ru')).toMatchObject({
      loginSaved: true,
      loggedIn: false,
      lastLoginAt: null,
    })
    const [goal] = await query("SELECT goal,source FROM computer_use_tasks WHERE status='queued'")
    expect(goal).toMatchObject({ source: 'owner' })
    expect(goal!.goal).toContain('log_in')
    expect((await call({ action: 'sign_in', domain: 'fl.ru' }, session)).status).toBe(200)
    expect(
      (await query("SELECT count(*)::int AS n FROM computer_use_tasks WHERE status='queued'"))[0]!
        .n,
    ).toBe(2)
    await assertNoClearValues()
    expect((await call({ action: 'delete', domain: 'fl.ru' }, session)).status).toBe(200)
    expect(await query('SELECT * FROM computer_use_credentials')).toEqual([])
    const missing = await call({ action: 'sign_in', domain: 'fl.ru' }, session)
    expect([missing.status, missing.json.statusMessage]).toEqual([
      404,
      'COMPUTER_USE_LOGIN_NOT_FOUND',
    ])
  })
})
