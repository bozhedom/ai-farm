import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query, transaction } from '../../core/db'
import { attemptLogin } from '../../core/auth'
import { FakeVmAgent } from '../../core/computer-use/client'
import { builtInDirections, retiredBuiltInGoals } from '../../core/computer-use/goals'
import { validateGoal } from '../../core/computer-use/policy'
import {
  createDirection,
  ensureDirections,
  DIRECTION_LIMITS,
  listDirections,
} from '../../core/computer-use/directions'
import {
  computerUseTick,
  controlComputerUse,
  pickRotationGoal,
  setPlatformLogin,
} from '../../core/computer-use/runtime'
import { computerUseView } from '../../core/computer-use/view'
import security from '../../server/middleware/security'
import view from '../../server/api/computer-use/index.get'
import list from '../../server/api/computer-use/directions/index.get'
import create from '../../server/api/computer-use/directions/index.post'
import change from '../../server/api/computer-use/directions/[id].post'
import { applyMigrations, resetDatabase } from './helpers/db'

const origin = 'http://localhost:3210'
let server: Server
let base = ''

beforeAll(async () => {
  await applyMigrations()
  const app = createApp()
  app.use(security)
  const router = createRouter()
  router.get('/api/computer-use', view)
  router.get('/api/computer-use/directions', list)
  router.post('/api/computer-use/directions', create)
  router.post('/api/computer-use/directions/:id', change)
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

const call = async (method: 'GET' | 'POST', path: string, cookie?: string, body?: unknown) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie: `farm_session=${cookie}` } : {}),
      ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  return { status: response.status, json: (await response.json()) as any }
}
const ownGoal =
  'Найди русскоязычные подкасты, которые ищут редактора шоуноутов и расшифровок за оплату. Запиши условия и адреса; договор заключает владелец.'

