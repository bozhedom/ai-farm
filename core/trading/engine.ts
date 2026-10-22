import { randomUUID } from 'node:crypto'
import { query, transaction, type Connection } from '../db'
import { config } from '../config'
import { TRADING_POLICY as P, SCOUT_POLICY as S } from '../policy'
import { admitted, refreshScout, scoutFresh, scoutState } from './scout'
import { baseAsset } from './universe'
import { rotateAgents, recordAssignment, pickSymbol } from './rotation'
import { BPS, abs, cost, decimal, fee, max, proceeds, ratioBps, units } from './decimal'
import { applyFill, markAgent, paperFill, riskReason } from './accounting'
import { eligible, fitness, mutate, signal, sizeOrder, validateMarket } from './strategy'
import { classicPlan, isClassic, settleClassic } from './classic'
import { OrderRejected } from './wire'
import { createVenue } from './venues'
import { exchangeCatalog } from './catalog'
import { applyManagerTask } from '../manager/tasks'
import { exchanges, type TradingScope, type TradingExchange } from './types'
import {
  agents,
  scope,
  atomic,
  ensurePortfolios,
  event,
  modes,
  pendingOrder,
  paperCandidates,
  portfolio,
  requestFor,
  seedAgents,
  seedPlan,
  withTradingLock,
  applyPaperStrategyPreset,
} from './store'
import type {
  Account,
  AgentRow,
  Market,
  OrderRequest,
  OrderResult,
  OrderRow,
  PortfolioRow,
  TradingMode,
  TradingSymbol,
  TradingVenue,
} from './types'

export type VenueFactory = (scope: TradingScope) => TradingVenue
const venues: VenueFactory = createVenue
export const liveConfirmation = (p: Pick<PortfolioRow, 'exchange' | 'capital'>) =>
  `ТОРГОВАТЬ ${decimal(BigInt(p.capital))} USDT НА ${exchangeCatalog[p.exchange].name.toUpperCase()}`

export function safeTradingError(error: unknown) {
  return error instanceof Error && /^(TRADING_[A-Z_]+)$/.test(error.message)
    ? error.message
    : 'TRADING_RESPONSE_INVALID'
}

async function halt(s: TradingScope, reason: string, db: Connection) {
  const { mode } = s
  const p = await portfolio(s, db)
  if (p.status !== 'stopped' || p.reason !== reason) {
    await query(
      "UPDATE trading_portfolios SET status='stopped',reason=$2 WHERE mode=$1 AND exchange=$3",
      [mode, reason, s.exchange],
      db,
    )
    await event(s, 'halt', reason, {}, db)
  }
}

async function loadMarkets(
  s: TradingScope,
  venue: TradingVenue,
  symbols: TradingSymbol[],
  db: Connection,
) {
  const { mode } = s
  const markets = {} as Record<TradingSymbol, Market>
  const failures: string[] = []
  for (const symbol of new Set(symbols)) {
    try {
      const market = await venue.market(symbol)
      validateMarket(market)
      if (market.instrument.symbol !== symbol) throw new Error('TRADING_INSTRUMENT_INVALID')
      markets[symbol] = market
      await query(
        `INSERT INTO trading_markets(mode,symbol,at,bid,ask,exchange) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(exchange,mode,symbol) DO UPDATE SET at=excluded.at,bid=excluded.bid,ask=excluded.ask`,
        [
          mode,
          symbol,
          new Date(market.book.at),
          market.book.bids[0]![0].toString(),
          market.book.asks[0]![0].toString(),
          s.exchange,
        ],
        db,
      )
    } catch (error) {
      failures.push(safeTradingError(error))
      await query(
        "UPDATE trading_agents SET last_signal=$4 WHERE exchange=$1 AND mode=$2 AND symbol=$3 AND status='active'",
        [s.exchange, s.mode, symbol, safeTradingError(error)],
        db,
      )
    }
  }
  if (symbols.length && !Object.keys(markets).length)
    throw new Error(failures[0] || 'TRADING_STALE_MARKET')
  return markets
}

async function reconcileAccount(
  p: PortfolioRow,
  account: Account,
  venue: TradingVenue,
  db: Connection,
) {
  if (p.account_identity && p.account_identity !== account.identity)
    throw new Error('TRADING_ACCOUNT_CHANGED')
  if ((await venue.pending()).length) throw new Error('TRADING_EXTERNAL_ORDERS')
  const team = await agents(p, db)
  if (!p.account_identity) {
    if (Object.entries(account.balances).some(([ccy, b]) => ccy !== 'USDT' && b.total !== 0n))
      throw new Error('TRADING_INITIAL_ASSETS')
    if (account.balances.USDT.available < BigInt(p.capital))
      throw new Error('TRADING_INSUFFICIENT_FUNDS')
    return
  }
  const expected: Record<string, bigint> & { USDT: bigint } = Object.assign(Object.create(null), {
    USDT: BigInt(p.quote_offset),
  })
  for (const agent of team) {
    expected.USDT += BigInt(agent.cash)
    const ccy = baseAsset(agent.symbol)
    expected[ccy] = (expected[ccy] || 0n) + BigInt(agent.base)
  }
  for (const ccy of new Set([...Object.keys(expected), ...Object.keys(account.balances)])) {
    const actual = account.balances[ccy] || { total: 0n, available: 0n }
    const tolerance = units(ccy === 'USDT' ? '0.000001' : '0.000000000001')
    if (
      abs(actual.total - (expected[ccy] || 0n)) > tolerance ||
      actual.total - actual.available > tolerance
    )
      throw new Error('TRADING_BALANCE_DRIFT')
  }
}

