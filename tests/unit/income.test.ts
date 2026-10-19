import { describe, expect, it } from 'vitest'
import {
  addExecution,
  dayKeys,
  directionStatus,
  emptyBucket,
  headlineMode,
  periodStart,
  periodTotals,
  replayTrades,
  totals,
  winStats,
  type DayBucket,
  type Fill,
} from '../../core/income/math'
import { applyFill } from '../../core/trading/accounting'
import { SCALE, units } from '../../core/trading/decimal'
import type { AgentRow } from '../../core/trading/types'

const at = (s: string) => new Date(s)
const fill = (
  side: 'buy' | 'sell',
  qty: string,
  quote: string,
  quoteFee = '0',
  when = '2026-10-20T10:00:00Z',
): Fill => ({
  agentId: 'a',
  exchange: 'bybit',
  mode: 'paper',
  side,
  filledQty: units(qty),
  quote: units(quote),
  baseFee: 0n,
  quoteFee: -units(quoteFee),
  at: at(when),
})

describe('income periods', () => {
  it('lists the last 30 UTC days ending today', () => {
    const days = dayKeys(at('2026-10-20T23:59:00Z'))
    expect(days).toHaveLength(30)
    expect(days[0]).toBe('2026-09-21')
    expect(days.at(-1)).toBe('2026-10-20')
    expect(periodStart(at('2026-10-20T01:00:00Z'), 'today')).toBe('2026-10-20')
    expect(periodStart(at('2026-10-20T01:00:00Z'), 'week')).toBe('2026-10-14')
  })

  it('keeps real money, test money and spend apart; net is rubles only', () => {
    const now = at('2026-10-20T12:00:00Z')
    const today = emptyBucket()
    today.realKopecks = 49000
    today.testKopecks = 29000
    today.spendKopecks = 1250
    today.trading.live = units('3.5')
    today.trading.paper = units('100')
    addExecution(today, 'live', 'USDC', units('0.25'))
    addExecution(today, 'paper', 'USDT', units('7'))
    addExecution(today, 'demo', 'USDT', units('-2'))
    const old = emptyBucket()
    old.realKopecks = 10000
    old.spendKopecks = 50000
    old.trading.demo = units('-1.25')
    const byDay = new Map<string, DayBucket>([
      ['2026-10-20', today],
      ['2026-10-15', old],
    ])
    const t = periodTotals(byDay, now, 'today')
    expect(t).toEqual({
      realOrdersKopecks: 49000,
      liveTradingUsdt: '3.5',
      liveExecution: [{ currency: 'USDC', amount: '0.25' }],
      testPaymentsKopecks: 29000,
      paperTradingUsdt: '100',
      demoTradingUsdt: '0',
      testExecution: [{ currency: 'USDT', amount: '5' }],
      spendKopecks: 1250,
      netKopecks: 47750,
    })
    const w = periodTotals(byDay, now, 'week')
    expect(w.realOrdersKopecks).toBe(59000)
    expect(w.spendKopecks).toBe(51250)
    expect(w.netKopecks).toBe(-(51250 - 59000))
    expect(w.demoTradingUsdt).toBe('-1.25')
    // Test payments never leak into the real or net figures.
    expect(totals([{ ...emptyBucket(), testKopecks: 99900 }]).netKopecks).toBe(0)
  })
})

describe('trade replay', () => {
  it('matches the engine accounting for realized results and wins', () => {
    const fills = [
      fill('buy', '0.002', '100', '0.1'),
      fill('sell', '0.001', '55', '0.055'),
      fill('sell', '0.001', '48', '0.048'),
    ]
    const trades = replayTrades(fills)
    expect(trades.map((t) => t.realized)).toEqual([units('4.895'), units('-2.098')])
    expect(winStats(trades)).toEqual({ trades: 2, wins: 1 })

    // Same fills through the engine rule: the sum equals the agent's realized total.
    let agent = {
      cash: (1000n * SCALE).toString(),
      base: '0',
      basis: '0',
      realized: '0',
      fees: '0',
      round_trips: 0,
    } as unknown as AgentRow
    for (const f of fills) {
      const next = applyFill(
        agent,
        {
          clientId: 'x',
          side: f.side,
          qty: f.filledQty,
          price: f.side === 'buy' ? units('60000') : units('40000'),
          exchangeId: 'p',
          state: 'filled',
          filledQty: f.filledQty,
          quote: f.quote,
          baseFee: f.baseFee,
          quoteFee: f.quoteFee,
        } as never,
        0n,
      )
      agent = {
        ...agent,
        cash: next.cash.toString(),
        base: next.base.toString(),
        basis: next.basis.toString(),
        realized: next.realized.toString(),
        fees: next.fees.toString(),
      }
    }
    expect(BigInt(agent.realized)).toBe(trades.reduce((s, t) => s + t.realized!, 0n))
  })

  it('does not guess when a sell exceeds the replayed position', () => {
    const trades = replayTrades([
      fill('sell', '1', '10'),
      fill('buy', '1', '10'),
      fill('sell', '1', '12'),
    ])
    expect(trades.map((t) => t.realized)).toEqual([null, null])
    expect(winStats(trades)).toEqual({ trades: 2, wins: 0 })
  })
})

describe('direction status', () => {
  it('prefers live once activated, then an active demo, then paper', () => {
    expect(
      headlineMode([
        { mode: 'paper', status: 'running' },
        { mode: 'demo', status: 'running' },
        { mode: 'live', status: 'idle' },
      ]),
    ).toBe('demo')
    expect(
      headlineMode([
        { mode: 'paper', status: 'running' },
        { mode: 'live', status: 'stopped', started: true },
      ]),
    ).toBe('live')
    expect(headlineMode([{ mode: 'paper', status: 'idle' }])).toBe('paper')
  })

  it('maps portfolio state to the owner status', () => {
    expect(directionStatus({ status: 'running', workerAlive: true, problem: false })).toBe(
      'autonomous',
    )
    expect(directionStatus({ status: 'running', workerAlive: false, problem: false })).toBe(
      'needs_human',
    )
    expect(directionStatus({ status: 'paused', workerAlive: true, problem: true })).toBe(
      'needs_human',
    )
    expect(directionStatus({ status: 'idle', workerAlive: true, problem: false })).toBe('disabled')
  })
})
