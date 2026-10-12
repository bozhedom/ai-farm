import { query } from '../db'
import { config } from '../config'
import { TRADING_POLICY as P } from '../policy'
import type { TradingView } from '../contracts/trading'
import { decimal, max, ratioBps } from './decimal'
import { markAgent } from './accounting'
import { hasCredentials } from './okx'
import { eligible } from './strategy'
import { agents, ensurePortfolios, paperCandidates, portfolio } from './store'
import type { AgentRow, OrderRow, TradingMode, TradingSymbol } from './types'

export async function tradingView(mode: TradingMode): Promise<TradingView> {
  await ensurePortfolios()
  const p = await portfolio(mode)
  const team = await query<AgentRow>(
    'SELECT * FROM trading_agents WHERE mode=$1 ORDER BY generation DESC,created_at,id LIMIT 100',
    [mode],
  )
  const markets = await query<{ symbol: TradingSymbol; bid: string; ask: string; at: Date }>(
    'SELECT * FROM trading_markets WHERE mode=$1 ORDER BY symbol',
    [mode],
  )
  const orders = await query<OrderRow & { name: string }>(
    `SELECT o.*,a.name FROM trading_orders o JOIN trading_agents a ON a.id=o.agent_id
    WHERE o.mode=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT 50`,
    [mode],
  )
  const events = await query(
    'SELECT * FROM trading_events WHERE mode=$1 ORDER BY id DESC LIMIT 40',
    [mode],
  )
  const curve = await query(
    `SELECT DISTINCT ON (date_bin(interval '5 minutes',at,timestamptz '2000-01-01')) at,equity
    FROM trading_equity WHERE mode=$1 AND at>now()-interval '24 hours'
    ORDER BY date_bin(interval '5 minutes',at,timestamptz '2000-01-01') DESC,at DESC LIMIT 288`,
    [mode],
  )
  const [lifetime] = await query(
    'SELECT coalesce(sum(realized),0) AS realized,coalesce(sum(fees),0) AS fees,coalesce(sum(round_trips),0)::int AS trips FROM trading_agents WHERE mode=$1',
    [mode],
  )
  const current = team.filter((a) => a.status === 'active')
  let cash = 0n,
    exposure = 0n
  for (const a of current) {
    cash += BigInt(a.cash)
    const price = markets.find((m) => m.symbol === a.symbol)?.bid
    exposure += price ? markAgent(a, BigInt(price)).exposure : BigInt(a.basis)
  }
  // A configured budget is not evidence of money in an unconnected exchange account.
  if (!current.length && mode === 'paper') cash = BigInt(p.capital)
  const equity = cash + exposure
  const paper = await paperCandidates()
  const demo = await portfolio('demo')
  const demoAgents = await agents('demo')
  const connection =
    !p.check_error && !!p.checked_at && Date.now() - p.checked_at.getTime() < 90_000
  return {
    mode,
    status: p.status,
    reason: p.reason,
    checkError: p.check_error,
    checkedAt: p.checked_at?.toISOString() || null,
    heartbeat: p.heartbeat?.toISOString() || null,
    workerAlive: !!p.heartbeat && Date.now() - p.heartbeat.getTime() < 90_000,
    generation: p.generation,
    evolutionReason: p.evolution_reason,
    metrics: {
      capital: decimal(BigInt(p.capital)),
      equity: decimal(equity),
      cash: decimal(cash),
      exposure: decimal(exposure),
      pnl: p.started_at ? decimal(equity - BigInt(p.capital)) : '0',
      realized: decimal(BigInt(lifetime!.realized)),
      fees: decimal(BigInt(lifetime!.fees)),
      drawdownBps: p.started_at ? ratioBps(max(0n, BigInt(p.peak) - equity), BigInt(p.peak)) : 0,
      dailyLossBps: p.started_at
        ? ratioBps(max(0n, BigInt(p.day_equity) - equity), BigInt(p.day_equity))
        : 0,
      roundTrips: lifetime!.trips,
    },
    limits: {
      orderUsdt: P.orderUsdt,
      exposureBps: P.maxExposureBps,
      dailyLossBps: P.dailyLossBps,
      drawdownBps: P.drawdownBps,
      positionStopBps: P.positionStopBps,
      maxOrdersPerDay: P.maxOrdersPerDay,
      evaluationDays: P.minEvaluationDays,
      evaluationTrips: P.minRoundTrips,
    },
    readiness: {
      keys: hasCredentials(mode),
      liveEnabled: config().TRADING_LIVE_ENABLED,
      paperQualified: paper.length > 0,
      demoVerified:
        demoAgents.some((a) => a.round_trips > 0) &&
        !demo.check_error &&
        !!demo.checked_at &&
        Date.now() - demo.checked_at.getTime() < 600_000,
      connection,
    },
    markets: markets.map((m) => ({
      symbol: m.symbol,
      bid: decimal(BigInt(m.bid)),
      ask: decimal(BigInt(m.ask)),
      at: m.at.toISOString(),
    })),
    agents: team.map((a) => {
      const bid = markets.find((m) => m.symbol === a.symbol)?.bid
      const value =
        a.status === 'active' && bid
          ? markAgent(a, BigInt(bid)).equity
          : BigInt(a.cash) + BigInt(a.basis)
      return {
        id: a.id,
        name: a.name,
        symbol: a.symbol,
        kind: a.kind,
        params: a.params,
        status: a.status,
        parentId: a.parent_id,
        generation: a.generation,
        cash: decimal(BigInt(a.cash)),
        base: decimal(BigInt(a.base)),
        equity: decimal(value),
        pnl: decimal(value - BigInt(a.initial_cash)),
        realized: decimal(BigInt(a.realized)),
        fees: decimal(BigInt(a.fees)),
        drawdownBps: a.max_drawdown_bps,
        roundTrips: a.round_trips,
        signal: a.last_signal,
        eligible: eligible(a),
        createdAt: a.created_at.toISOString(),
      }
    }),
    orders: orders.map((o) => ({
      id: o.id,
      clientId: o.client_id,
      agentName: o.name,
      symbol: o.symbol,
      side: o.side,
      status: o.status,
      qty: decimal(BigInt(o.qty)),
      price: decimal(BigInt(o.price)),
      filledQty: decimal(BigInt(o.filled_qty)),
      quote: decimal(BigInt(o.quote)),
      feeBase: decimal(BigInt(o.base_fee)),
      feeQuote: decimal(BigInt(o.quote_fee)),
      reason: o.reason,
      createdAt: o.created_at.toISOString(),
    })),
    events: events.map((e) => ({
      id: String(e.id),
      kind: e.kind,
      reason: e.reason,
      at: e.created_at.toISOString(),
    })),
    equity: curve
      .reverse()
      .map((e) => ({ at: e.at.toISOString(), value: decimal(BigInt(e.equity)) })),
    unresolvedClientId: orders.find((o) => o.status === 'unknown')?.client_id || null,
  }
}