async function settle(row: OrderRow, result: OrderResult, minQty: bigint, db: Connection) {
  await atomic(db, async () => {
    const [saved] = await query<OrderRow>(
      'SELECT * FROM trading_orders WHERE id=$1 FOR UPDATE',
      [row.id],
      db,
    )
    if (!saved || ['filled', 'canceled', 'rejected'].includes(saved.status)) return
    if (!['filled', 'canceled'].includes(result.state)) throw new Error('TRADING_ORDER_NOT_FINAL')
    const [agent] = await query<AgentRow>(
      'SELECT * FROM trading_agents WHERE id=$1 FOR UPDATE',
      [row.agent_id],
      db,
    )
    if (!agent) throw new Error('TRADING_AGENT_NOT_FOUND')
    const fill = applyFill(agent, result, minQty)
    await query(
      `UPDATE trading_agents SET cash=$2,base=$3,basis=$4,realized=$5,fees=$6,round_trips=$7,strategy_state=$8,position_opened_at=CASE WHEN $3::numeric=0 THEN NULL WHEN base=0 AND $3::numeric>0 THEN now() ELSE position_opened_at END WHERE id=$1`,
      [
        agent.id,
        fill.cash.toString(),
        fill.base.toString(),
        fill.basis.toString(),
        fill.realized.toString(),
        fill.fees.toString(),
        fill.roundTrips,
        isClassic(agent.kind) ? settleClassic(agent, result) : agent.strategy_state || {},
      ],
      db,
    )
    await query(
      `UPDATE trading_orders SET status=$2,exchange_id=$3,filled_qty=$4,quote=$5,base_fee=$6,quote_fee=$7,settled_at=now() WHERE id=$1`,
      [
        row.id,
        result.state,
        result.exchangeId,
        result.filledQty.toString(),
        result.quote.toString(),
        result.baseFee.toString(),
        result.quoteFee.toString(),
      ],
      db,
    )
    await event(
      row,
      'order_settled',
      result.filledQty ? 'ORDER_FILLED' : 'ORDER_UNFILLED',
      {
        clientId: row.client_id,
        side: row.side,
        symbol: row.symbol,
        qty: decimal(result.filledQty),
        quote: decimal(result.quote),
      },
      db,
    )
  })
}

/** Resolve uncertain submissions by reading the exchange. Never re-send a submitted intent. */
async function recover(s: TradingScope, venue: TradingVenue, db: Connection) {
  const { mode } = s
  const row = await pendingOrder(s, db)
  if (!row) return true
  if (row.status === 'prepared' || mode === 'paper') {
    await query(
      "UPDATE trading_orders SET status='canceled',reason='NOT_SENT',settled_at=now() WHERE id=$1",
      [row.id],
      db,
    )
    await event(s, 'recovery', 'NOT_SENT', { clientId: row.client_id }, db)
    return true
  }
  const result = await venue.order(requestFor(row))
  if (!result) {
    await query("UPDATE trading_orders SET status='unknown' WHERE id=$1", [row.id], db)
    await halt(s, 'TRADING_ORDER_UNKNOWN', db)
    return false
  }
  if (result.state === 'live' || result.state === 'partially_filled') {
    // An IOC normally ends immediately; cancellation is safe to retry, order placement is not.
    await venue.cancel(requestFor(row))
    return false
  }
  const market = await venue.market(row.symbol)
  await settle(row, result, market.instrument.minQty, db)
  return true
}

