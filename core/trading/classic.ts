import { z } from 'zod'
import { CLASSIC_POLICY as C, TRADING_POLICY as P } from '../policy'
import { BPS, SCALE, fee, floorStep, min, proceeds, units } from './decimal'
import type { AgentRow, Market, OrderResult, StrategyKind } from './types'

const integer = z.string().regex(/^\d+$/).max(60)
const stateSchema = z
  .object({
    entries: z.number().int().min(0).max(C.maxEntries),
    lastEntryAt: z.number().int().nonnegative().nullable(),
    // Entry references for grid signals, not a second P&L ledger. applyFill keeps weighted-average basis.
    tranches: z
      .array(z.object({ qty: integer, cost: integer, price: integer }).strict())
      .max(C.maxEntries),
  })
  .strict()
export type ClassicState = z.infer<typeof stateSchema>
export type TradingSignal = { side: 'buy' | 'sell' | null; reason: string; maxQty?: bigint }
export const isClassic = (kind: StrategyKind) => kind === 'grid' || kind === 'dca'

export function classicState(agent: AgentRow): ClassicState {
  const raw = agent.strategy_state
  const state = stateSchema.parse(
    raw && typeof raw === 'object' && Object.keys(raw).length
      ? raw
      : { entries: 0, lastEntryAt: null, tranches: [] },
  )
  if (
    state.tranches.reduce((sum, lot) => sum + BigInt(lot.qty), 0n) !== BigInt(agent.base) ||
    state.tranches.some((lot) => !BigInt(lot.qty) || !BigInt(lot.cost) || !BigInt(lot.price))
  )
    throw new Error('TRADING_STRATEGY_STATE_INVALID')
  return state
}

/** Equal, fee-reserved portions of at most half of the agent's initial cash. No martingale. */
export function classicPlan(agent: AgentRow) {
  const ceiling = (BigInt(agent.initial_cash) * BigInt(P.maxExposureBps)) / BPS
  const minimum = units(String(P.minOrderUsdt)) + fee(units(String(P.minOrderUsdt)), P.maxFeeBps)
  const steps = Number(min(BigInt(C.maxEntries), ceiling / minimum))
  return {
    ceiling,
    steps,
    budget: steps ? min(units(String(P.orderUsdt)), ceiling / BigInt(steps)) : 0n,
  }
}

export function classicSignal(agent: AgentRow, market: Market, now: number): TradingSignal {
  if (agent.mode !== 'paper') return { side: null, reason: 'CLASSIC_PAPER_ONLY' }
  const state = classicState(agent)
  const plan = classicPlan(agent)
  const ask = market.book.asks[0]![0]
  const last = state.tranches.at(-1)
  if (agent.kind === 'grid' && last) {
    const gross = proceeds(
      BigInt(last.qty),
      (market.book.bids[0]![0] * (BPS - BigInt(P.slippageBps))) / BPS,
    )
    // Both the entry cost and a conservative exit fee must be covered by this grid lot.
    const net = gross - fee(gross, P.maxFeeBps)
    if (net * BPS >= BigInt(last.cost) * (BPS + BigInt(agent.params.entryBps))) {
      const qty = floorStep(BigInt(last.qty), market.instrument.lot)
      if (
        qty < market.instrument.minQty ||
        proceeds(qty, (market.book.bids[0]![0] * (BPS - BigInt(P.slippageBps))) / BPS) <
          (market.instrument.minNotional || 0n)
      )
        return { side: null, reason: 'GRID_LOT_BELOW_MINIMUM' }
      return { side: 'sell', reason: 'GRID_TAKE_PROFIT', maxQty: BigInt(last.qty) }
    }
  }
  const used = agent.kind === 'grid' ? state.tranches.length : state.entries
  if (
    !plan.steps ||
    used >= plan.steps ||
    BigInt(agent.cash) < plan.budget ||
    BigInt(agent.basis) + plan.budget > plan.ceiling
  )
    return {
      side: null,
      reason: BigInt(agent.base) ? 'HOLDING_POSITION' : 'CLASSIC_CAPITAL_TOO_SMALL',
    }
  if (agent.kind === 'dca') {
    if (state.lastEntryAt !== null && now - state.lastEntryAt < C.dcaIntervalMs)
      return { side: null, reason: 'HOLDING_POSITION' }
    return { side: 'buy', reason: 'DCA_SCHEDULED_ENTRY' }
  }
  if (last) {
    return ask * BPS <= BigInt(last.price) * (BPS - BigInt(agent.params.entryBps))
      ? { side: 'buy', reason: 'GRID_NEXT_LEVEL' }
      : { side: null, reason: 'HOLDING_POSITION' }
  }
  const candles = market.candles.slice(-agent.params.lookback)
  const mean = candles.reduce((sum, c) => sum + c.close, 0n) / BigInt(candles.length)
  return ask * BPS <= mean * (BPS - BigInt(agent.params.entryBps))
    ? { side: 'buy', reason: 'GRID_FIRST_LEVEL' }
    : { side: null, reason: 'WAITING_SIGNAL' }
}

/** Updated in the same transaction as balances. Canceled/unfilled orders consume no step. */
export function settleClassic(
  agent: AgentRow,
  result: OrderResult,
  now = Date.now(),
): ClassicState {
  const previous = classicState(agent)
  const state = { ...previous, tranches: previous.tranches.map((lot) => ({ ...lot })) }
  if (!result.filledQty) return state
  if (result.side === 'buy') {
    const plan = classicPlan(agent)
    if (
      state.tranches.length >= plan.steps ||
      (agent.kind === 'dca' && state.entries >= plan.steps)
    )
      throw new Error('TRADING_STRATEGY_STATE_INVALID')
    const qty = result.filledQty + result.baseFee
    state.tranches.push({
      qty: qty.toString(),
      cost: (result.quote - result.quoteFee).toString(),
      price: ((result.quote * SCALE) / result.filledQty).toString(),
    })
    // Grid steps may be replenished after selling; the count is a bound on held lots there.
    state.entries = agent.kind === 'grid' ? state.tranches.length : state.entries + 1
    state.lastEntryAt = now
  } else {
    let removed = result.filledQty - result.baseFee
    while (removed && state.tranches.length) {
      const lot = state.tranches.at(-1)!
      const qty = BigInt(lot.qty),
        take = min(qty, removed)
      lot.qty = (qty - take).toString()
      lot.cost = (BigInt(lot.cost) - (BigInt(lot.cost) * take) / qty).toString()
      removed -= take
      if (take === qty) state.tranches.pop()
    }
    if (removed) throw new Error('TRADING_STRATEGY_STATE_INVALID')
    if (!state.tranches.length) return { entries: 0, lastEntryAt: null, tranches: [] }
    if (agent.kind === 'grid') state.entries = state.tranches.length
  }
  return stateSchema.parse(state)
}
