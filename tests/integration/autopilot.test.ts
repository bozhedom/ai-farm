import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The autopilot reads the server switches once per process, like the worker.
const saved = vi.hoisted(() => {
  const keys = ['AUTONOMY_ENABLED', 'BYBIT_DEMO_API_KEY', 'BYBIT_DEMO_SECRET']
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.AUTONOMY_ENABLED = 'true'
  process.env.BYBIT_DEMO_API_KEY = 'test-demo-key'
  process.env.BYBIT_DEMO_SECRET = 'test-demo-secret'
  return before
})

import { pool, query } from '../../core/db'
import { runAutopilot, autonomyView } from '../../core/autopilot'
import { setSchedule } from '../../core/autonomy'
import { controlManager, ensureManager } from '../../core/manager/runtime'
import { controlTrading } from '../../core/trading/engine'
import { controlExecution, type ExecutionFactory } from '../../core/execution/engine'
import { ensurePortfolios, scope } from '../../core/trading/store'
import { ensureExecution } from '../../core/execution/store'
import { listing } from '../../core/trading/universe'
import { units } from '../../core/trading/decimal'
import { loopFinished, loopStarted, workerLoops } from '../../core/worker-loops'
import type { Account, TradingSymbol, TradingVenue } from '../../core/trading/types'
import { market } from '../fixtures/trading'
import { applyMigrations, resetDatabase } from './helpers/db'

/** A quiet exchange: listings, prices and a funded account, no orders. */
const venue: TradingVenue = {
  async discover() {
    return (['BTC-USDT', 'ETH-USDT'] as TradingSymbol[]).flatMap((symbol) =>
      listing(
        symbol.slice(0, -5),
        'USDT',
        symbol,
        { active: true },
        {
          at: Date.now(),
          bid: '99.99',
          ask: '100',
          last: '100',
          open: '102',
          high: '105',
          low: '98',
          turnover: '10000000',
        },
      ),
    )
  },
  async market(symbol: TradingSymbol) {
    const m = market(symbol, '100', '102')
    for (let i = 0; i < 30; i++) m.candles[i]!.close = (units('102') * 102n) / 100n
    return m
  },
  async account(symbols: readonly TradingSymbol[]): Promise<Account> {
    return {
      identity: 'autopilot-demo-account',
      balances: {
        USDT: { total: units('100'), available: units('100') },
        BTC: { total: 0n, available: 0n },
        ETH: { total: 0n, available: 0n },
      },
      feeBps: Object.fromEntries(symbols.map((s) => [s, 10])),
    }
  },
  async pending() {
    return []
  },
  async place() {
    throw new Error('TRADING_UNEXPECTED_ORDER')
  },
  async order() {
    return null
  },
  async cancel() {},
}
const execution: ExecutionFactory = (p) =>
  ({
    async accounts() {
      return [{ identity: `autopilot:${p.track}:${p.mode}`, venue: 'paper' }]
    },
  }) as never
const deps = { trading: () => venue, execution }

async function statuses() {
  const trading = await query(
    'SELECT exchange,mode,status,reason,capital FROM trading_portfolios ORDER BY exchange,mode',
  )
  const books = await query(
    'SELECT track,mode,status,capital::text,started_at FROM execution_portfolios ORDER BY track,mode',
  )
  const [system] = await query('SELECT mode,schedule_enabled FROM system_state WHERE id=true')
  const [manager] = await query('SELECT enabled FROM trading_manager WHERE id=true')
  return { trading, books, system, manager }
}
const status = (rows: any[], a: string, mode: string) =>
  rows.find((r) => (r.exchange ?? r.track) === a && r.mode === mode)

beforeAll(applyMigrations)
beforeEach(async () => {
  await resetDatabase()
  await ensurePortfolios()
  await ensureExecution()
  await ensureManager()
  await query('UPDATE system_state SET schedule_enabled=false')
})
afterAll(async () => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  await pool.end()
})

