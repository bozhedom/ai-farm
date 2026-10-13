import { query, transaction } from '../db'
import { MANAGER_POLICY as P, SCOUT_POLICY } from '../policy'
import { markAgent } from '../trading/accounting'
import { decimal } from '../trading/decimal'
import { scoutFresh, type ScoutRow } from '../trading/scout'
import type { AgentRow, PortfolioRow } from '../trading/types'
import type { ManagerSnapshot } from './plan'

/** A consistent, bounded projection; no config, account identity, user material or private mode. */
export async function managerSnapshot(): Promise<ManagerSnapshot> {
  return transaction(async (db) => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], db)
    const portfolios = await query<PortfolioRow>(
      "SELECT * FROM trading_portfolios WHERE mode='paper' ORDER BY exchange",
      [],
      db,
    )
    const agents = await query<AgentRow>(
      "SELECT * FROM trading_agents WHERE mode='paper' AND status='active' ORDER BY created_at,id",
      [],
      db,
    )
    const scouts = await query<ScoutRow>("SELECT * FROM trading_scouts WHERE mode='paper'", [], db)
    const prices = await query<{ exchange: string; symbol: string; bid: string; at: Date }>(
      "SELECT exchange,symbol,bid,at FROM trading_markets WHERE mode='paper'",
      [],
      db,
    )
    const active = await query<{ exchange: string }>(
      "SELECT exchange FROM trading_manager_tasks WHERE status IN ('queued','observing')",
      [],
      db,
    )
    const recentTasks = await query(
      "SELECT exchange,status,reason,proposal->>'hypothesis' AS hypothesis,outcome,created_at FROM trading_manager_tasks ORDER BY created_at DESC LIMIT 12",
      [],
      db,
    )
    const now = Date.now()
    return {
      at: new Date(now).toISOString(),
      portfolios: portfolios.map((p) => {
        const scout = scouts.find((s) => s.exchange === p.exchange)
        return {
          exchange: p.exchange,
          status: p.status,
          reason: p.reason,
          revision: p.manager_revision,
          activeTask: active.some((t) => t.exchange === p.exchange),
          scoutFresh: scoutFresh(scout),
          candidates: (scout?.coins || [])
            .filter((c) => c.eligible)
            .slice(0, 6)
            .map((c) => ({ symbol: c.symbol, score: c.score })),
          agents: agents
            .filter((a) => a.exchange === p.exchange)
            .slice(0, 4)
            .map((a) => {
              const price = prices.find(
                (m) =>
                  m.exchange === p.exchange &&
                  m.symbol === a.symbol &&
                  now - m.at.getTime() >= 0 &&
                  now - m.at.getTime() <= P.priceMaxAgeMs,
              )
              const flat = BigInt(a.base) === 0n && BigInt(a.basis) === 0n
              const pnl = flat
                ? BigInt(a.cash) - BigInt(a.initial_cash)
                : price
                  ? markAgent(a, BigInt(price.bid)).equity - BigInt(a.initial_cash)
                  : null
              return {
                id: a.id,
                kind: a.kind,
                params: a.params,
                symbol: a.symbol,
                selectorVersion: a.selector_version,
                assignedAt: a.assigned_at.toISOString(),
                createdAt: a.created_at.toISOString(),
                roundTrips: a.round_trips,
                cashUsdt: decimal(BigInt(a.cash)),
                baseQuantity: decimal(BigInt(a.base)),
                pnlUsdt: pnl === null ? null : decimal(pnl),
                drawdownBps: a.max_drawdown_bps,
                // Preserve promising agents and avoid replacing a young experiment before it has evidence.
                canExperiment:
                  flat &&
                  pnl !== null &&
                  pnl <= 0n &&
                  BigInt(a.cash) > 0n &&
                  a.selector_version === SCOUT_POLICY.version &&
                  now - a.created_at.getTime() >= P.minAgentAgeMs &&
                  !p.strategy_preset_pending,
              }
            }),
        }
      }),
      recentTasks,
    }
  })
}