describe('search directions: seed, owner routes, rotation', () => {
  it('seeds the built-in directions once and keeps owner changes', async () => {
    const first = await computerUseView()
    expect(first.directions.length).toBe(builtInDirections.length)
    expect(first.directions.every((d) => d.builtIn && d.enabled && d.weight === 3)).toBe(true)
    expect(first.directions.map((d) => d.title)).toEqual(builtInDirections.map((d) => d.title))
    expect(first.state.rotationGoals).toBe(builtInDirections.length)
    await query('UPDATE computer_use_directions SET enabled=false, title=$1 WHERE key=$2', [
      'Своё название',
      'bounties',
    ])
    const again = await computerUseView()
    expect(again.directions.length).toBe(builtInDirections.length)
    expect(again.directions.find((d) => d.title === 'Своё название')!.enabled).toBe(false)
    expect(again.state.rotationGoals).toBe(builtInDirections.length - 1)
  })

  it('serves the owner routes with the session and the right origin only', async () => {
    expect((await call('GET', '/api/computer-use/directions')).status).toBe(401)
    expect(
      (await call('POST', '/api/computer-use/directions', undefined, { title: 'x', goal: 'y' }))
        .status,
    ).toBe(401)
    const foreign = await fetch(base + '/api/computer-use/directions', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Подкасты', goal: ownGoal }),
    })
    expect(foreign.status).toBe(403)
    const session = await attemptLogin('test-owner-password-at-least-20', '127.0.0.1')
    const listed = await call('GET', '/api/computer-use/directions', session)
    expect(listed.status).toBe(200)
    expect(listed.json.directions.length).toBe(builtInDirections.length)

    // Forbidden schemes and excluded topics are refused with the same codes as owner goals.
    for (const [goal, code] of [
      [
        'Найди, где купить аккаунты и дропы для аирдропов, чтобы получать награды много раз.',
        'COMPUTER_USE_SCHEME_BLOCKED',
      ],
      ['Найди сервисы для обхода верификации и KYC на биржах.', 'COMPUTER_USE_SCHEME_BLOCKED'],
      ['Найди букмекеров с партнёрской программой для прогнозов.', 'POLICY_IDEA_TOPIC_BLOCKED'],
    ] as const) {
      const refused = await call('POST', '/api/computer-use/directions', session, {
        title: 'Проверка',
        goal,
      })
      expect(refused.status).toBe(409)
      expect(refused.json.statusMessage).toBe(code)
    }
    expect(
      (
        await call('POST', '/api/computer-use/directions', session, {
          title: 'Мультиаккаунты',
          goal: ownGoal,
        })
      ).json.statusMessage,
    ).toBe('COMPUTER_USE_SCHEME_BLOCKED')
    expect(
      (
        await call('POST', '/api/computer-use/directions', session, {
          title: 'Короткое',
          goal: 'мало',
        })
      ).json.statusMessage,
    ).toBe('COMPUTER_USE_GOAL_LENGTH')
    expect(
      (
        await call('POST', '/api/computer-use/directions', session, {
          title: 'Подкасты',
          goal: ownGoal,
          weight: 9,
        })
      ).status,
    ).toBe(400)

    const created = await call('POST', '/api/computer-use/directions', session, {
      title: 'Подкасты',
      goal: ownGoal,
      weight: 5,
    })
    expect(created.status).toBe(200)
    const own = created.json.directions.find((d: any) => d.id === created.json.id)
    expect(own).toMatchObject({ title: 'Подкасты', weight: 5, builtIn: false, enabled: true })
    expect(created.json.directions.length).toBe(builtInDirections.length + 1)

    const edited = await call('POST', `/api/computer-use/directions/${own.id}`, session, {
      action: 'update',
      title: 'Подкасты и шоуноуты',
      weight: 2,
    })
    expect(edited.json.directions.find((d: any) => d.id === own.id)).toMatchObject({
      title: 'Подкасты и шоуноуты',
      weight: 2,
      goal: ownGoal,
    })
    expect(
      (
        await call('POST', `/api/computer-use/directions/${own.id}`, session, {
          action: 'update',
          goal: 'Найди фермы аккаунтов и сибил-схемы для аирдропов.',
        })
      ).json.statusMessage,
    ).toBe('COMPUTER_USE_SCHEME_BLOCKED')

    const builtIn = listed.json.directions[0]
    const disabled = await call('POST', `/api/computer-use/directions/${builtIn.id}`, session, {
      action: 'disable',
    })
    expect(disabled.json.directions.find((d: any) => d.id === builtIn.id).enabled).toBe(false)
    expect(disabled.json.state.rotationGoals).toBe(builtInDirections.length)
    const refusedDelete = await call(
      'POST',
      `/api/computer-use/directions/${builtIn.id}`,
      session,
      {
        action: 'delete',
      },
    )
    expect(refusedDelete.status).toBe(409)
    expect(refusedDelete.json.statusMessage).toBe('COMPUTER_USE_DIRECTION_BUILT_IN')
    const enabled = await call('POST', `/api/computer-use/directions/${builtIn.id}`, session, {
      action: 'enable',
    })
    expect(enabled.json.directions.find((d: any) => d.id === builtIn.id).enabled).toBe(true)

    const deleted = await call('POST', `/api/computer-use/directions/${own.id}`, session, {
      action: 'delete',
    })
    expect(deleted.status).toBe(200)
    expect(deleted.json.directions.length).toBe(builtInDirections.length)
    expect(
      (
        await call('POST', `/api/computer-use/directions/${randomUUID()}`, session, {
          action: 'disable',
        })
      ).status,
    ).toBe(404)
    const audits = await query(
      "SELECT message FROM audit_events WHERE kind='computer_use_direction'",
    )
    expect(audits.length).toBe(5)
  })

  it('rotates through enabled directions only and counts findings per direction', async () => {
    await computerUseView()
    await query('UPDATE computer_use_directions SET enabled=false')
    const id = randomUUID()
    await query('INSERT INTO computer_use_directions(id,title,goal,weight) VALUES($1,$2,$3,5)', [
      id,
      'Подкасты',
      ownGoal,
    ])
    await controlComputerUse('enable')
    const agent = new FakeVmAgent()
    expect(await computerUseTick({ agent })).toBe(true)
    const [task] = await query('SELECT * FROM computer_use_tasks ORDER BY created_at DESC LIMIT 1')
    expect(task).toMatchObject({ source: 'rotation', goal: ownGoal, direction_id: id })
    // The demo script records one finding the owner must look at.
    const [direction] = await listDirections().then((rows) => rows.filter((r) => r.id === id))
    expect(direction).toMatchObject({
      tasks: 1,
      found: 1,
      take_count: 0,
      human_count: 1,
      skip_count: 0,
    })
    expect(direction!.last_run_at).not.toBeNull()
    const view = await computerUseView()
    expect(view.directions.find((d) => d.id === id)).toMatchObject({ tasks: 1, found: 1, human: 1 })
    // Deleting the owner's direction keeps its task and finding.
    await query('DELETE FROM computer_use_directions WHERE id=$1', [id])
    const [kept] = await query('SELECT direction_id FROM computer_use_tasks WHERE id=$1', [
      task!.id,
    ])
    expect(kept!.direction_id).toBeNull()
    expect((await query('SELECT count(*)::int AS n FROM computer_use_opportunities'))[0]!.n).toBe(1)
  })

  it('rewords an unedited built-in goal and leaves an owner edit alone', async () => {
    const [old] = retiredBuiltInGoals.small_tenders!
    const current = builtInDirections.find((d) => d.key === 'small_tenders')!.goal
    expect(current).not.toContain('zakupki.gov.ru')
    expect(() => validateGoal(current)).not.toThrow()
    await ensureDirections()
    // A database seeded before the rewording still holds the old text.
    await query("UPDATE computer_use_directions SET goal=$1 WHERE key='small_tenders'", [old])
    await ensureDirections()
    const goalOf = async () =>
      (await query("SELECT goal FROM computer_use_directions WHERE key='small_tenders'"))[0]!.goal
    expect(await goalOf()).toBe(current)
    // The owner's own wording is never overwritten.
    const mine = 'Найди малые закупки текстов на региональных порталах закупок.'
    await query("UPDATE computer_use_directions SET goal=$1 WHERE key='small_tenders'", [mine])
    await ensureDirections()
    expect(await goalOf()).toBe(mine)
  })

  it('keeps the direction limit under concurrent creates', async () => {
    await computerUseView()
    const [{ n }] = (await query('SELECT count(*)::int AS n FROM computer_use_directions')) as [
      { n: number },
    ]
    const free = 3
    for (let index = n; index < DIRECTION_LIMITS.maxDirections - free; index++)
      await query('INSERT INTO computer_use_directions(id,title,goal,weight) VALUES($1,$2,$3,3)', [
        randomUUID(),
        `Направление ${index}`,
        'Найди задания по редактуре текстов на площадках.',
      ])
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        createDirection({
          title: `Параллельное ${index}`,
          goal: 'Найди задания по переводу инструкций на открытых площадках.',
        }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(free)
    for (const r of results.filter((r) => r.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason.message).toBe('COMPUTER_USE_DIRECTIONS_LIMIT')
    const [total] = await query('SELECT count(*)::int AS n FROM computer_use_directions')
    expect(total!.n).toBe(DIRECTION_LIMITS.maxDirections)
  })

  it('starts nothing when no direction is enabled and no platform is logged in', async () => {
    await computerUseView()
    // A stale login row for a domain that is no longer a configured platform yields no goals.
    await query("INSERT INTO computer_use_platforms(domain,logged_in) VALUES('gone.example',true)")
    await query('UPDATE computer_use_directions SET enabled=false')
    await controlComputerUse('enable')
    expect(await computerUseTick({ agent: new FakeVmAgent() })).toBe(false)
    expect((await query('SELECT count(*)::int AS n FROM computer_use_tasks'))[0]!.n).toBe(0)
    const view = await computerUseView()
    expect(view.state.rotationGoals).toBe(0)
    expect(view.state.blocked).toContain('COMPUTER_USE_NO_DIRECTIONS')
  })

  it('keeps platform goals ahead of directions and favours yield without starving', async () => {
    await computerUseView()
    await setPlatformLogin('kwork.ru', true)
    const picks = await transaction(async (db) => {
      const result: { goal: string; directionId: string | null }[] = []
      for (let index = 0; index < 6; index++) result.push((await pickRotationGoal(index, db))!)
      return result
    })
    expect(picks.map((p) => p.directionId === null)).toEqual([true, true, false, true, true, false])
    expect(picks[0]!.goal).toContain('kwork.ru')
    expect(picks[1]!.goal).toContain('Проверь сообщения')
    expect(picks[2]!.directionId).not.toBe(picks[5]!.directionId)
    const view = await computerUseView()
    expect(view.state.rotationGoals).toBe(builtInDirections.length + 2)

    // Three directions left: a dry one, a rich one and a fresh one. The rich one runs most, the
    // dry one still runs.
    await query('UPDATE computer_use_directions SET enabled=false, credit=0')
    await query(
      `UPDATE computer_use_directions SET enabled=true, tasks=6, found=0 WHERE key='grants'`,
    )
    await query(
      `UPDATE computer_use_directions SET enabled=true, tasks=6, found=8, take_count=6, human_count=2 WHERE key='hackathons'`,
    )
    await query(`UPDATE computer_use_directions SET enabled=true WHERE key='affiliate'`)
    const runs = await transaction(async (db) => {
      const result: string[] = []
      for (let index = 0; index < 34; index++)
        result.push((await pickRotationGoal(index, db))!.goal)
      return result
    })
    const of = (key: string) =>
      runs.filter((goal) => goal === builtInDirections.find((d) => d.key === key)!.goal).length
    // 34 steps with one platform: indexes 2, 5, ..., 32 are the 11 direction picks.
    expect(of('grants') + of('hackathons') + of('affiliate')).toBe(11)
    expect(of('grants')).toBeGreaterThanOrEqual(1)
    expect(of('hackathons')).toBeGreaterThan(of('affiliate'))
    expect(of('affiliate')).toBeGreaterThan(of('grants'))
  })
})
