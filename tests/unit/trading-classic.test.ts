import { describe, expect, it } from 'vitest'
import { CLASSIC_POLICY as C } from '../../core/policy'
import { applyFill, paperFill } from '../../core/trading/accounting'
import { classicPlan, classicState, settleClassic } from '../../core/trading/classic'
import { cost, fee, units } from '../../core/trading/decimal'
import { signal, sizeOrder } from '../../core/trading/strategy'
import type { AgentRow, Market } from '../../core/trading/types'
import { agent, market } from '../fixtures/trading'

function execute(a: AgentRow, m: Market, now = Date.now()) {
  const decision = signal(a, m, false, now)
  if (!decision.side) throw new Error(decision.reason)
  const order = sizeOrder(a, m, decision.side, 'classic-test', decision.maxQty)!
  const result = paperFill(order, m.book, m.instrument.lot)
  const state = settleClassic(a, result, now)
  const balances = applyFill(a, result, m.instrument.minQty)
  return {
    order,
    result,
    agent: {
      ...a,
      cash: balances.cash.toString(),
      base: balances.base.toString(),
      basis: balances.basis.toString(),
      fees: balances.fees.toString(),
      realized: balances.realized.toString(),
      round_trips: balances.roundTrips,
      strategy_state: JSON.parse(JSON.stringify(state)),
    } satisfies AgentRow,
  }
}

