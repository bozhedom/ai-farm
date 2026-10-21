import { createServer, type Server } from 'node:http'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as settings from '../../core/config'
import { pool, query } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { FakeVmAgent } from '../../core/computer-use/client'
import type { ElementInfo } from '../../core/computer-use/policy'
import {
  addOwnerGoal,
  computerUseTick,
  controlComputerUse,
  setPlatformLogin,
} from '../../core/computer-use/runtime'
import { saveProfile } from '../../core/computer-use/profile'
import { computerUseView } from '../../core/computer-use/view'
import type { ComputerUseModel, ModelInput } from '../../core/computer-use/model'
import security from '../../server/middleware/security'
import profileGet from '../../server/api/computer-use/profile.get'
import profilePut from '../../server/api/computer-use/profile.put'
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
  router.get('/api/computer-use/profile', profileGet)
  router.put('/api/computer-use/profile', profilePut)
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
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await pool.end()
})

const profile = {
  displayName: 'Анна К.',
  bio: 'Пишу описания товаров для интернет-магазинов. 3 года опыта в копирайтинге.',
  skills: ['Описания товаров'],
  languages: ['русский'],
  rates: [{ service: 'Описание товара', amount: 50000, currency: 'RUB', unit: 'за штуку' }],
  minimumPrices: [{ currency: 'RUB', amount: 400000 }],
  proposalsPerDay: 5,
  samples: [{ title: 'Описания для магазина посуды', text: 'Чайник из стали.', url: '' }],
}

describe('performer profile routes', () => {
  it('needs the owner session and the right origin, and validates the body', async () => {
    const call = (method: 'GET' | 'PUT', cookie?: string, body?: unknown, from = origin) =>
      fetch(base + '/api/computer-use/profile', {
        method,
        headers: {
          ...(cookie ? { cookie: `farm_session=${cookie}` } : {}),
          ...(method === 'PUT' ? { origin: from, 'content-type': 'application/json' } : {}),
        },
        body: method === 'PUT' ? JSON.stringify(body ?? {}) : undefined,
      })
    expect((await call('GET')).status).toBe(401)
    expect((await call('PUT', undefined, { profile })).status).toBe(401)
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    expect((await call('PUT', session, { profile }, 'https://evil.example')).status).toBe(403)

    const empty = await call('GET', session)
    expect(empty.status).toBe(200)
    const shown = await empty.json()
    expect(shown).toMatchObject({ updatedAt: null, profile: { bio: '', rates: [] } })
    expect(shown.limits).toMatchObject({
      bio: 600,
      proposalsPerDay: original.COMPUTER_USE_PROPOSALS_PER_DAY,
    })

    const saved = await call('PUT', session, { profile })
    expect(saved.status).toBe(200)
    const body = await saved.json()
    expect(body.profile).toMatchObject({ displayName: 'Анна К.', proposalsPerDay: 5 })
    expect(body.updatedAt).not.toBeNull()
    expect((await (await call('GET', session)).json()).profile.minimumPrices).toEqual([
      { currency: 'RUB', amount: 400000 },
    ])

    const contact = await call('PUT', session, {
      profile: { ...profile, bio: 'Пишите в телеграм @anna_texts' },
    })
    expect(contact.status).toBe(409)
    expect((await contact.json()).statusMessage).toBe('COMPUTER_USE_PROFILE_CONTACT_DETAILS')
    const float = await call('PUT', session, {
      profile: { ...profile, minimumPrices: [{ currency: 'RUB', amount: 10.5 }] },
    })
    expect((await float.json()).statusMessage).toBe('COMPUTER_USE_PROFILE_INVALID')
    const over = await call('PUT', session, { profile: { ...profile, proposalsPerDay: 101 } })
    expect((await over.json()).statusMessage).toMatch(/COMPUTER_USE_PROFILE_/)
    expect((await call('PUT', session, { profile, extra: 1 })).status).toBe(400)
    // A refused update leaves the stored profile as it was.
    expect((await (await call('GET', session)).json()).profile.bio).toBe(profile.bio)
    // Only the successful save is audited.
    expect(
      await query("SELECT id FROM audit_events WHERE kind='computer_use_profile'"),
    ).toHaveLength(1)
  })
})