async function submit(
  p: PortfolioRow,
  agent: AgentRow,
  request: OrderRequest,
  reason: string,
  markets: Record<TradingSymbol, Market>,
  venue: TradingVenue,
  db: Connection,
) {
  const market = markets[request.symbol]
  validateMarket(market)
  const id = randomUUID()
  // The transaction reserves the only unresolved-order slot and fences concurrent owner stops.
  const row = await atomic(db, async () => {
    const current = await portfolio(p, db, true)
    if (current.status !== 'running' && !(current.status === 'paused' && request.side === 'sell'))
      return null
    if (await pendingOrder(p, db)) return null
    validateMarket(market)
    const team = await agents(p, db)
    const fresh = team.find((a) => a.id === agent.id)
    if (
      !fresh ||
      fresh.status !== 'active' ||
      fresh.symbol !== request.symbol ||
      market.instrument.symbol !== request.symbol
    )
      return null
    if (request.side === 'buy') {
      if (isClassic(fresh.kind)) {
        if (p.mode !== 'paper') throw new Error('TRADING_CLASSIC_PAPER_ONLY')
        const plan = classicPlan(fresh)
        if (
          BigInt(fresh.basis) + plan.budget > plan.ceiling ||
          cost(request.qty, request.price) + fee(cost(request.qty, request.price), P.maxFeeBps) >
            plan.budget
        )
          throw new Error('TRADING_ORDER_LIMIT')
      }
      if (!admitted(await scoutState(p, db), request.symbol)) return null
      const value = cost(request.qty, request.price)
      if (
        value + fee(value, P.maxFeeBps) > BigInt(fresh.cash) ||
        value > units(String(P.orderUsdt))
      )
        throw new Error('TRADING_ORDER_LIMIT')
      const [today] = await query(
        "SELECT count(*)::int AS count FROM trading_orders WHERE mode=$1 AND exchange=$2 AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
        [p.mode, p.exchange],
        db,
      )
      if (today!.count >= P.maxOrdersPerDay) return null
      let invested = 0n,
        equity = 0n
      for (const member of team) {
        let position = 0n
        if (BigInt(member.base)) {
          const held = markets[member.symbol]
          validateMarket(held)
          position = proceeds(BigInt(member.base), held.book.bids[0]![0])
        }
        invested += position
        equity += BigInt(member.cash) + position
      }
      const ceiling = equity < BigInt(current.capital) ? equity : BigInt(current.capital)
      if ((invested + value) * BPS > ceiling * BigInt(P.maxExposureBps)) return null
    } else if (request.qty > BigInt(fresh.base)) throw new Error('TRADING_ORDER_LIMIT')
    const [created] = await query<OrderRow>(
      `INSERT INTO trading_orders(id,mode,agent_id,client_id,symbol,side,qty,price,status,reason,exchange)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9,$10) RETURNING *`,
      [
        id,
        p.mode,
        agent.id,
        request.clientId,
        request.symbol,
        request.side,
        request.qty.toString(),
        request.price.toString(),
        reason,
        p.exchange,
      ],
      db,
    )
    await query(
      'UPDATE trading_agents SET last_order_at=now(),last_signal=$2 WHERE id=$1',
      [agent.id, reason],
      db,
    )
    return created!
  })
  if (!row) return
  if (p.mode === 'paper') {
    await settle(
      row,
      paperFill(request, market.book, market.instrument.lot),
      market.instrument.minQty,
      db,
    )
    return
  }
  const dispatch = await atomic(db, async () => {
    const current = await portfolio(p, db, true)
    if (current.status !== 'running' && !(current.status === 'paused' && request.side === 'sell')) {
      await query(
        "UPDATE trading_orders SET status='canceled',reason='NOT_SENT',settled_at=now() WHERE id=$1",
        [row.id],
        db,
      )
      return false
    }
    if (p.mode === 'live' && !config().TRADING_LIVE_ENABLED)
      throw new Error('TRADING_LIVE_DISABLED')
    validateMarket(market)
    await query("UPDATE trading_orders SET status='submitted' WHERE id=$1", [row.id], db)
    return true
  })
  if (!dispatch) return
  try {
    await venue.place(request)
  } catch (error) {
    if (error instanceof OrderRejected) {
      await query(
        "UPDATE trading_orders SET status='rejected',settled_at=now() WHERE id=$1",
        [row.id],
        db,
      )
      await halt(p, 'TRADING_ORDER_REJECTED', db)
      return
    }
    await query("UPDATE trading_orders SET status='unknown' WHERE id=$1", [row.id], db)
    await halt(p, 'TRADING_ORDER_UNKNOWN', db)
    return
  }
  // Settlement happens on the next tick, after the exchange has made its fills visible.
}

async function mark(p: PortfolioRow, markets: Record<TradingSymbol, Market>, db: Connection) {
  const team = await agents(p, db)
  if (team.some((a) => BigInt(a.base) && !markets[a.symbol])) return false
  let equity = team.length ? 0n : BigInt(p.capital),
    exposure = 0n,
    cash = team.length ? 0n : BigInt(p.capital)
  for (const a of team) {
    const m = markAgent(a, markets[a.symbol]?.book.bids[0]![0] || 0n)
    equity += m.equity
    exposure += m.exposure
    cash += BigInt(a.cash)
    const peak = max(BigInt(a.peak), m.equity)
    await query(
      'UPDATE trading_agents SET peak=$2,max_drawdown_bps=greatest(max_drawdown_bps,$3) WHERE id=$1',
      [a.id, peak.toString(), ratioBps(peak - m.equity, peak)],
      db,
    )
  }
  const day = new Date().toISOString().slice(0, 10)
  // A day boundary uses the last mark before midnight so a gap/down move is not forgiven.
  const [previous] = await query(
    'SELECT equity FROM trading_equity WHERE mode=$1 AND exchange=$2 ORDER BY at DESC LIMIT 1',
    [p.mode, p.exchange],
    db,
  )
  const dayEquity =
    p.risk_day === day ? BigInt(p.day_equity) : BigInt(previous?.equity || p.capital)
  const peak = max(BigInt(p.peak), equity)
  await query(
    'UPDATE trading_portfolios SET peak=$2,day_equity=$3,risk_day=$4 WHERE mode=$1 AND exchange=$5',
    [p.mode, peak.toString(), dayEquity.toString(), day, p.exchange],
    db,
  )
  await query(
    'INSERT INTO trading_equity(mode,equity,cash,exposure,exchange) VALUES ($1,$2,$3,$4,$5)',
    [p.mode, equity.toString(), cash.toString(), exposure.toString(), p.exchange],
    db,
  )
  const reason = riskReason(equity, peak, dayEquity)
  if (reason && (p.status === 'running' || p.status === 'paused')) {
    const changed = await query(
      "UPDATE trading_portfolios SET status='paused',reason=$2 WHERE mode=$1 AND exchange=$3 AND status IN ('running','paused') AND (status <> 'paused' OR reason <> $2) RETURNING mode",
      [p.mode, reason, p.exchange],
      db,
    )
    if (changed.length)
      await event(
        p,
        'risk',
        reason,
        { equity: decimal(equity), previousStatus: p.status, previousReason: p.reason },
        db,
      )
  } else if (!reason) await resumeDailyLoss(p, day, db)
  return true
}