describe('bounded grid and DCA experiments', () => {
  it('allocates equal fee-reserved legs inside half the original capital', () => {
    for (const [capital, steps, budget] of [
      ['25', 2, '6.25'],
      ['20', 1, '10'],
      ['100', 3, '10'],
      ['9', 0, '0'],
    ] as const) {
      const a = agent({
        kind: 'dca',
        initial_cash: units(capital).toString(),
        cash: units(capital).toString(),
      })
      const plan = classicPlan(a)
      expect(plan.steps).toBe(steps)
      expect(plan.budget).toBe(units(budget))
      expect(plan.budget * BigInt(steps)).toBeLessThanOrEqual(plan.ceiling)
      if (steps) {
        const order = sizeOrder(a, market(), 'buy', 'budget')!
        const value = cost(order.qty, order.price)
        expect(value + fee(value, 25)).toBeLessThanOrEqual(plan.budget)
        expect(value).toBeGreaterThanOrEqual(units('5'))
      }
    }
  })

  it('buys DCA on the persisted clock without increasing the order after a price change', () => {
    const now = Date.now()
    const first = execute(agent({ kind: 'dca' }), market(), now)
    expect(signal(first.agent, market(), false, now + C.dcaIntervalMs - 1).side).toBeNull()
    const second = execute(first.agent, market('BTC-USDT', '100.5'), now + C.dcaIntervalMs)
    expect(second.order.qty).toBeLessThan(first.order.qty)
    expect(classicState(second.agent).entries).toBe(2)
    expect(
      signal(second.agent, market('BTC-USDT', '100.5'), false, now + C.dcaIntervalMs * 3).side,
    ).toBeNull()
  })

  it('opens at most three DCA legs even when there is unused capital', () => {
    let a = agent({
      kind: 'dca',
      initial_cash: units('100').toString(),
      cash: units('100').toString(),
    })
    const now = Date.now()
    for (let i = 0; i < C.maxEntries; i++) a = execute(a, market(), now + i * C.dcaIntervalMs).agent
    expect(classicState(a).entries).toBe(3)
    expect(signal(a, market(), false, now + C.dcaIntervalMs * 100).side).toBeNull()
  })

  it('opens a lower grid step and closes only its lot on a fee-covered rebound', () => {
    const a = agent({ kind: 'grid', params: { lookback: 60, entryBps: 100, takeProfitBps: 150 } })
    const first = execute(a, market())
    expect(signal(first.agent, market('BTC-USDT', '99.5')).side).toBeNull()
    const second = execute(first.agent, market('BTC-USDT', '98.5'))
    expect(classicState(second.agent).tranches).toHaveLength(2)
    const before = classicState(second.agent).tranches[0]!
    expect(signal(second.agent, market('BTC-USDT', '99.5')).side).toBeNull()
    expect(signal(second.agent, market('BTC-USDT', '100.15')).reason).toBe('GRID_TAKE_PROFIT')
    const exit = execute(second.agent, market('BTC-USDT', '100.15'))
    expect(classicState(exit.agent).tranches).toEqual([before])
    expect(BigInt(exit.agent.base)).toBe(BigInt(before.qty))
    // Selling the newest lot does not switch the accounting ledger away from average cost.
    expect(BigInt(exit.agent.basis)).not.toBe(BigInt(before.cost))
    expect(BigInt(exit.agent.cash) + BigInt(exit.agent.basis) - BigInt(exit.agent.realized)).toBe(
      units('25'),
    )
    expect(exit.agent.round_trips).toBe(0)
    expect(signal(exit.agent, market('BTC-USDT', '98.5')).reason).toBe('GRID_NEXT_LEVEL')
    const replenished = execute(exit.agent, market('BTC-USDT', '98.5')).agent
    const plan = classicPlan(replenished)
    expect(
      classicState(replenished).tranches.reduce((sum, lot) => sum + BigInt(lot.cost), 0n),
    ).toBeLessThanOrEqual(plan.ceiling)
    expect(plan.budget).toBe(units('6.25'))
    expect(
      BigInt(replenished.cash) + BigInt(replenished.basis) - BigInt(replenished.realized),
    ).toBe(units('25'))
  })

  it('keeps a partial lot exact and never consumes a step for an unfilled IOC', () => {
    const a = agent({ kind: 'grid' }),
      m = market()
    const order = sizeOrder(a, m, 'buy', 'partial')!
    m.book.asks[0]![1] = order.qty / 2n
    const fill = paperFill(order, m.book, m.instrument.lot)
    const state = settleClassic(a, fill)
    expect(state.entries).toBe(1)
    expect(state.tranches[0]!.qty).toBe(fill.filledQty.toString())
    expect(settleClassic(a, { ...fill, filledQty: 0n, quote: 0n, quoteFee: 0n }).entries).toBe(0)
  })

  it('does not propose a grid lot below the exchange sale minimum', () => {
    const a = agent({ kind: 'grid', params: { lookback: 60, entryBps: 100, takeProfitBps: 150 } })
    const first = execute(a, market())
    const thin = market('BTC-USDT', '98.5')
    thin.book.asks[0]![1] = units('0.03')
    const second = execute(first.agent, thin)
    const rebound = market('BTC-USDT', '100.15')
    rebound.instrument.minNotional = units('5')
    expect(signal(second.agent, rebound)).toEqual({ side: null, reason: 'GRID_LOT_BELOW_MINIMUM' })
    expect(sizeOrder(second.agent, rebound, 'sell', 'full')).not.toBeNull()
    expect(signal(second.agent, rebound, true)).toEqual({ side: 'sell', reason: 'RISK_EXIT' })
    rebound.instrument.minNotional = 0n
    rebound.instrument.minQty = units('0.04')
    expect(signal(second.agent, rebound).reason).toBe('GRID_LOT_BELOW_MINIMUM')
  })

  it('prioritizes portfolio and position stops over another scheduled purchase', () => {
    for (const kind of ['grid', 'dca'] as const) {
      const a = execute(agent({ kind }), market()).agent
      expect(signal(a, market('BTC-USDT', '95'), false, Date.now() + C.dcaIntervalMs).reason).toBe(
        'POSITION_STOP',
      )
      expect(signal(a, market(), true).reason).toBe('RISK_EXIT')
      expect(signal({ ...a, mode: 'live' }, market()).reason).toBe('CLASSIC_PAPER_ONLY')
    }
  })

  it('resets the cycle only after the entire position is accounted for', () => {
    const a = execute(agent({ kind: 'dca' }), market()).agent
    const closed = execute(a, market('BTC-USDT', '104')).agent
    expect(classicState(closed)).toEqual({ entries: 0, lastEntryAt: null, tranches: [] })
    expect(closed.base).toBe('0')
    expect(closed.round_trips).toBe(1)
    expect(signal(closed, market()).reason).toBe('DCA_SCHEDULED_ENTRY')
  })

  it('rejects a missing or inconsistent state instead of resetting a held cycle', () => {
    const a = execute(agent({ kind: 'dca' }), market()).agent
    expect(() => signal({ ...a, strategy_state: {} }, market())).toThrow(
      'TRADING_STRATEGY_STATE_INVALID',
    )
  })
})