const sendButton: ElementInfo = {
  tag: 'button',
  type: 'submit',
  name: '',
  text: 'Отправить отклик',
  href: '',
  autocomplete: '',
}
const job = 'https://www.fl.ru/projects/42/'
const note = (url: string, amount: number | null) => ({
  name: 'note_opportunity',
  arguments: {
    title: 'Описания товаров для магазина мебели',
    url,
    summary: 'Нужно 20 описаний диванов и кресел для каталога, срок неделя.',
    kind: 'freelance',
    requiresHuman: false,
    decision: 'take',
    fit: 85,
    ai_forbidden: false,
    estimated_value: amount === null ? null : { amount, currency: 'RUB' },
    reason: 'Текстовая работа, можно сделать и сдать на площадке.',
  },
})
const proposalText =
  'Здравствуйте! Прочитала задание: нужно 20 описаний диванов и кресел для каталога. У меня 3 года опыта в копирайтинге, сделаю в едином стиле: характеристики, материалы, для какого интерьера подходит. Первые два описания пришлю на согласование завтра.'
const draft = (url: string, price: number | null, currency: string | null = 'RUB') => ({
  name: 'draft_proposal',
  arguments: {
    opportunity_url: url,
    platform_domain: 'fl.ru',
    text: proposalText,
    price_amount: price,
    price_currency: price === null ? null : currency,
  },
})
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

describe('performer profile in draft_proposal', () => {
  it('blocks a price below the minimum and applies the lower proposal limit', async () => {
    await saveProfile(profile)
    await controlComputerUse('enable')
    await controlComputerUse('auto_proposals_on')
    await setPlatformLogin('fl.ru', true)
    await addOwnerGoal('Проверь новые задания на fl.ru и откликнись на подходящие')
    const cheap = 'https://www.fl.ru/projects/43/'
    const seen: ModelInput[] = []
    const model = scripted([
      (input) => {
        seen.push(input)
        return { name: 'navigate', arguments: { url: job } }
      },
      () => note(job, 500000),
      () => note(cheap, 300000),
      () => draft(job, 399999),
      () => draft(job, 500, null),
      // No explicit price: the recorded job budget below the minimum is the bid.
      () => draft(cheap, null),
      // The bio fact "3 года опыта в копирайтинге" is repeated word for word: allowed.
      () => draft(job, 400000),
    ])
    await computerUseTick({ agent: new FakeVmAgent({ target: sendButton }), model })
    const [row] = await query('SELECT * FROM computer_use_tasks ORDER BY created_at DESC LIMIT 1')
    const recorded = await query(
      'SELECT action,decision,reason FROM computer_use_steps WHERE task_id=$1 ORDER BY step_no',
      [row!.id],
    )
    expect(recorded.map((s) => [s.action.name, s.decision, s.reason])).toEqual([
      ['navigate', 'allowed', ''],
      ['note_opportunity', 'allowed', ''],
      ['note_opportunity', 'allowed', ''],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_PRICE_BELOW_MINIMUM'],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_PRICE_CURRENCY_REQUIRED'],
      ['draft_proposal', 'blocked', 'COMPUTER_USE_PRICE_BELOW_MINIMUM'],
      ['draft_proposal', 'allowed', 'COMPUTER_USE_PERMIT_GRANTED'],
      ['finish', 'allowed', ''],
    ])
    const proposals = await query('SELECT price_amount FROM computer_use_proposals')
    expect(proposals.map((p) => Number(p.price_amount))).toEqual([400000])
    // The model saw the compact profile and the lowered limit.
    expect(seen[0]!.profile).toMatchObject({
      display_name: 'Анна К.',
      minimum_price: [{ amount_minor: 400000, currency: 'RUB' }],
    })
    expect(seen[0]!.platforms?.proposalsPerDay).toBe(5)
    expect((await computerUseView()).state.proposalsPerDay).toBe(5)
  })

  it('keeps the strict claim check when the profile is empty', async () => {
    await controlComputerUse('enable')
    await controlComputerUse('auto_proposals_on')
    await setPlatformLogin('fl.ru', true)
    await addOwnerGoal('Проверь новые задания на fl.ru и откликнись на подходящие')
    const seen: ModelInput[] = []
    const model = scripted([
      (input) => {
        seen.push(input)
        return { name: 'navigate', arguments: { url: job } }
      },
      () => note(job, 500000),
      () => draft(job, 100),
    ])
    await computerUseTick({ agent: new FakeVmAgent({ target: sendButton }), model })
    const [row] = await query('SELECT * FROM computer_use_tasks ORDER BY created_at DESC LIMIT 1')
    const [last] = await query(
      `SELECT decision,reason FROM computer_use_steps WHERE task_id=$1 AND action->>'name'='draft_proposal'`,
      [row!.id],
    )
    expect(last).toMatchObject({ decision: 'blocked', reason: 'COMPUTER_USE_UNVERIFIED_CLAIM' })
    expect(seen[0]!.profile).toBeNull()
    expect(seen[0]!.platforms?.proposalsPerDay).toBe(original.COMPUTER_USE_PROPOSALS_PER_DAY)
  })
})
