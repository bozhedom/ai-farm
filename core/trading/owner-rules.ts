import { query, type Connection } from '../db'
import { TRADING_POLICY as P } from '../policy'
import {
  defaultTradingRules,
  tradingRulesSchema,
  type TradingRules,
  type TradingInstructionsView,
} from '../contracts/trading-instructions'
import { BPS, cost, fee, proceeds, units } from './decimal'
import type { AgentRow, Market, OrderRequest } from './types'
import type { TradingSignal } from './classic'

export function validateTradingRules(value: unknown): TradingRules {
  const r = tradingRulesSchema.parse(value)
  if (
    r.maxOrderUsdt !== null &&
    (units(r.maxOrderUsdt) < units(String(P.minOrderUsdt)) ||
      units(r.maxOrderUsdt) > units(String(P.orderUsdt)))
  )
    throw new Error('TRADING_INSTRUCTION_ORDER_LIMIT')
  if (
    (r.maxExposureBps ?? 0) > P.maxExposureBps ||
    (r.positionStopBps ?? 0) > P.positionStopBps ||
    (r.maxOrdersPerDay ?? 0) > P.maxOrdersPerDay
  )
    throw new Error('TRADING_INSTRUCTION_LIMIT')
  if (r.allowedSymbols?.some((s) => r.blockedSymbols.includes(s)))
    throw new Error('TRADING_INSTRUCTION_CONFLICT')
  return r
}

export async function tradingInstructions(
  db?: Connection,
  lock = false,
): Promise<TradingInstructionsView> {
  const [row] = await query(
    `SELECT * FROM trading_instructions WHERE id=true${lock ? ' FOR SHARE' : ''}`,
    [],
    db,
  )
  const [profile] = await query("SELECT revision FROM agent_profiles WHERE role='manager'", [], db)
  return {
    revision: row?.revision ?? 0,
    profileRevision: row?.profile_revision ?? 0,
    rules: row?.applied_at ? validateTradingRules(row.rules) : defaultTradingRules(),
    managerNotes: row?.manager_notes ?? [],
    appliedAt: row?.applied_at?.toISOString() ?? null,
    source: row?.source ?? null,
    synchronized: (profile?.revision ?? 0) === (row?.profile_revision ?? 0),
  }
}

export function ownerEntryReason(r: TradingRules, a: Pick<AgentRow, 'symbol' | 'kind'>) {
  if (r.pauseEntries) return 'OWNER_ENTRIES_PAUSED'
  if (
    r.blockedSymbols.includes(a.symbol) ||
    (r.allowedSymbols && !r.allowedSymbols.includes(a.symbol))
  )
    return 'OWNER_SYMBOL_RESTRICTED'
  if (r.allowedKinds && !r.allowedKinds.includes(a.kind)) return 'OWNER_STRATEGY_RESTRICTED'
  return ''
}

/** Existing exits stay available. Owner instructions can tighten protection, never remove it. */
export function ownerSignal(
  r: TradingRules,
  a: AgentRow,
  market: Market,
  original: TradingSignal,
  now = Date.now(),
): TradingSignal {
  const base = BigInt(a.base),
    basis = BigInt(a.basis)
  if (base >= market.instrument.minQty) {
    if (
      ['RISK_EXIT', 'POSITION_STOP', 'SCOUT_TIME_EXIT', 'SCOUT_STAGNANT_EXIT'].includes(
        original.reason,
      )
    )
      return original
    const value = proceeds(base, market.book.bids[0]![0])
    if (r.positionStopBps !== null && value * BPS <= basis * (BPS - BigInt(r.positionStopBps)))
      return { side: 'sell', reason: 'OWNER_POSITION_STOP' }
    if (
      r.maxHoldingMinutes !== null &&
      a.position_opened_at &&
      now - a.position_opened_at.getTime() >= r.maxHoldingMinutes * 60_000
    )
      return { side: 'sell', reason: 'OWNER_TIME_EXIT' }
    if (
      r.takeProfitBps !== null &&
      (value - fee(value, P.maxFeeBps)) * BPS >= basis * (BPS + BigInt(r.takeProfitBps))
    )
      return { side: 'sell', reason: 'OWNER_TAKE_PROFIT' }
  }
  if (original.side === 'buy') {
    const reason = ownerEntryReason(r, a)
    if (reason) return { side: null, reason }
  }
  return original
}

export function orderWithinOwnerLimit(r: TradingRules, request: OrderRequest) {
  return (
    request.side !== 'buy' ||
    r.maxOrderUsdt === null ||
    cost(request.qty, request.price) + fee(cost(request.qty, request.price), P.maxFeeBps) <=
      units(r.maxOrderUsdt)
  )
}