/**
 * A Paper/Demo daily-loss pause ends at the next UTC day when no other limit applies, so the
 * training keeps collecting data. Live always needs the owner. Drawdown, stops and owner pauses
 * are never cleared here.
 */
export async function resumeDailyLoss(p: PortfolioRow, day: string, db: Connection) {
  if (p.mode === 'live' || p.status !== 'paused' || p.reason !== 'DAILY_LOSS_LIMIT') return
  const [risk] = await query<{ created_at: Date; data: Record<string, unknown> }>(
    `SELECT created_at,data FROM trading_events WHERE exchange=$1 AND mode=$2 AND kind='risk'
      AND reason='DAILY_LOSS_LIMIT' ORDER BY created_at DESC LIMIT 1`,
    [p.exchange, p.mode],
    db,
  )
  if (!risk || risk.created_at.toISOString().slice(0, 10) >= day) return
  // A pause that existed before the limit fired (owner pause/exit, completed demo probe) is
  // restored. Older risk events lack that metadata, so the last control event before it decides.
  const [control] = await query<{ kind: string; reason: string }>(
    `SELECT kind,reason FROM trading_events WHERE exchange=$1 AND mode=$2
      AND (kind IN ('start','pause','flatten','stop','demo') OR (kind='risk' AND reason='DRAWDOWN_LIMIT'))
      AND created_at < $3
      ORDER BY created_at DESC LIMIT 1`,
    [p.exchange, p.mode, risk.created_at],
    db,
  )
  const restored =
    risk.data && 'previousStatus' in risk.data
      ? risk.data.previousStatus === 'paused'
        ? String(risk.data.previousReason || 'OWNER_PAUSE')
        : ''
      : control && ['pause', 'flatten', 'demo', 'risk'].includes(control.kind)
        ? control.reason
        : ''
  const changed = await query(
    `UPDATE trading_portfolios SET status=$3,reason=$4 WHERE mode=$1 AND exchange=$2
      AND status='paused' AND reason='DAILY_LOSS_LIMIT' RETURNING mode`,
    [p.mode, p.exchange, restored ? 'paused' : 'running', restored],
    db,
  )
  if (changed.length)
    await event(
      p,
      'auto_resume',
      restored ? 'DAILY_LOSS_RESET_PAUSE_KEPT' : 'DAILY_LOSS_RESET',
      { day, restoredReason: restored },
      db,
    )
}

