import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest'
import { config } from '../../core/config'
import { pool, query } from '../../core/db'
import { withAgentProfiles, roleModel, saveProfile } from '../../core/agent-profiles'
import { ensureManager, managerTick, controlManager } from '../../core/manager/runtime'
import { bybitSnapshot, bybitScope, applyBybitReview } from '../../core/manager/live'
import type { LivePlanner } from '../../core/manager/live-plan'
import {
  livePlanSchema,
  liveCritiqueSchema,
  liveManagerArgs,
  liveAnalystArgs,
} from '../../core/manager/live-plan'
import { assertStrictModelSchema } from '../../core/providers/json-schema'
import { agents, atomic, portfolio, withTradingLock } from '../../core/trading/store'
import { units } from '../../core/trading/decimal'
import { SCOUT_POLICY } from '../../core/policy'
import { applyMigrations, resetDatabase } from './helpers/db'

const saved = { ...config() }
let id: string
const proposal = {
  kind: 'trend',
  params: { lookback: 90, entryBps: 80, takeProfitBps: 150 },
  hypothesis: 'Более редкие входы могут уменьшить комиссии на боковом движении.',
  rationale: 'У портфеля отрицательный результат после комиссий; проверим другой порог и окно.',
}
const plan = {
  summary: 'Есть убыток после комиссий. Проверяем изменение порога входа без увеличения риска.',
  proposal,
}
const critique = {
  approved: true,
  reason: 'Гипотеза проверяема по следующим сделкам, обещаний дохода и изменения риска нет.',
}
const planner: LivePlanner = async () => ({
  plan,
  critique,
  analystModel: 'anthropic/claude-opus-5.5',
})
const tick = (p: LivePlanner = planner) =>
  managerTick(
    async () => {
      throw new Error('Paper planner must not run')
    },
    () => false,
    true,
    p,
  )
const apply = () =>
  withTradingLock(bybitScope, (db) => atomic(db, () => applyBybitReview(bybitScope, db)))
const review = async () =>
  (await query('SELECT * FROM trading_live_reviews ORDER BY created_at DESC'))[0]!

beforeAll(applyMigrations)
beforeEach(async () => {
  await resetDatabase()
  await ensureManager()
  Object.assign(config(), {
    MODEL_PROVIDER: 'openai',
    OPENAI_TRANSPORT: 'openrouter',
    OPENROUTER_PAID_MODEL: 'openai/gpt-4.1-mini',
    BYBIT_STRATEGY_REVIEW_ENABLED: true,
    TRADING_LIVE_ENABLED: true,
  })
  await query("UPDATE trading_portfolios SET status='stopped',reason='OWNER_STOP'")
  await query(
    "UPDATE trading_portfolios SET capital=$1,peak=$1,day_equity=$1,status='running',reason='',started_at=now()-interval '2 days',checked_at=now(),heartbeat=now() WHERE exchange='bybit' AND mode='live'",
    [units('20').toString()],
  )
  id = randomUUID()
  await query(
    `INSERT INTO trading_agents(id,exchange,mode,name,symbol,kind,params,generation,initial_cash,cash,peak,realized,round_trips,selector_version,created_at,last_order_at)
    VALUES($1,'bybit','live','Live','BTC-USDT','reversion',$2,1,$3,$4,$3,$5,3,$6,now()-interval '2 days',now()-interval '1 hour')`,
    [
      id,
      { lookback: 60, entryBps: 60, takeProfitBps: 100 },
      units('20').toString(),
      units('19.4').toString(),
      units('-0.6').toString(),
      SCOUT_POLICY.version,
    ],
  )
  await query(
    "INSERT INTO trading_markets(exchange,mode,symbol,at,bid,ask) VALUES('bybit','live','BTC-USDT',now(),$1,$1)",
    [units('100').toString()],
  )
  const coin = {
    symbol: 'BTC-USDT',
    price: '100',
    turnover: '10000000',
    changeBps: 100,
    rangeBps: 400,
    spreadBps: 1,
    movementBps: 200,
    trendBps: 20,
    score: 100,
    reason: 'SCOUT_READY',
    eligible: true,
    inspectedAt: Date.now(),
  }
  await query(
    "INSERT INTO trading_scouts(exchange,mode,policy_version,scanned_at,coins) VALUES('bybit','live',$1,now(),$2)",
    [SCOUT_POLICY.version, JSON.stringify([coin])],
  )
  for (const role of ['manager', 'bybit-analyst'])
    await query('INSERT INTO agent_profiles(role,model,pricing) VALUES($1,$2,$3)', [
      role,
      'anthropic/claude-opus-5.5',
      {
        inputNano: 4000,
        outputNano: 20000,
        cacheWriteNano: 5000,
        contextLength: 1000000,
        maxOutputTokens: 64000,
        outputFormat: 'schema',
      },
    ])
  await controlManager('enable')
})
afterEach(() => Object.assign(config(), saved))
afterAll(() => pool.end())

