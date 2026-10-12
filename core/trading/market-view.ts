import { query } from '../db'
import { SCOUT_POLICY as S, TRADING_POLICY as P } from '../policy'
import { agents, ensurePortfolios } from './store'
import { scoutFresh, scoutState } from './scout'
import type { TradingScope } from './types'
import type { TradingMarketView } from '../contracts/trading'

export async function tradingMarketView(
  s: TradingScope,
  search = '',
  filter = 'ready',
  page = 1,
): Promise<TradingMarketView> {
  await ensurePortfolios()
  const report = await scoutState(s)
  const coins = report?.coins || []
  const team = await agents(s)
  const matches = coins.filter(
    (c) => c.symbol.includes(search.toUpperCase()) && (filter !== 'ready' || c.eligible),
  )
  const assignments = await query(
    `SELECT t.*,a.name FROM trading_assignments t JOIN trading_agents a ON a.id=t.agent_id WHERE t.exchange=$1 AND t.mode=$2 ORDER BY t.id DESC LIMIT 20`,
    [s.exchange, s.mode],
  )
  return {
    exchange: s.exchange,
    mode: s.mode,
    scannedAt: report?.scanned_at?.toISOString() || null,
    attemptedAt: report?.attempted_at.toISOString() || null,
    fresh: scoutFresh(report),
    error: report?.error || '',
    total: coins.length,
    ready: coins.filter((c) => c.eligible).length,
    screened: coins.filter((c) => c.score > 0).length,
    matches: matches.length,
    page,
    pageSize: 20,
    coins: matches.slice((page - 1) * 20, page * 20),
    assignments: assignments.map((a) => ({
      id: String(a.id),
      name: a.name,
      symbol: a.symbol,
      previous: a.previous_symbol,
      reason: a.reason,
      at: a.created_at.toISOString(),
    })),
    active: team.map((a) => ({
      name: a.name,
      symbol: a.symbol,
      holding: BigInt(a.base) > 0n,
      since: a.assigned_at.toISOString(),
    })),
    limits: {
      scanMinutes: S.scanMs / 60_000,
      idleHours: S.idleRotationMs / 3_600_000,
      holdHours: S.maxPositionMs / 3_600_000,
      bookDepthUsdt: P.orderUsdt * S.depthOrderMultiplier,
      dailyTurnover: S.minTurnoverUsdt,
      maxSpreadBps: P.maxSpreadBps,
      candidates: S.maxCandidates,
    },
  }
}