async function evolve(exchange: TradingExchange, db: Connection) {
  const s = scope(exchange, 'paper')
  const p = await portfolio(s, db)
  if (p.strategy_preset_pending) return
  if (
    (
      await query(
        `SELECT id FROM trading_manager_tasks WHERE exchange=$1 AND
      (status='observing' OR (status='queued' AND EXISTS(SELECT 1 FROM trading_manager WHERE enabled))) LIMIT 1`,
        [exchange],
        db,
      )
    ).length
  )
    return
  if (p.evolution_at && Date.now() - p.evolution_at.getTime() < 86_400_000) return
  const team = await agents(s, db)
  let reason = 'COLLECTING_DATA'
  const enough =
    team.length >= 2 &&
    team.every(
      (a) =>
        Date.now() - a.created_at.getTime() >= P.minEvaluationDays * 86_400_000 &&
        a.round_trips >= P.minRoundTrips,
    )
  if (enough) {
    const ranked = [...team].sort((a, b) => fitness(b) - fitness(a))
    const leaderCount = Math.floor(team.length / 2)
    if (team.some((a) => BigInt(a.base))) reason = 'POSITIONS_OPEN'
    else if (
      ranked.slice(0, leaderCount).some((a) => !eligible(a)) ||
      fitness(ranked[leaderCount - 1]!) <= fitness(ranked[leaderCount]!)
    )
      reason = 'NO_PROVEN_EDGE'
    else {
      const evolved = await atomic(db, async () => {
        const locked = await portfolio(s, db, true)
        if (locked.status !== 'running' || (await pendingOrder(s, db))) return false
        const scout = await scoutState(s, db)
        if (!scoutFresh(scout)) return false
        const selected: TradingSymbol[] = []
        for (let i = 0; i < team.length; i++) {
          const parent = ranked[i % leaderCount]!
          const symbol =
            admitted(scout, parent.symbol) &&
            selected.filter((s) => s === parent.symbol).length < S.maxAgentsPerSymbol
              ? parent.symbol
              : pickSymbol(parent.kind, scout!.coins, selected)
          if (!symbol) return false
          selected.push(symbol)
        }
        const capital = team.reduce((s, a) => s + BigInt(a.cash), 0n)
        await query(
          "UPDATE trading_agents SET status='archived',archived_at=now() WHERE mode='paper' AND exchange=$1 AND status='active'",
          [exchange],
          db,
        )
        for (let i = 0; i < team.length; i++) {
          const id = randomUUID()
          const parent = ranked[i % leaderCount]!
          const amount =
            capital / BigInt(team.length) + (i === 0 ? capital % BigInt(team.length) : 0n)
          const params = i < leaderCount ? parent.params : mutate(parent.params, p.generation + 1)
          await query(
            `INSERT INTO trading_agents(id,mode,name,symbol,kind,params,parent_id,generation,initial_cash,cash,peak,exchange,selector_version)
            VALUES ($1,'paper',$2,$3,$4,$5,$6,$7,$8,$8,$8,$9,$10)`,
            [
              id,
              `${parent.name.split(' · ')[0]} · ${p.generation + 1}${i < leaderCount ? '' : 'м'}`,
              selected[i],
              parent.kind,
              params,
              parent.id,
              p.generation + 1,
              amount.toString(),
              exchange,
              S.version,
            ],
            db,
          )
          await recordAssignment(s, id, selected[i]!, null, 'SCOUT_ASSIGNED', db)
        }
        await query(
          "UPDATE trading_portfolios SET generation=generation+1 WHERE mode='paper' AND exchange=$1",
          [exchange],
          db,
        )
        await event(
          s,
          'evolution',
          'LEADERS_CLONED',
          { parents: ranked.slice(0, leaderCount).map((a) => a.id), generation: p.generation + 1 },
          db,
        )
        return true
      })
      if (evolved) reason = 'LEADERS_CLONED'
    }
  }
  await query(
    "UPDATE trading_portfolios SET evolution_at=now(),evolution_reason=$1 WHERE mode='paper' AND exchange=$2",
    [reason, exchange],
    db,
  )
}

/** Reallocate the live slot only while completely in cash, preserving the account risk history. */
async function promoteLive(exchange: TradingExchange, db: Connection) {
  const s = scope(exchange, 'live')
  const p = await portfolio(s, db)
  if (p.evolution_at && Date.now() - p.evolution_at.getTime() < 86_400_000) return
  const [current] = await agents(s, db)
  const candidate = (await paperCandidates(exchange, db))[0]
  let reason = 'NO_PROVEN_EDGE'
  if (current && BigInt(current.base)) reason = 'POSITIONS_OPEN'
  else if (current && candidate && current.parent_id !== candidate.id) {
    const [parent] = await query<AgentRow>(
      'SELECT * FROM trading_agents WHERE id=$1',
      [current.parent_id],
      db,
    )
    const same =
      current.symbol === candidate.symbol &&
      current.kind === candidate.kind &&
      current.params.lookback === candidate.params.lookback &&
      current.params.entryBps === candidate.params.entryBps &&
      current.params.takeProfitBps === candidate.params.takeProfitBps
    if (!same && parent && fitness(candidate) >= fitness(parent) + P.promotionGapBps) {
      const promoted = await atomic(db, async () => {
        const locked = await portfolio(s, db, true)
        if (locked.status !== 'running' || (await pendingOrder(s, db))) return false
        const id = randomUUID()
        await query(
          "UPDATE trading_agents SET status='archived',archived_at=now() WHERE id=$1",
          [current.id],
          db,
        )
        await query(
          `INSERT INTO trading_agents(id,mode,name,symbol,kind,params,parent_id,generation,initial_cash,cash,peak,exchange,selector_version)
          VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,$8,$8,$9,$10)`,
          [
            id,
            candidate.name,
            candidate.symbol,
            candidate.kind,
            candidate.params,
            candidate.id,
            p.generation + 1,
            current.cash,
            exchange,
            S.version,
          ],
          db,
        )
        await recordAssignment(s, id, candidate.symbol, null, 'SCOUT_ASSIGNED', db)
        await query(
          "UPDATE trading_portfolios SET generation=generation+1 WHERE mode='live' AND exchange=$1",
          [exchange],
          db,
        )
        await event(
          s,
          'evolution',
          'LIVE_LEADER_PROMOTED',
          { parent: candidate.id, previous: current.id },
          db,
        )
        return true
      })
      if (promoted) reason = 'LIVE_LEADER_PROMOTED'
    }
  }
  await query(
    "UPDATE trading_portfolios SET evolution_at=now(),evolution_reason=$1 WHERE mode='live' AND exchange=$2",
    [reason, exchange],
    db,
  )
}

