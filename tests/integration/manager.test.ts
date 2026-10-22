import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import { config } from '../../core/config'
import { MANAGER_POLICY as P, SCOUT_POLICY } from '../../core/policy'
import {
  controlManager,
  ensureManager,
  managerBudget,
  managerTick,
} from '../../core/manager/runtime'
import { managerSnapshot } from '../../core/manager/snapshot'
import { advanceManagerTasks, applyManagerTask, type TaskRow } from '../../core/manager/tasks'
import type { ManagerPlan, ManagerSnapshot } from '../../core/manager/plan'
import { units } from '../../core/trading/decimal'
import { controlTrading, tradingTick } from '../../core/trading/engine'
import {
  agents,
  atomic,
  configurePaperStrategies,
  paperCandidates,
  portfolio,
  scope,
  withTradingLock,
} from '../../core/trading/store'
import type {
  TradingExchange,
  TradingMode,
  TradingSymbol,
  TradingVenue,
} from '../../core/trading/types'
import type { ScoutCoin } from '../../core/trading/universe'
import { market } from '../fixtures/trading'
import { applyMigrations, resetDatabase } from './helpers/db'

const paper = scope('okx', 'paper')
const params = { lookback: 60, entryBps: 60, takeProfitBps: 100 }
const summary = 'Проверяем более редкие входы на бумаге с сохранением ограничений портфеля.'
let sourceId: string

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function plan(snapshot: ManagerSnapshot, overrides: Record<string, unknown> = {}): ManagerPlan {
  const source = snapshot.portfolios
    .find((p) => p.exchange === 'okx')!
    .agents.find((a) => a.id === sourceId)!
  return {
    summary,
    tasks: [
      {
        exchange: 'okx',
        sourceAgentId: sourceId,
        kind: source.kind,
        params: { ...source.params, entryBps: source.params.entryBps + 20 },
        hypothesis: 'Более редкие входы уменьшат число убыточных сделок после комиссий.',
        rationale: 'Свободный агент имеет убыток; проверяем иной порог входа на новых данных.',
        ...overrides,
      },
    ] as ManagerPlan['tasks'],
  }
}

async function insertAgent(
  exchange: TradingExchange,
  mode: TradingMode = 'paper',
  kind = 'reversion',
  young = false,
  symbol: TradingSymbol = 'BTC-USDT',
) {
  const id = randomUUID()
  await query(
    `INSERT INTO trading_agents(id,exchange,mode,name,symbol,kind,params,generation,initial_cash,cash,peak,selector_version,created_at)
    VALUES($1,$2,$3,'Контрольный агент',$4,$5,$6,4,$7,$7,$7,$8,$9)`,
    [
      id,
      exchange,
      mode,
      symbol,
      kind,
      params,
      units('25').toString(),
      SCOUT_POLICY.version,
      new Date(Date.now() - (young ? 0 : 2 * 86_400_000)),
    ],
  )
  return id
}

async function seedPaper() {
  await query(
    "UPDATE trading_portfolios SET status='running',started_at=now()-interval '2 days',checked_at=now(),heartbeat=now(),generation=4,peak=$1,day_equity=$2,risk_day=$3 WHERE exchange='okx' AND mode='paper'",
    [units('103').toString(), units('100').toString(), new Date().toISOString().slice(0, 10)],
  )
  const id = await insertAgent('okx')
  await query(
    'UPDATE trading_agents SET cash=$2,realized=$3,fees=$4,round_trips=8,max_drawdown_bps=700 WHERE id=$1',
    [id, units('24').toString(), units('-1').toString(), units('0.25').toString()],
  )
  await insertAgent('okx', 'paper', 'trend', true)
  await insertAgent('okx', 'paper', 'breakout', true, 'ETH-USDT')
  await insertAgent('okx', 'paper', 'reversion', true, 'ETH-USDT')
  const coins: ScoutCoin[] = ['BTC-USDT', 'ETH-USDT'].map((symbol) => ({
    symbol: symbol as TradingSymbol,
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
  }))
  await query(
    "INSERT INTO trading_scouts(exchange,mode,policy_version,scanned_at,coins) VALUES('okx','paper',$1,now(),$2)",
    [SCOUT_POLICY.version, JSON.stringify(coins)],
  )
  for (const symbol of ['BTC-USDT', 'ETH-USDT'])
    await query(
      "INSERT INTO trading_markets(exchange,mode,symbol,at,bid,ask) VALUES('okx','paper',$1,now(),$2,$3)",
      [symbol, units('100').toString(), units('100.01').toString()],
    )
  return id
}

