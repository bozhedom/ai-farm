import { query, transaction } from '../db'
import { TRADING_POLICY as P } from '../policy'
import type { TradingOverview } from '../contracts/trading'
import { decimal, units } from './decimal'
import { markAgent } from './accounting'
import { ensurePortfolios } from './store'
import { hasKeys } from './wire'
import {
  exchanges,
  type AgentRow,
  type PortfolioRow,
  type TradingExchange,
  type TradingMode,
} from './types'

/** One database snapshot, no external calls, and no mixing virtual and real money. */
export async function tradingOverview(mode: TradingMode): Promise<TradingOverview> {
  await ensurePortfolios()
  return transaction(async (db) => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], db)
    const portfolios = await query<PortfolioRow>('SELECT * FROM trading_portfolios', [], db)
    const team = await query<AgentRow>(
      "SELECT * FROM trading_agents WHERE mode=$1 AND status='active'",
      [mode],
      db,
    )
    const markets = await query<{
      exchange: TradingExchange
      symbol: string
      bid: string
      at: Date
    }>('SELECT * FROM trading_markets WHERE mode=$1', [mode], db)
    let total = 0n,
      pnl = 0n
    const connections = exchanges.map((exchange) => {
      const p = portfolios.find((p) => p.exchange === exchange && p.mode === mode)!
      const live = portfolios.find((p) => p.exchange === exchange && p.mode === 'live')!
      const own = team.filter((a) => a.exchange === exchange),
        prices = markets.filter((m) => m.exchange === exchange)
      let equity = own.reduce((sum, a) => {
        const bid = prices.find((m) => m.symbol === a.symbol)?.bid
        return sum + (bid ? markAgent(a, BigInt(bid)).equity : BigInt(a.cash) + BigInt(a.basis))
      }, 0n)
      if (!own.length && mode === 'paper') equity = BigInt(p.capital)
      const profit = p.started_at ? equity - BigInt(p.capital) : 0n
      total += equity
      pnl += profit
      return {
        exchange,
        status: p.status,
        keys: hasKeys(p),
        error: p.check_error || p.reason,
        workerAlive: !!p.heartbeat && Date.now() - p.heartbeat.getTime() < 90_000,
        fresh:
          !p.check_error &&
          prices.length === P.symbols.length &&
          prices.every((m) => Date.now() - m.at.getTime() < 90_000),
        capital: decimal(BigInt(p.capital)),
        equity: decimal(equity),
        pnl: decimal(profit),
        activeAgents: own.length,
        allocationEditable: !live.started_at && !live.account_identity,
        liveAllocation: decimal(BigInt(live.capital)),
      }
    })
    const allocated = portfolios
      .filter((p) => p.mode === 'live')
      .reduce((sum, p) => sum + BigInt(p.capital), 0n)
    return {
      mode,
      capitalLimit: P.capitalUsdt,
      minimumAllocation: P.minLiveCapitalUsdt,
      allocated: decimal(allocated),
      unallocated: decimal(units(String(P.capitalUsdt)) - allocated),
      equity: decimal(total),
      pnl: decimal(pnl),
      connections,
    }
  })
}