export async function tradingTick(
  factory: VenueFactory = venues,
  isStopping = () => false,
  selected: readonly TradingExchange[] = exchanges,
) {
  await ensurePortfolios()
  await Promise.all(
    selected.map(async (exchange) => {
      for (const mode of modes) {
        const s = scope(exchange, mode)
        if (isStopping()) break
        try {
          await withTradingLock(s, async (db) => {
            let p = await portfolio(s, db)
            await query(
              'UPDATE trading_portfolios SET heartbeat=now() WHERE mode=$1 AND exchange=$2',
              [mode, exchange],
              db,
            )
            if (!p.started_at || (p.last_tick && Date.now() - p.last_tick.getTime() < P.tickMs))
              return
            await query(
              'UPDATE trading_portfolios SET last_tick=now() WHERE mode=$1 AND exchange=$2',
              [mode, exchange],
              db,
            )
            const venue = factory(s)
            if (!(await recover(s, venue, db))) return
            const scout = await refreshScout(
              s,
              venue,
              (await agents(s, db)).map((a) => a.symbol),
              db,
            )
            if (p.status === 'running') {
              if (mode !== 'live')
                await atomic(db, async () => {
                  if ((await portfolio(s, db, true)).status === 'running') {
                    await applyPaperStrategyPreset(s, db)
                    await seedAgents(s, db, scout)
                    await applyManagerTask(s, db)
                  }
                })
              await rotateAgents(s, scout, db)
            }
            let account: Account | undefined
            if (mode !== 'paper') {
              account = await venue.account((await agents(s, db)).map((a) => a.symbol))
              try {
                await reconcileAccount(p, account, venue, db)
              } catch (e) {
                await halt(s, safeTradingError(e), db)
                throw e
              }
            }
            const markets = await loadMarkets(
              s,
              venue,
              (await agents(s, db)).map((a) => a.symbol),
              db,
            )
            await query(
              "UPDATE trading_portfolios SET checked_at=now(),check_error='' WHERE mode=$1 AND exchange=$2",
              [mode, exchange],
              db,
            )
            const priced = await mark(p, markets, db)
            if (!priced)
              await query(
                'UPDATE trading_portfolios SET check_error=$3 WHERE exchange=$1 AND mode=$2',
                [exchange, mode, 'TRADING_POSITION_UNPRICED'],
                db,
              )
            p = await portfolio(s, db)
            if (p.status !== 'running' && p.status !== 'paused') return
            if (mode === 'live' && p.status === 'running') await promoteLive(exchange, db)
            const forceExit =
              ['DAILY_LOSS_LIMIT', 'DRAWDOWN_LIMIT', 'OWNER_EXIT'].includes(p.reason) ||
              p.demo_probe
            for (const agent of await agents(s, db)) {
              if (isStopping() || (await pendingOrder(s, db))) break
              const market = markets[agent.symbol]
              if (!market) continue
              let decision = signal(
                agent,
                market,
                forceExit && BigInt(agent.base) >= market.instrument.minQty,
              )
              if (BigInt(agent.base) && BigInt(agent.base) < market.instrument.minQty)
                decision = { side: null, reason: 'SCOUT_DUST_POSITION' }
              if (
                BigInt(agent.base) >= market.instrument.minQty &&
                !['RISK_EXIT', 'POSITION_STOP'].includes(decision.reason) &&
                (mode !== 'live' || agent.selector_version === S.version) &&
                agent.position_opened_at
              ) {
                const age = Date.now() - agent.position_opened_at.getTime()
                if (age >= S.maxPositionMs) decision = { side: 'sell', reason: 'SCOUT_TIME_EXIT' }
                else if (
                  age >= S.stagnantPositionMs &&
                  scoutFresh(scout) &&
                  !admitted(scout, agent.symbol)
                )
                  decision = { side: 'sell', reason: 'SCOUT_STAGNANT_EXIT' }
              }
              if (!BigInt(agent.base) && (!scoutFresh(scout) || !admitted(scout, agent.symbol)))
                decision = { side: null, reason: 'SCOUT_WAITING' }
              if (
                mode === 'demo' &&
                p.demo_probe &&
                !agent.round_trips &&
                BigInt(agent.base) < market.instrument.minQty
              )
                decision = { side: 'buy', reason: 'DEMO_PROBE' }
              if (mode === 'demo' && p.demo_probe && agent.round_trips > 0) {
                await query(
                  "UPDATE trading_portfolios SET status='paused',reason='DEMO_PROBE_COMPLETE',demo_probe=false WHERE mode='demo' AND exchange=$1",
                  [exchange],
                  db,
                )
                await event(s, 'demo', 'DEMO_PROBE_COMPLETE', {}, db)
                break
              }
              await query(
                'UPDATE trading_agents SET last_signal=$2 WHERE id=$1',
                [agent.id, decision.reason],
                db,
              )
              if (!decision.side || (p.status === 'paused' && decision.side === 'buy')) continue
              if (decision.side === 'buy' && (!priced || !admitted(scout, agent.symbol))) continue
              if (
                decision.side === 'buy' &&
                mode !== 'paper' &&
                (!Number.isSafeInteger(account?.feeBps[agent.symbol]) ||
                  account!.feeBps[agent.symbol]! > P.maxFeeBps)
              )
                throw new Error('TRADING_FEE_UNKNOWN')
              const urgent =
                decision.side === 'sell' && ['RISK_EXIT', 'POSITION_STOP'].includes(decision.reason)
              if (
                !urgent &&
                agent.last_order_at &&
                Date.now() - agent.last_order_at.getTime() < P.cooldownMs
              )
                continue
              const request = sizeOrder(
                agent,
                market,
                decision.side,
                randomUUID().replaceAll('-', ''),
                decision.maxQty,
              )
              if (request) await submit(p, agent, request, decision.reason, markets, venue, db)
              else
                await query(
                  'UPDATE trading_agents SET last_signal=$2 WHERE id=$1',
                  [
                    agent.id,
                    decision.side === 'sell' ? 'SCOUT_DUST_POSITION' : 'SCOUT_ORDER_TOO_SMALL',
                  ],
                  db,
                )
            }
            if (mode === 'paper' && p.status === 'running') await evolve(exchange, db)
          })
        } catch (error) {
          const reason = safeTradingError(error)
          if (reason === 'TRADING_BUSY') continue
          await query(
            'UPDATE trading_portfolios SET check_error=$2 WHERE mode=$1 AND exchange=$3',
            [mode, reason, s.exchange],
          )
        }
      }
    }),
  )
}