it('reviews a live risk stop with all Paper stopped, routes both roles and never clears the stop', async () => {
  await query(
    "UPDATE trading_portfolios SET status='paused',reason='DAILY_LOSS_LIMIT' WHERE exchange='bybit' AND mode='live'",
  )
  const fn = vi.fn(async () => {
    expect(roleModel('manager')).toBe('anthropic/claude-opus-5.5')
    expect(roleModel('bybit-analyst')).toBe('anthropic/claude-opus-5.5')
    expect(roleModel('writer')).toBe('')
    return planner(null as never, null as never)
  })
  expect(await tick(fn)).toBe(true)
  expect((await review()).status).toBe('queued')
  const before = await portfolio(bybitScope)
  await apply()
  expect(await portfolio(bybitScope)).toEqual(before)
  expect((await review()).reason).toBe('MANAGER_RISK_PAUSED')
  expect(await tick(fn)).toBe(false)
  expect(fn).toHaveBeenCalledTimes(1)
  expect(await query('SELECT id FROM trading_manager_tasks')).toHaveLength(0)
})
it('applies only parameters once while conserving all balances and portfolio risk history', async () => {
  const before = (await agents(bybitScope))[0]!,
    p = await portfolio(bybitScope)
  expect(await tick()).toBe(true)
  await apply()
  await apply()
  const after = (await agents(bybitScope))[0]!
  expect(after).toEqual({ ...before, kind: proposal.kind, params: proposal.params })
  expect(await portfolio(bybitScope)).toEqual(p)
  expect((await review()).status).toBe('applied')
  expect(
    await query("SELECT id FROM trading_events WHERE reason='MANAGER_LIVE_APPLIED'"),
  ).toHaveLength(1)
  expect(await query('SELECT id FROM trading_orders')).toHaveLength(0)
})
it('reacts to new loss before six hours, coalesces identical events and respects the shared cooldown', async () => {
  const fn = vi.fn(async () => ({
    plan: { ...plan, proposal: null },
    critique: { ...critique, approved: false },
    analystModel: 'anthropic/claude-opus-5.5',
  }))
  expect(await tick(fn)).toBe(true)
  expect(await tick(fn)).toBe(false)
  await query('UPDATE trading_agents SET realized=$1,cash=$2 WHERE id=$3', [
    units('-0.8').toString(),
    units('19.2').toString(),
    id,
  ])
  expect(await tick(fn)).toBe(false)
  await query("UPDATE trading_manager SET attempted_at=now()-interval '31 minutes'")
  expect(await tick(fn)).toBe(true)
  expect(fn).toHaveBeenCalledTimes(2)
})
it('waits on an open position, unresolved order, stale market, manager pause and system pause', async () => {
  expect(await tick()).toBe(true)
  await query('UPDATE trading_agents SET base=1,basis=1 WHERE id=$1', [id])
  await apply()
  expect((await review()).reason).toBe('MANAGER_POSITION_OPEN')
  await query('UPDATE trading_agents SET base=0,basis=0 WHERE id=$1', [id])
  const order = randomUUID()
  await query(
    "INSERT INTO trading_orders(id,exchange,mode,agent_id,client_id,symbol,side,qty,price,status,reason) VALUES($1,'bybit','live',$2,'bybitreviewpending','BTC-USDT','buy',1,1,'unknown','TEST')",
    [order, id],
  )
  await apply()
  expect((await review()).reason).toBe('MANAGER_ORDER_PENDING')
  await query("UPDATE trading_orders SET status='rejected' WHERE id=$1", [order])
  await query("UPDATE trading_markets SET at=now()-interval '5 minutes'")
  await apply()
  expect((await review()).reason).toBe('MANAGER_SCOUT_STALE')
  await query('UPDATE trading_markets SET at=now()')
  await controlManager('pause')
  await apply()
  expect((await review()).reason).toBe('MANAGER_PAUSED')
  await query('UPDATE trading_manager SET enabled=true')
  await query("UPDATE system_state SET mode='paused'")
  await apply()
  expect((await review()).reason).toBe('MANAGER_SYSTEM_PAUSED')
  expect((await agents(bybitScope))[0]!.kind).toBe('reversion')
})
it('rejects stale proposals after trading changes and after analyst instructions change mid-call', async () => {
  expect(await tick()).toBe(true)
  await query('UPDATE trading_agents SET last_order_at=now() WHERE id=$1', [id])
  await apply()
  expect((await review()).status).toBe('rejected')
  await query(
    "UPDATE trading_manager SET attempted_at=now()-interval '31 minutes',requested_at=now()",
  )
  expect(
    await tick(async (s, r) => {
      await saveProfile({
        role: 'bybit-analyst',
        revision: 1,
        model: '',
        instruction: 'Проверяй гипотезы более строго по комиссиям.',
      })
      return planner(s, r)
    }),
  ).toBe(false)
  expect((await review()).reason).toBe('MANAGER_INSTRUCTIONS_CHANGED')
})
it('does not apply rejected or malformed model output, and does not retry a failed event immediately', async () => {
  expect(
    await tick(async () => ({
      plan,
      critique: {
        approved: false,
        reason: 'Данных недостаточно для обоснованной смены работающих параметров.',
      },
      analystModel: 'anthropic/claude-opus-5.5',
    })),
  ).toBe(true)
  await apply()
  expect((await review()).status).toBe('completed')
  await query(
    "UPDATE trading_manager SET attempted_at=now()-interval '31 minutes',requested_at=now()",
  )
  const fn = vi.fn(async () => ({
    plan: { ...plan, capital: 100 },
    critique,
    analystModel: 'anthropic/claude-opus-5.5',
  }))
  expect(await tick(fn)).toBe(false)
  expect((await review()).status).toBe('failed')
  expect(await tick(fn)).toBe(false)
  expect(fn).toHaveBeenCalledTimes(1)
  expect((await agents(bybitScope))[0]!.kind).toBe('reversion')
})
it('keeps local enablement, stale price and expiration gates', async () => {
  config().BYBIT_STRATEGY_REVIEW_ENABLED = false
  expect(await bybitSnapshot()).toBeNull()
  const fn = vi.fn(planner)
  expect(await tick(fn)).toBe(false)
  expect(fn).not.toHaveBeenCalled()
  config().BYBIT_STRATEGY_REVIEW_ENABLED = true
  await query('UPDATE trading_agents SET base=1,basis=1 WHERE id=$1', [id])
  await query("UPDATE trading_markets SET at=now()-interval '5 minutes'")
  expect(await bybitSnapshot()).toBeNull()
  await query('UPDATE trading_markets SET at=now()')
  await query('UPDATE trading_agents SET base=0,basis=0 WHERE id=$1', [id])
  expect(await tick()).toBe(true)
  await query("UPDATE trading_live_reviews SET expires_at=now()-interval '1 second'")
  await apply()
  expect((await review()).status).toBe('expired')
})
it('uses strict schemas for both actual provider requests and rejects paper-only strategies', async () => {
  const snapshot = (await bybitSnapshot())!
  assertStrictModelSchema(livePlanSchema)
  assertStrictModelSchema(liveCritiqueSchema)
  expect(
    livePlanSchema.safeParse({ ...plan, proposal: { ...proposal, kind: 'grid' } }).success,
  ).toBe(false)
  await withAgentProfiles(async () => {
    const run = { id: 'test', reservationId: 'test' }
    expect(liveManagerArgs(snapshot, run).role).toBe('Торговый менеджер')
    expect(liveAnalystArgs(snapshot, livePlanSchema.parse(plan), run).role).toBe(
      'Криптоаналитик Bybit',
    )
  })
})

