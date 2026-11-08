import { isResidual, parkResidual } from './residuals'
import { randomUUID } from 'node:crypto'
import { ownerEntryReason, tradingInstructions } from './owner-rules'
import { query, type Connection } from '../db'
import { SCOUT_POLICY as S } from '../policy'
import { agents, atomic, event, pendingOrder, portfolio } from './store'
import { admitted, scoutFresh, type ScoutRow } from './scout'
import { rankedFor, type ScoutCoin } from './universe'
import type { Market, StrategyKind, TradingScope, TradingSymbol } from './types'

export function pickSymbol(
  kind: StrategyKind,
  coins: ScoutCoin[],
  occupied: TradingSymbol[],
  exclude?: TradingSymbol,
) {
  return rankedFor(kind, coins).find(
    (c) =>
      c.symbol !== exclude && occupied.filter((s) => s === c.symbol).length < S.maxAgentsPerSymbol,
  )?.symbol
}
export async function recordAssignment(
  s: TradingScope,
  agentId: string,
  symbol: TradingSymbol,
  previous: TradingSymbol | null,
  reason: string,
  db: Connection,
) {
  await query(
    `INSERT INTO trading_assignments(exchange,mode,agent_id,symbol,previous_symbol,reason) VALUES($1,$2,$3,$4,$5,$6)`,
    [s.exchange, s.mode, agentId, symbol, previous, reason],
    db,
  )
  await event(s, 'selection', reason, { agentId, from: previous, to: symbol }, db)
}

/** A coin changes only after holdings are sold or conserved in a separate residual row. P&L belongs to the strategy's whole basket. */
export async function rotateAgents(
  s: TradingScope,
  scout: ScoutRow | undefined,
  db: Connection,
  markets: Partial<Record<TradingSymbol, Market>> = {},
) {
  if (!scoutFresh(scout)) return
  await atomic(db, async () => {
    const p = await portfolio(s, db, true)
    if (p.status !== 'running' || (await pendingOrder(s, db))) return
    const team = (await agents(s, db)).filter((a) => !a.residual_only)
    const { rules } = await tradingInstructions(db)
    for (const a of team) {
      const held = !!(BigInt(a.base) || BigInt(a.basis))
      if (held && !isResidual(a, markets[a.symbol])) continue
      const legacy = a.selector_version !== S.version
      // Existing funded strategies keep their authorization until a qualified successor is promoted.
      if (legacy && s.mode === 'live') continue
      const restricted = !!ownerEntryReason(rules, a)
      if (!restricted && !legacy && Date.now() - a.assigned_at.getTime() < S.minAssignmentMs)
        continue
      const idle =
        Date.now() - Math.max(a.assigned_at.getTime(), a.last_order_at?.getTime() || 0) >=
        S.idleRotationMs
      if (!restricted && !legacy && !idle && admitted(scout, a.symbol)) continue
      const symbol = pickSymbol(
        a.kind,
        scout!.coins.filter((c) => !ownerEntryReason(rules, { symbol: c.symbol, kind: a.kind })),
        team.filter((m) => m.id !== a.id).map((m) => m.symbol),
        legacy ? undefined : a.symbol,
      )
      if (!symbol) continue
      if (held && !(await parkResidual(s, a, markets[a.symbol], db))) continue
      const reason = legacy
        ? 'SCOUT_ADOPTED'
        : admitted(scout, a.symbol)
          ? 'SCOUT_IDLE_ROTATION'
          : 'SCOUT_REPLACED'
      if (legacy) {
        // Fixed-pair results cannot qualify the new selector; retain the old experiment in the archive.
        await query(
          "UPDATE trading_agents SET status='archived',archived_at=now() WHERE id=$1",
          [a.id],
          db,
        )
        const id = randomUUID()
        await query(
          `INSERT INTO trading_agents(id,exchange,mode,name,symbol,kind,params,parent_id,generation,initial_cash,cash,peak,selector_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,$11)`,
          [
            id,
            s.exchange,
            s.mode,
            a.name,
            symbol,
            a.kind,
            a.params,
            a.id,
            a.generation,
            a.cash,
            S.version,
          ],
          db,
        )
        await recordAssignment(s, id, symbol, a.symbol, reason, db)
      } else {
        await query(
          "UPDATE trading_agents SET symbol=$2,assigned_at=now(),last_signal='WAITING_SIGNAL' WHERE id=$1",
          [a.id, symbol],
          db,
        )
        await recordAssignment(s, a.id, symbol, a.symbol, reason, db)
      }
      a.symbol = symbol
    }
  })
}