describe('server autopilot', () => {
  it('starts what never ran, with Demo only where keys exist, and never touches Live', async () => {
    const live = (await statuses()).trading.filter((t) => t.mode === 'live')
    const decisions = await runAutopilot(undefined, deps)
    const s = await statuses()
    expect(s.system).toMatchObject({ mode: 'running', schedule_enabled: true })
    expect(s.manager.enabled).toBe(true)
    for (const exchange of ['okx', 'bybit', 'binance', 'bitget'])
      expect(status(s.trading, exchange, 'paper').status).toBe('running')
    expect(status(s.trading, 'bybit', 'demo').status).toBe('running')
    expect(status(s.trading, 'okx', 'demo').status).toBe('idle')
    expect(s.trading.filter((t) => t.mode === 'live')).toEqual(live)
    for (const track of ['arbitrage', 'funding', 'defi'])
      expect(status(s.books, track, 'paper')).toMatchObject({ status: 'running' })
    expect(Number(status(s.books, 'defi', 'paper').capital)).toBe(100)
    expect(status(s.books, 'prediction', 'paper').status).toBe('idle')
    for (const book of s.books.filter((b) => b.mode !== 'paper'))
      expect(book).toMatchObject({ status: 'idle', capital: '0.000000000000000000' })
    expect(decisions.find((d) => d.key === 'live')?.status).toBe('blocked')

    // Actions and blockers reach the activity feed once; running lines and repeats add nothing.
    const feed = async () =>
      (
        await query("SELECT message FROM audit_events WHERE kind='autopilot_decision' ORDER BY id")
      ).map((row) => row.message as string)
    const first = await feed()
    expect(first).toContain('Тренировка Bybit: запущена автопилотом.')
    expect(first).toContain('Demo OKX: нет ключей Demo в настройках сервера.')
    expect(first.some((text) => text.endsWith('работает.'))).toBe(false)
    await runAutopilot(undefined, deps)
    await runAutopilot(undefined, deps)
    expect(await feed()).toEqual(first)
    const view = await autonomyView()
    expect(view.decisions.length).toBe(decisions.length)
    expect(view.checkedAt).not.toBeNull()
  })

  it('changes nothing while the farm is paused or in an emergency stop', async () => {
    for (const mode of ['paused', 'emergency_stop']) {
      await query('UPDATE system_state SET mode=$1', [mode])
      const before = await statuses()
      const decisions = await runAutopilot(undefined, deps)
      expect(await statuses()).toEqual(before)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]!.status).toBe('blocked')
      expect((await statuses()).system.mode).toBe(mode)
    }
  })

  it('keeps what the owner switched off, paused or stopped', async () => {
    await setSchedule(false)
    await controlManager('pause')
    await controlTrading(scope('okx', 'paper'), 'pause')
    await controlTrading(scope('bybit', 'demo'), 'stop')
    await controlExecution('arbitrage', 'paper', 'pause')
    await runAutopilot(undefined, deps)
    const s = await statuses()
    expect(s.system.schedule_enabled).toBe(false)
    expect(s.manager.enabled).toBe(false)
    expect(status(s.trading, 'okx', 'paper')).toMatchObject({
      status: 'paused',
      reason: 'OWNER_PAUSE',
    })
    expect(status(s.trading, 'bybit', 'demo')).toMatchObject({
      status: 'stopped',
      reason: 'OWNER_STOP',
    })
    expect(status(s.books, 'arbitrage', 'paper').status).toBe('paused')
    expect(status(s.trading, 'bitget', 'paper').status).toBe('running')
    expect(status(s.books, 'funding', 'paper').status).toBe('running')
    // A risk stop is not cleared either.
    await query(
      "UPDATE trading_portfolios SET status='paused',reason='DAILY_LOSS_LIMIT' WHERE exchange='bitget' AND mode='paper'",
    )
    await runAutopilot(undefined, deps)
    expect(status((await statuses()).trading, 'bitget', 'paper').reason).toBe('DAILY_LOSS_LIMIT')
  })

  it('cannot be used to switch anything off', async () => {
    await expect(setSchedule(false, 'autopilot')).rejects.toThrow('AUTOPILOT_CANNOT_DISABLE')
    await expect(controlManager('pause', 'autopilot')).rejects.toThrow('AUTOPILOT_CANNOT_DISABLE')
  })

  it('records a heartbeat per worker loop', async () => {
    await loopStarted('payments')
    await loopFinished('payments')
    await loopStarted('earnings')
    await loopFinished('earnings', new Error('EARNINGS_SOURCE_DOWN'))
    await loopFinished('manager', new Error('secret https://example.com/key'))
    const loops = await workerLoops()
    expect(loops.find((l) => l.name === 'payments')?.state).toBe('ok')
    expect(loops.find((l) => l.name === 'earnings')).toMatchObject({
      state: 'failing',
      error: 'EARNINGS_SOURCE_DOWN',
      consecutiveFailures: 1,
    })
    expect(loops.find((l) => l.name === 'manager')?.error).toBe('LOOP_FAILED')
    await loopFinished('earnings')
    expect((await workerLoops()).find((l) => l.name === 'earnings')?.state).toBe('ok')
  })
})