async function queuedTask() {
  await controlManager('enable')
  expect(await managerTick(async (snapshot) => plan(snapshot))).toBe(true)
  const [task] = await query<TaskRow>('SELECT * FROM trading_manager_tasks')
  expect(task!.status).toBe('queued')
  return task!
}

async function apply() {
  await withTradingLock(paper, (db) => atomic(db, () => applyManagerTask(paper, db)))
}

async function advance() {
  await query('UPDATE trading_manager SET tasks_checked_at=NULL')
  await advanceManagerTasks()
}

async function taskById(id: string) {
  return (await query<TaskRow>('SELECT * FROM trading_manager_tasks WHERE id=$1', [id]))[0]!
}

beforeAll(applyMigrations)
beforeEach(async () => {
  await resetDatabase()
  await ensureManager()
  sourceId = await seedPaper()
})
afterAll(() => pool.end())

describe('durable paper manager', () => {
  it('publishes task foreign keys while another transaction holds the portfolio mutation lock', async () => {
    await controlManager('enable')
    const locked = deferred<void>(),
      release = deferred<void>()
    const lockWork = withTradingLock(paper, (db) =>
      atomic(db, async () => {
        await portfolio(paper, db, true)
        locked.resolve()
        await release.promise
      }),
    )
    await locked.promise
    const running = managerTick(async (snapshot) => plan(snapshot))
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        running,
        new Promise<string>((resolve) => {
          timeout = setTimeout(() => resolve('blocked by the foreign key'), 2000)
        }),
      ])
      expect(result).toBe(true)
      expect(await query('SELECT id FROM trading_manager_tasks')).toHaveLength(1)
    } finally {
      if (timeout) clearTimeout(timeout)
      release.resolve()
      await lockWork
      await running
    }
  })

  it('claims one run across workers without holding the trading lock during the planner', async () => {
    await controlManager('enable')
    const entered = deferred<ManagerSnapshot>(),
      result = deferred<ManagerPlan>()
    const planner = vi.fn(async (snapshot: ManagerSnapshot) => {
      entered.resolve(snapshot)
      return result.promise
    })
    const first = managerTick(planner)
    const snapshot = await entered.promise
    expect(await withTradingLock(paper, async () => 'available')).toBe('available')
    expect(await managerTick(planner)).toBe(false)
    expect(await query('SELECT id FROM trading_manager_runs')).toHaveLength(1)
    result.resolve(plan(snapshot))
    await first
    expect(planner).toHaveBeenCalledTimes(1)
    expect(await query('SELECT id FROM trading_manager_tasks')).toHaveLength(1)
    expect(
      await query(
        "SELECT id FROM budget_reservations WHERE category='trading_manager' AND status='open'",
      ),
    ).toHaveLength(0)
  })

  it('discards a late model reply after the manager is paused', async () => {
    await controlManager('enable')
    const entered = deferred<ManagerSnapshot>(),
      result = deferred<ManagerPlan>()
    const running = managerTick(async (snapshot) => {
      entered.resolve(snapshot)
      return result.promise
    })
    const snapshot = await entered.promise
    await controlManager('pause')
    result.resolve(plan(snapshot))
    expect(await running).toBe(false)
    await apply()
    expect(await query('SELECT id FROM trading_manager_tasks')).toHaveLength(0)
    expect((await query('SELECT status,error FROM trading_manager_runs'))[0]).toEqual({
      status: 'discarded',
      error: 'MANAGER_PAUSED',
    })
    expect(await agents(paper)).toHaveLength(4)
    expect((await agents(paper)).some((a) => a.id === sourceId)).toBe(true)
  })

  it('does not apply a reply after the owner stops the portfolio during planning', async () => {
    await controlManager('enable')
    const entered = deferred<ManagerSnapshot>(),
      result = deferred<ManagerPlan>()
    const running = managerTick(async (snapshot) => {
      entered.resolve(snapshot)
      return result.promise
    })
    const snapshot = await entered.promise
    await controlTrading(paper, 'stop')
    result.resolve(plan(snapshot))
    await running
    await apply()
    expect(
      (await query('SELECT status,reason,agent_id FROM trading_manager_tasks'))[0],
    ).toMatchObject({ status: 'queued', reason: 'OWNER_STOP', agent_id: null })
    expect(await portfolio(paper)).toMatchObject({ status: 'stopped', reason: 'OWNER_STOP' })
    expect((await agents(paper)).some((a) => a.id === sourceId)).toBe(true)
  })

  it('invalidates an old proposal when the owner selects a preset while the model answers', async () => {
    await controlManager('enable')
    const entered = deferred<ManagerSnapshot>(),
      result = deferred<ManagerPlan>()
    const running = managerTick(async (snapshot) => {
      entered.resolve(snapshot)
      return result.promise
    })
    const snapshot = await entered.promise
    await configurePaperStrategies('okx', 'adaptive')
    result.resolve(plan(snapshot))
    await running
    await apply()
    expect((await query('SELECT status,reason FROM trading_manager_tasks'))[0]).toEqual({
      status: 'rejected',
      reason: 'MANAGER_OWNER_CHANGED',
    })
    expect((await agents(paper)).some((a) => a.id === sourceId)).toBe(true)
    expect((await portfolio(paper)).manager_revision).toBe(1)
  })

  it('replaces a flat agent once, keeping capital, generation, portfolio risk and the archived evidence', async () => {
    const task = await queuedTask()
    const before = await portfolio(paper)
    const parent = (await agents(paper)).find((a) => a.id === sourceId)!
    const sum = (await agents(paper)).reduce((n, a) => n + BigInt(a.cash), 0n)
    await apply()
    await apply()
    const saved = await taskById(task.id)
    const children = await agents(paper)
    const child = children.find((a) => a.id === saved.agent_id)!
    expect(saved.status).toBe('observing')
    expect(children).toHaveLength(4)
    expect(children.reduce((n, a) => n + BigInt(a.cash), 0n)).toBe(sum)
    expect(child).toMatchObject({
      parent_id: sourceId,
      mode: 'paper',
      exchange: 'okx',
      generation: parent.generation,
      cash: parent.cash,
      initial_cash: parent.cash,
      peak: parent.cash,
      base: '0',
      basis: '0',
      realized: '0',
      fees: '0',
      round_trips: 0,
      max_drawdown_bps: 0,
      strategy_state: {},
    })
    expect(child.created_at.getTime()).toBeGreaterThan(parent.created_at.getTime())
    const archived = (await query('SELECT * FROM trading_agents WHERE id=$1', [sourceId]))[0]!
    expect(archived).toMatchObject({
      status: 'archived',
      cash: parent.cash,
      realized: parent.realized,
      fees: parent.fees,
      round_trips: parent.round_trips,
    })
    expect(await portfolio(paper)).toEqual(before)
    expect(
      await query(
        "SELECT id FROM trading_assignments WHERE agent_id=$1 AND reason='MANAGER_EXPERIMENT_STARTED'",
        [child.id],
      ),
    ).toHaveLength(1)
    expect(await query("SELECT id FROM trading_agents WHERE mode<>'paper'")).toHaveLength(0)
  })

  it('applies the queued experiment in the trading worker and executes its first paper order', async () => {
    const task = await queuedTask()
    const privateCall = vi.fn(async () => {
      throw new Error('Private exchange actions are unavailable in this fixture')
    })
    const venue: TradingVenue = {
      discover: async () => [],
      market: async (symbol) => market(symbol),
      account: privateCall,
      pending: async () => [],
      place: privateCall,
      order: privateCall,
      cancel: privateCall,
    }
    await tradingTick(
      () => venue,
      () => false,
      ['okx'],
    )
    const saved = await taskById(task.id)
    expect(saved.status).toBe('observing')
    const team = await agents(paper)
    const child = team.find((a) => a.id === saved.agent_id)!
    expect(team).toHaveLength(4)
    expect(child.parent_id).toBe(sourceId)
    expect(BigInt(child.base)).toBeGreaterThan(0n)
    expect((await portfolio(paper)).generation).toBe(4)
    expect(
      await query('SELECT mode,status,side FROM trading_orders WHERE agent_id=$1', [child.id]),
    ).toEqual([{ mode: 'paper', status: 'filled', side: 'buy' }])
    expect(await query("SELECT id FROM trading_orders WHERE mode<>'paper'")).toHaveLength(0)
    expect(privateCall).not.toHaveBeenCalled()
  })

  it('gives the planner exact decimal USDT and coin quantities rather than accounting atomics', async () => {
    const held = (await agents(paper)).find((a) => a.id !== sourceId)!
    await query('UPDATE trading_agents SET cash=$2,base=$3,basis=$2 WHERE id=$1', [
      held.id,
      units('12.5').toString(),
      units('0.125').toString(),
    ])
    const snapshot = (await managerSnapshot()).portfolios.find((p) => p.exchange === 'okx')!
    expect(snapshot.agents.find((a) => a.id === sourceId)).toMatchObject({
      cashUsdt: '24',
      baseQuantity: '0',
      pnlUsdt: '-1',
    })
    expect(snapshot.agents.find((a) => a.id === held.id)).toMatchObject({
      cashUsdt: '12.5',
      baseQuantity: '0.125',
      pnlUsdt: '-0.03125',
      canExperiment: false,
    })
    expect(snapshot.agents[0]).not.toHaveProperty('cash')
    expect(snapshot.agents[0]).not.toHaveProperty('base')
  })

  it.each([
    ['held', 'MANAGER_POSITION_OPEN'],
    ['order', 'MANAGER_ORDER_PENDING'],
    ['paused', 'OWNER_PAUSE'],
    ['scout', 'MANAGER_SCOUT_STALE'],
    ['manager', 'MANAGER_PAUSED'],
    ['system', 'MANAGER_SYSTEM_PAUSED'],
  ])(
    'defers %s without mutating agents, then applies once the blocker is removed',
    async (blocker, reason) => {
      const task = await queuedTask()
      const orderId = randomUUID()
      if (blocker === 'held')
        await query('UPDATE trading_agents SET base=$2,basis=$3,cash=$4 WHERE id=$1', [
          sourceId,
          units('0.1').toString(),
          units('10').toString(),
          units('14').toString(),
        ])
      if (blocker === 'order')
        await query(
          `INSERT INTO trading_orders(id,exchange,mode,agent_id,client_id,symbol,side,qty,price,status,reason)
      VALUES($1,'okx','paper',$2,$3,'BTC-USDT','buy',$4,$5,'unknown','TEST_UNKNOWN')`,
          [
            orderId,
            sourceId,
            randomUUID().replaceAll('-', ''),
            units('0.1').toString(),
            units('100').toString(),
          ],
        )
      if (blocker === 'paused') await controlTrading(paper, 'pause')
      if (blocker === 'scout')
        await query("UPDATE trading_scouts SET scanned_at=now()-interval '11 minutes'")
      if (blocker === 'manager') await controlManager('pause')
      if (blocker === 'system') await query("UPDATE system_state SET mode='emergency_stop'")
      const before = await agents(paper)
      await apply()
      expect(await agents(paper)).toEqual(before)
      expect(await taskById(task.id)).toMatchObject({ status: 'queued', reason, agent_id: null })
      if (blocker === 'held')
        await query('UPDATE trading_agents SET base=0,basis=0,cash=$2 WHERE id=$1', [
          sourceId,
          units('24').toString(),
        ])
      if (blocker === 'order')
        await query("UPDATE trading_orders SET status='canceled' WHERE id=$1", [orderId])
      if (blocker === 'paused')
        await query(
          "UPDATE trading_portfolios SET status='running',reason='' WHERE exchange='okx' AND mode='paper'",
        )
      if (blocker === 'scout') await query('UPDATE trading_scouts SET scanned_at=now()')
      if (blocker === 'manager') await controlManager('enable')
      if (blocker === 'system') await query("UPDATE system_state SET mode='running'")
      await apply()
      expect((await taskById(task.id)).status).toBe('observing')
    },
  )

  it.each(['foreign', 'live'])(
    'rejects a %s source that is absent from the permitted paper snapshot',
    async (variant) => {
      const other = await insertAgent(
        variant === 'foreign' ? 'bybit' : 'okx',
        variant === 'live' ? 'live' : 'paper',
      )
      await controlManager('enable')
      expect(await managerTick(async (snapshot) => plan(snapshot, { sourceAgentId: other }))).toBe(
        false,
      )
      expect(await query('SELECT id FROM trading_manager_tasks')).toHaveLength(0)
      expect((await query('SELECT status,error FROM trading_manager_runs'))[0]).toEqual({
        status: 'failed',
        error: 'MANAGER_TARGET_INVALID',
      })
      expect((await agents(paper)).some((a) => a.id === sourceId)).toBe(true)
    },
  )

  it('rejects a stale source assignment even when the agent id did not change', async () => {
    const task = await queuedTask()
    await query(
      "UPDATE trading_agents SET symbol='SOL-USDT',assigned_at=now()+interval '1 second' WHERE id=$1",
      [sourceId],
    )
    await apply()
    expect(await taskById(task.id)).toMatchObject({
      status: 'rejected',
      reason: 'MANAGER_AGENT_CHANGED',
      agent_id: null,
    })
  })

  it('requires both the observation time and five closures, then includes its own outcome in the next review', async () => {
    const task = await queuedTask()
    await apply()
    const child = (await taskById(task.id)).agent_id!
    await query('UPDATE trading_agents SET cash=$2,realized=$3,round_trips=5 WHERE id=$1', [
      child,
      units('25').toString(),
      units('1').toString(),
    ])
    await advance()
    expect((await taskById(task.id)).status).toBe('observing')
    await query(
      "UPDATE trading_manager_tasks SET evaluate_at=now()-interval '1 second' WHERE id=$1",
      [task.id],
    )
    await query('UPDATE trading_agents SET round_trips=4 WHERE id=$1', [child])
    await advance()
    expect((await taskById(task.id)).status).toBe('observing')
    await query('UPDATE trading_agents SET round_trips=5 WHERE id=$1', [child])
    await advance()
    expect(await taskById(task.id)).toMatchObject({
      status: 'completed',
      outcome: { verdict: 'positive', pnlUsdt: '1', roundTrips: 5 },
    })
    await query("UPDATE trading_agents SET created_at=now()-interval '25 hours' WHERE id=$1", [
      child,
    ])
    expect(await paperCandidates('okx')).toHaveLength(0)
    await query("UPDATE trading_manager SET attempted_at=now()-interval '31 minutes'")
    await controlManager('review')
    let snapshot: ManagerSnapshot | undefined
    expect(
      await managerTick(async (s) => {
        snapshot = s
        return { summary, tasks: [] }
      }),
    ).toBe(true)
    expect(snapshot!.recentTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          exchange: 'okx',
          status: 'completed',
          outcome: expect.objectContaining({ pnlUsdt: '1', verdict: 'positive' }),
        }),
      ]),
    )
  })

  it('does not score an open position from an old profitable quote and expires with insufficient evidence', async () => {
    const task = await queuedTask()
    await apply()
    const child = (await taskById(task.id)).agent_id!
    await query('UPDATE trading_agents SET cash=0,base=$2,basis=$3,round_trips=5 WHERE id=$1', [
      child,
      units('0.24').toString(),
      units('24').toString(),
    ])
    await query(
      "UPDATE trading_manager_tasks SET evaluate_at=now()-interval '1 second' WHERE id=$1",
      [task.id],
    )
    await query("UPDATE trading_markets SET at=now()-interval '2 minutes',bid=$1", [
      units('120').toString(),
    ])
    expect(
      (await managerSnapshot()).portfolios
        .find((p) => p.exchange === 'okx')!
        .agents.find((a) => a.id === child)!.pnlUsdt,
    ).toBeNull()
    await advance()
    expect(await taskById(task.id)).toMatchObject({
      status: 'observing',
      reason: 'MANAGER_PRICE_STALE',
      outcome: null,
    })
    await query(
      "UPDATE trading_manager_tasks SET expires_at=now()-interval '1 second' WHERE id=$1",
      [task.id],
    )
    await advance()
    expect(await taskById(task.id)).toMatchObject({
      status: 'completed',
      outcome: { verdict: 'insufficient', pnlUsdt: null },
    })
  })

  it('continues a deterministic evaluation when planning is paused without creating new work', async () => {
    const task = await queuedTask()
    await apply()
    const child = (await taskById(task.id)).agent_id!
    await query('UPDATE trading_agents SET round_trips=5 WHERE id=$1', [child])
    await query(
      "UPDATE trading_manager_tasks SET evaluate_at=now()-interval '1 second' WHERE id=$1",
      [task.id],
    )
    await controlManager('pause')
    await advance()
    expect(await taskById(task.id)).toMatchObject({
      status: 'completed',
      outcome: { verdict: 'negative', pnlUsdt: '0' },
    })
    expect((await query('SELECT enabled FROM trading_manager'))[0]!.enabled).toBe(false)
    expect(await query('SELECT id FROM trading_manager_runs')).toHaveLength(1)
    expect((await agents(paper)).find((a) => a.id === child)!.status).toBe('active')
  })

  it('does not spend model budget when no active paper agent exists', async () => {
    await query("UPDATE trading_agents SET status='archived',archived_at=now()")
    await controlManager('enable')
    const planner = vi.fn(async () => ({ summary, tasks: [] }))
    expect(await managerTick(planner)).toBe(false)
    expect(planner).not.toHaveBeenCalled()
    expect(await query('SELECT id FROM trading_manager_runs')).toHaveLength(0)
    expect(
      await query("SELECT id FROM budget_reservations WHERE category='trading_manager'"),
    ).toHaveLength(0)
    expect((await query('SELECT last_error FROM trading_manager'))[0]!.last_error).toBe(
      'MANAGER_NO_PAPER',
    )
  })

  it('distinguishes an in-flight paid call from uncertain or abandoned expenses', async () => {
    await controlManager('enable')
    const runId = randomUUID(),
      reservationId = randomUUID(),
      callId = randomUUID()
    await query(
      "INSERT INTO budget_reservations(id,dedupe_key,category,limit_kopecks,spent_kopecks) VALUES($1,$2,'trading_manager',500,321)",
      [reservationId, `trading-manager:${runId}`],
    )
    await query(
      "INSERT INTO trading_manager_runs(id,status,reservation_id,provider,model,is_demo) VALUES($1,'running',$2,'openai','fixture',false)",
      [runId, reservationId],
    )
    await query(
      "INSERT INTO tool_calls(id,call_key,reservation_id,role,status,reserved_kopecks,charged_kopecks,is_demo,provider,model) VALUES($1,$2,$3,'Торговый менеджер','pending',321,321,false,'openai','fixture')",
      [callId, `trading-manager:${runId}:plan`, reservationId],
    )
    await query(
      "UPDATE trading_manager SET lease_id=$1,lease_until=now()+interval '22 minutes',attempted_at=now(),requested_at=NULL",
      [runId],
    )
    expect(await managerBudget()).toMatchObject({
      runs: 1,
      spent: 321,
      reserved: 179,
      uncertain: false,
    })
    await expect(controlManager('review')).resolves.toBeUndefined()

    await query("UPDATE tool_calls SET status='uncertain' WHERE id=$1", [callId])
    expect((await managerBudget()).uncertain).toBe(true)
    await expect(controlManager('review')).rejects.toThrow('MANAGER_COST_REVIEW')

    await query("UPDATE tool_calls SET status='pending' WHERE id=$1", [callId])
    await query("UPDATE trading_manager SET lease_until=now()-interval '1 second'")
    expect((await managerBudget()).uncertain).toBe(true)
    await expect(controlManager('review')).rejects.toThrow('MANAGER_COST_REVIEW')

    await query('UPDATE trading_manager SET lease_id=NULL,lease_until=NULL')
    expect(await managerBudget()).toMatchObject({
      spent: 321,
      reserved: 179,
      uncertain: true,
    })
    await expect(controlManager('review')).rejects.toThrow('MANAGER_COST_REVIEW')
  })

  it.each([true, false])(
    'recovers an expired lease with provider readiness %s without losing an uncertain charge',
    async (providerReady) => {
      await controlManager('enable')
      const id = randomUUID(),
        reservationId = randomUUID(),
        callId = randomUUID()
      await query(
        "INSERT INTO budget_reservations(id,dedupe_key,category,limit_kopecks,spent_kopecks) VALUES($1,$2,'trading_manager',500,321)",
        [reservationId, `trading-manager:${id}`],
      )
      await query(
        "INSERT INTO trading_manager_runs(id,status,reservation_id,provider,model,is_demo) VALUES($1,'running',$2,'openai','fixture',false)",
        [id, reservationId],
      )
      await query(
        "INSERT INTO tool_calls(id,call_key,reservation_id,role,status,reserved_kopecks,charged_kopecks,is_demo,provider,model) VALUES($1,$2,$3,'Торговый менеджер','pending',321,321,false,'openai','fixture')",
        [callId, `trading-manager:${id}:plan`, reservationId],
      )
      await query(
        "UPDATE trading_manager SET lease_id=$1,lease_until=now()-interval '1 second',attempted_at=now()-interval '7 hours',requested_at=NULL",
        [id],
      )
      const planner = vi.fn(async () => ({ summary, tasks: [] }))
      expect(await managerTick(planner, () => false, providerReady)).toBe(false)
      expect(planner).not.toHaveBeenCalled()
      expect(
        (await query('SELECT status,error FROM trading_manager_runs WHERE id=$1', [id]))[0],
      ).toEqual({ status: 'failed', error: 'MANAGER_INTERRUPTED' })
      expect(
        (
          await query('SELECT status,spent_kopecks FROM budget_reservations WHERE id=$1', [
            reservationId,
          ])
        )[0],
      ).toEqual({ status: 'closed', spent_kopecks: 321 })
      expect(
        (await query('SELECT status,charged_kopecks FROM tool_calls WHERE id=$1', [callId]))[0],
      ).toEqual({ status: 'pending', charged_kopecks: 321 })
      expect(await managerBudget()).toMatchObject({
        spent: 321,
        reserved: 0,
        uncertain: true,
        runs: 1,
      })
      await expect(controlManager('review')).rejects.toThrow('MANAGER_COST_REVIEW')
    },
  )

  it('enforces the manual cooldown, scheduled interval and four-run daily limit across enable toggles', async () => {
    await controlManager('enable')
    const planner = vi.fn(async () => ({ summary, tasks: [] }))
    expect(await managerTick(planner)).toBe(true)
    await expect(controlManager('review')).rejects.toThrow('MANAGER_COOLDOWN')
    expect(await managerTick(planner)).toBe(false)
    await query("UPDATE trading_manager SET attempted_at=now()-interval '6 hours 1 second'")
    expect(await managerTick(planner)).toBe(true)
    for (let i = 2; i < P.maxDailyRuns; i++) {
      await query("UPDATE trading_manager SET attempted_at=now()-interval '31 minutes'")
      await controlManager('review')
      expect(await managerTick(planner)).toBe(true)
    }
    await query("UPDATE trading_manager SET attempted_at=now()-interval '7 hours'")
    await expect(controlManager('review')).rejects.toThrow('MANAGER_DAILY_LIMIT')
    await controlManager('pause')
    await controlManager('enable')
    expect(await managerTick(planner)).toBe(false)
    expect(planner).toHaveBeenCalledTimes(P.maxDailyRuns)
    expect((await managerBudget()).runs).toBe(P.maxDailyRuns)
  })

  async function withPaidProvider(fn: () => Promise<void>) {
    const c = config()
    const saved = c.MODEL_PROVIDER
    c.MODEL_PROVIDER = 'openai'
    try {
      await fn()
    } finally {
      c.MODEL_PROVIDER = saved
    }
  }

  it('releases demo-review slots for a paid model and then plans normally', async () => {
    await controlManager('enable')
    expect(await managerTick()).toBe(true)
    const [demoTask] = await query('SELECT id,status FROM trading_manager_tasks')
    expect(demoTask!.status).toBe('queued')
    await withPaidProvider(async () => {
      await query("UPDATE trading_manager SET attempted_at=now()-interval '7 hours'")
      const planner = vi.fn(async (snapshot: ManagerSnapshot) => plan(snapshot))
      expect(await managerTick(planner)).toBe(true)
      expect(planner).toHaveBeenCalledTimes(1)
    })
    expect(await taskById(demoTask!.id)).toMatchObject({
      status: 'expired',
      reason: 'MANAGER_DEMO_RELEASED',
    })
    const active = await query(
      `SELECT r.is_demo FROM trading_manager_tasks t JOIN trading_manager_runs r ON r.id=t.run_id
      WHERE t.status IN ('queued','observing')`,
    )
    expect(active).toEqual([{ is_demo: false }])
  })

  it('skips a paid review without a model call when no slot is free or paper is paused', async () => {
    await controlManager('enable')
    await withPaidProvider(async () => {
      const planner = vi.fn(async (snapshot: ManagerSnapshot) => plan(snapshot))
      expect(await managerTick(planner)).toBe(true)
      expect(planner).toHaveBeenCalledTimes(1)
      // The okx slot now holds a real experiment; no other paper portfolio is running.
      await query("UPDATE trading_manager SET attempted_at=now()-interval '7 hours'")
      expect(await managerTick(planner)).toBe(false)
      expect((await query('SELECT last_error FROM trading_manager'))[0]!.last_error).toBe(
        'MANAGER_SKIP_NO_SLOTS',
      )
      await query("UPDATE trading_manager_tasks SET status='expired',reason='MANAGER_TASK_EXPIRED'")
      await query(
        "UPDATE trading_portfolios SET status='paused',reason='DAILY_LOSS_LIMIT' WHERE mode='paper'",
      )
      expect(await managerTick(planner)).toBe(false)
      expect(await managerTick(planner)).toBe(false)
      expect((await query('SELECT last_error FROM trading_manager'))[0]!.last_error).toBe(
        'MANAGER_SKIP_PAPER_PAUSED',
      )
      expect(planner).toHaveBeenCalledTimes(1)
    })
    expect(await query('SELECT id FROM trading_manager_runs')).toHaveLength(1)
    expect(
      await query("SELECT id FROM budget_reservations WHERE category='trading_manager'"),
    ).toHaveLength(1)
    expect(
      await query(
        "SELECT data->>'reason' AS reason FROM audit_events WHERE kind='trading_manager_skipped' ORDER BY created_at",
      ),
    ).toEqual([{ reason: 'MANAGER_SKIP_NO_SLOTS' }, { reason: 'MANAGER_SKIP_PAPER_PAUSED' }])
  })

  it('runs the normal demo provider through the metered model path and labels its output honestly', async () => {
    await controlManager('enable')
    expect(await managerTick()).toBe(true)
    const [run] = await query('SELECT * FROM trading_manager_runs')
    expect(run).toMatchObject({ status: 'completed', is_demo: true, provider: 'demo' })
    expect(run!.plan.summary).toContain('не получен от LLM')
    const calls = await query(
      'SELECT is_demo,status,charged_kopecks FROM tool_calls WHERE reservation_id=$1',
      [run!.reservation_id],
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ is_demo: true, status: 'done', charged_kopecks: 0 })
    expect(await query('SELECT id FROM trading_manager_tasks')).toHaveLength(1)
  })
})
