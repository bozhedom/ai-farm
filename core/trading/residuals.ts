import { randomUUID } from 'node:crypto'
import { query, type Connection } from '../db'
import { SCOUT_POLICY as S } from '../policy'
import { proceeds, units } from './decimal'
import { sizeOrder, validateMarket } from './strategy'
import { agents, event } from './store'
import type { AgentRow, Market, TradingScope } from './types'

/** Only a small, unsellable holding can leave the trading slot; never a normal position. */
export function isResidual(a: AgentRow, market: Market | undefined) {
  if (
    a.mode !== 'live' ||
    a.residual_only ||
    BigInt(a.base) <= 0n ||
    BigInt(a.basis) <= 0n ||
    !market
  )
    return false
  validateMarket(market)
  return (
    market.instrument.symbol === a.symbol &&
    proceeds(BigInt(a.base), market.book.bids[0]![0]) <= units(String(S.maxResidualValueUsdt)) &&
    !sizeOrder(a, market, 'sell', 'residualcheck')
  )
}

/** Caller holds the portfolio lock and transaction; amounts move without a sale or write-off. */
export async function parkResidual(
  s: TradingScope,
  a: AgentRow,
  market: Market | undefined,
  db: Connection,
) {
  if (s.mode !== a.mode || s.exchange !== a.exchange || !isResidual(a, market)) return false
  const residuals = (await agents(s, db)).filter((a) => a.residual_only)
  const existing = residuals.find((r) => r.symbol === a.symbol)
  if (!existing && residuals.length >= S.maxResidualSymbols) return false
  const id = existing?.id ?? randomUUID()
  if (existing) {
    await query(
      'UPDATE trading_agents SET base=base+$2::numeric,basis=basis+$3::numeric,initial_cash=initial_cash+$3::numeric WHERE id=$1',
      [id, a.base, a.basis],
      db,
    )
  } else {
    await query(
      `INSERT INTO trading_agents(id,exchange,mode,name,symbol,kind,params,parent_id,generation,initial_cash,cash,base,basis,peak,selector_version,residual_only,position_opened_at)
      VALUES($1,$2,'live',$3,$4,$5,$6,$7,$8,$9,0,$10,$9,$9,$11,true,$12)`,
      [
        id,
        s.exchange,
        `Остаток ${a.symbol.slice(0, -5)}`,
        a.symbol,
        a.kind,
        a.params,
        a.id,
        a.generation,
        a.basis,
        a.base,
        a.selector_version,
        a.position_opened_at,
      ],
      db,
    )
  }
  await query(
    'UPDATE trading_agents SET base=0,basis=0,position_opened_at=NULL WHERE id=$1',
    [a.id],
    db,
  )
  await event(
    s,
    'residual',
    'SCOUT_RESIDUAL_PARKED',
    { agentId: a.id, residualId: id, symbol: a.symbol, base: a.base, basis: a.basis },
    db,
  )
  a.base = '0'
  a.basis = '0'
  a.position_opened_at = null
  return true
}

/** After an actual residual sale, return its USDT to a trading slot and retain its history. */
export async function releaseResidualCash(s: TradingScope, db: Connection) {
  const team = await agents(s, db)
  const slots = team.filter((a) => !a.residual_only)
  for (const a of team.filter((a) => a.residual_only && !BigInt(a.base) && !BigInt(a.basis))) {
    const target = slots.find((t) => t.id === a.parent_id) ?? slots[0]
    if (!target) continue
    await query(
      'UPDATE trading_agents SET cash=cash+$2::numeric WHERE id=$1',
      [target.id, a.cash],
      db,
    )
    await query(
      "UPDATE trading_agents SET status='archived',archived_at=now() WHERE id=$1",
      [a.id],
      db,
    )
    await event(
      s,
      'residual',
      'SCOUT_RESIDUAL_RELEASED',
      { residualId: a.id, agentId: target.id, cash: a.cash },
      db,
    )
  }
}