it('shares the daily review ceiling with the existing manager', async () => {
  const fn = vi.fn(async () => ({
    plan: { ...plan, proposal: null },
    critique: { ...critique, approved: false },
    analystModel: 'anthropic/claude-opus-5.5',
  }))
  for (let i = 0; i < 4; i++) {
    await query(
      "UPDATE trading_manager SET attempted_at=now()-interval '31 minutes',requested_at=now()",
    )
    expect(await tick(fn)).toBe(true)
  }
  await query(
    "UPDATE trading_manager SET attempted_at=now()-interval '31 minutes',requested_at=now()",
  )
  expect(await tick(fn)).toBe(false)
  expect(fn).toHaveBeenCalledTimes(4)
  expect((await query('SELECT last_error FROM trading_manager'))[0]!.last_error).toBe(
    'MANAGER_DAILY_LIMIT',
  )
})

it('does not pay for an improving result and reacts to a new period of inactivity', async () => {
  const fn = vi.fn(async () => ({
    plan: { ...plan, proposal: null },
    critique: { ...critique, approved: false },
    analystModel: 'anthropic/claude-opus-5.5',
  }))
  expect(await tick(fn)).toBe(true)
  await query("UPDATE trading_manager SET attempted_at=now()-interval '31 minutes'")
  await query('UPDATE trading_agents SET realized=$1,cash=$2 WHERE id=$3', [
    units('-0.4').toString(),
    units('19.6').toString(),
    id,
  ])
  expect(await tick(fn)).toBe(false)
  await query("UPDATE trading_agents SET last_order_at=now()-interval '7 hours' WHERE id=$1", [id])
  expect(await tick(fn)).toBe(true)
  expect(fn).toHaveBeenCalledTimes(2)
})