export async function checkTrading(s: TradingScope, factory: VenueFactory = venues) {
  const { mode, exchange } = s
  await ensurePortfolios()
  return withTradingLock(s, async (db) => {
    const venue = factory(s)
    try {
      const p = await portfolio(s, db)
      const team = await agents(s, db)
      const scout = await refreshScout(
        s,
        venue,
        team.map((a) => a.symbol),
        db,
        true,
      )
      const symbols = (team.length ? team : seedPlan(s, scout)).map((a) => a.symbol)
      if (mode !== 'paper') {
        if (await pendingOrder(s, db)) throw new Error('TRADING_ORDER_UNKNOWN')
        await reconcileAccount(p, await venue.account(symbols), venue, db)
      }
      const markets = await loadMarkets(s, venue, symbols, db)
      if (symbols.some((symbol) => !markets[symbol])) throw new Error('TRADING_STALE_MARKET')
      if (!scoutFresh(scout)) throw new Error(scout?.error || 'TRADING_CATALOG_INVALID')
      await query(
        "UPDATE trading_portfolios SET checked_at=now(),check_error='' WHERE mode=$1 AND exchange=$2",
        [mode, exchange],
        db,
      )
      await event(s, 'connection', 'CONNECTION_OK', {}, db)
    } catch (error) {
      const reason = safeTradingError(error)
      await query(
        'UPDATE trading_portfolios SET check_error=$2 WHERE mode=$1 AND exchange=$3',
        [mode, reason, s.exchange],
        db,
      )
      throw new Error(reason)
    }
  })
}

