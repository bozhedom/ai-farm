import { config } from '../config'
import { BYBIT_SHORT_CYCLE_POLICY as C, TRADING_POLICY as P } from '../policy'
import { BPS, fee, proceeds } from './decimal'
import { isClassic, type TradingSignal } from './classic'
import type { AgentRow, Market, TradingScope } from './types'

export function shortCycle(s: TradingScope) {
  return s.exchange === 'bybit' && config().BYBIT_SHORT_CYCLE_ENABLED ? C : null
}

export function orderLimit(s: TradingScope, ownerLimit: number | null) {
  const ceiling = shortCycle(s)?.maxOrdersPerDay ?? P.maxOrdersPerDay
  return Math.min(ceiling, ownerLimit ?? ceiling)
}

/** Timed exits may realize a loss. Never manufacture an entry without a strategy signal. */
export function shortCycleSignal(
  a: AgentRow,
  m: Market,
  original: TradingSignal,
  now = Date.now(),
  ownerTarget: number | null = null,
): TradingSignal {
  const profile = shortCycle(a)
  if (!profile || isClassic(a.kind) || a.residual_only || BigInt(a.base) < m.instrument.minQty)
    return original
  if (original.side === 'sell' && original.reason !== 'TAKE_PROFIT') return original
  if (a.position_opened_at && now - a.position_opened_at.getTime() >= profile.maxHoldingMs)
    return { side: 'sell', reason: 'BYBIT_SHORT_TIME_EXIT' }
  // Reserve the full exit fee AND IOC slippage; entry fees already belong to the basis.
  const value = proceeds(BigInt(a.base), m.book.bids[0]![0])
  const net = value - fee(value, P.slippageBps) - fee(value, P.maxFeeBps)
  if (
    net * BPS >=
    BigInt(a.basis) *
      (BPS + BigInt(ownerTarget ?? Math.min(a.params.takeProfitBps, profile.takeProfitBps)))
  )
    return { side: 'sell', reason: 'BYBIT_SHORT_TAKE_PROFIT' }
  return original.reason === 'TAKE_PROFIT' ? { side: null, reason: 'HOLDING_POSITION' } : original
}

export function orderCooldown(a: AgentRow, side: 'buy' | 'sell') {
  const profile = shortCycle(a)
  return profile && !isClassic(a.kind)
    ? side === 'sell'
      ? 0
      : profile.entryCooldownMs
    : P.cooldownMs
}