export async function startTrading(
  s: TradingScope,
  confirmation: string,
  demoProbe = false,
  factory: VenueFactory = venues,
) {
  const { mode, exchange } = s
  await ensurePortfolios()
  return withTradingLock(s, async (db) => {
    const p = await portfolio(s, db)
    if (mode === 'live' && BigInt(p.capital) < units(String(P.minLiveCapitalUsdt)))
      throw new Error('TRADING_ALLOCATION_REQUIRED')
    let champion: AgentRow | undefined
    if (mode === 'live') {
      if (!config().TRADING_LIVE_ENABLED) throw new Error('TRADING_LIVE_DISABLED')
      if (confirmation !== liveConfirmation(p)) throw new Error('TRADING_CONFIRMATION_REQUIRED')
      const demo = await portfolio(scope(exchange, 'demo'), db)
      const demoTeam = await agents(scope(exchange, 'demo'), db)
      if (
        !demoTeam.some((a) => a.round_trips > 0) ||
        demo.check_error ||
        !demo.checked_at ||
        Date.now() - demo.checked_at.getTime() > 600_000
      )
        throw new Error('TRADING_DEMO_REQUIRED')
      champion = (await paperCandidates(exchange, db))[0]
      if (!champion) throw new Error('TRADING_PAPER_REQUIRED')
    }
    const venue = factory(s)
    if (p.status === 'running') return
    if (await pendingOrder(s, db)) throw new Error('TRADING_ORDER_UNKNOWN')
    const teamBefore = await agents(s, db)
    const scout = await refreshScout(
      s,
      venue,
      teamBefore.map((a) => a.symbol),
      db,
      true,
    )
    if (!scoutFresh(scout)) throw new Error(scout?.error || 'TRADING_CATALOG_INVALID')
    const symbols = (teamBefore.length ? teamBefore : seedPlan(s, scout, champion)).map(
      (a) => a.symbol,
    )
    if (mode !== 'paper' && !symbols.length) throw new Error('TRADING_NO_CANDIDATES')
    let account: Account | undefined
    if (mode !== 'paper') {
      account = await venue.account(symbols)
      await reconcileAccount(p, account, venue, db)
    }
    const markets = await loadMarkets(s, venue, symbols, db)
    if (symbols.some((symbol) => !markets[symbol])) throw new Error('TRADING_STALE_MARKET')
    await atomic(db, async () => {
      const current = await portfolio(s, db, true)
      // A stop pressed while the external checks were running wins over this start request.
      if (
        current.status !== p.status ||
        current.reason !== p.reason ||
        current.capital !== p.capital
      )
        throw new Error('TRADING_CONTROL_CHANGED')
      await seedAgents(s, db, scout, champion)
      const team = await agents(s, db)
      const equity = team.reduce(
        (sum, a) => sum + markAgent(a, markets[a.symbol]?.book.bids[0]![0] || 0n).equity,
        team.length ? 0n : BigInt(p.capital),
      )
      if (riskReason(equity, BigInt(current.peak), BigInt(current.day_equity)) === 'DRAWDOWN_LIMIT')
        throw new Error('TRADING_DRAWDOWN_LOCKED')
      if (
        current.risk_day === new Date().toISOString().slice(0, 10) &&
        riskReason(equity, BigInt(current.peak), BigInt(current.day_equity))
      )
        throw new Error('TRADING_DAILY_LOCKED')
      if (account && !p.account_identity)
        await query(
          'UPDATE trading_portfolios SET account_identity=$2,quote_offset=$3 WHERE mode=$1 AND exchange=$4',
          [
            mode,
            account.identity,
            (account.balances.USDT.total - BigInt(p.capital)).toString(),
            exchange,
          ],
          db,
        )
      await query(
        "UPDATE trading_portfolios SET status='running',reason='',started_at=coalesce(started_at,now()),checked_at=now(),check_error='',last_tick=NULL,demo_probe=$2 WHERE mode=$1 AND exchange=$3",
        [mode, mode === 'demo' && demoProbe, exchange],
        db,
      )
      await event(
        s,
        'start',
        mode === 'live' ? 'LIVE_AUTHORIZED' : 'STARTED',
        { policy: P.version, capital: decimal(BigInt(p.capital)) },
        db,
      )
    })
  })
}

export async function controlTrading(s: TradingScope, action: 'pause' | 'stop' | 'flatten') {
  const { mode, exchange } = s
  await ensurePortfolios()
  const status = action === 'stop' ? 'stopped' : 'paused'
  const reason =
    action === 'stop' ? 'OWNER_STOP' : action === 'flatten' ? 'OWNER_EXIT' : 'OWNER_PAUSE'
  // This intentionally does not wait for the worker's session lock or a slow exchange.
  await query('UPDATE trading_portfolios SET status=$2,reason=$3 WHERE mode=$1 AND exchange=$4', [
    mode,
    status,
    reason,
    exchange,
  ])
  await event(s, action, reason)
}

export async function stopAllTrading() {
  await ensurePortfolios()
  await transaction(async (db) => {
    await query(
      'SELECT mode FROM trading_portfolios ORDER BY exchange,mode FOR NO KEY UPDATE',
      [],
      db,
    )
    await query("UPDATE trading_portfolios SET status='stopped',reason='OWNER_STOP'", [], db)
    for (const exchange of exchanges)
      for (const mode of modes) await event(scope(exchange, mode), 'stop', 'OWNER_STOP', {}, db)
  })
}

export async function resolveMissingOrder(
  s: TradingScope,
  clientId: string,
  confirmation: string,
  factory: VenueFactory = venues,
) {
  const { mode } = s
  if (mode === 'paper' || confirmation !== 'ПРОВЕРЕНО НА БИРЖЕ')
    throw new Error('TRADING_CONFIRMATION_REQUIRED')
  return withTradingLock(s, async (db) => {
    const p = await portfolio(s, db)
    const row = await pendingOrder(s, db)
    if (
      p.status !== 'stopped' ||
      !row ||
      row.client_id !== clientId ||
      row.status !== 'unknown' ||
      Date.now() - row.created_at.getTime() < 60_000
    )
      throw new Error('TRADING_REVIEW_NOT_READY')
    const venue = factory(s)
    if (await venue.order(requestFor(row))) throw new Error('TRADING_ORDER_EXISTS')
    await reconcileAccount(
      p,
      await venue.account((await agents(s, db)).map((a) => a.symbol)),
      venue,
      db,
    )
    await atomic(db, async () => {
      await query(
        "UPDATE trading_orders SET status='rejected',reason='OWNER_VERIFIED_ABSENT',settled_at=now() WHERE id=$1",
        [row.id],
        db,
      )
      await event(s, 'manual_review', 'OWNER_VERIFIED_ABSENT', { clientId }, db)
    })
  })
}
