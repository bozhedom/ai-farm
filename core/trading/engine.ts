import { randomUUID } from 'node:crypto'
import { query, transaction, type Connection } from '../db'
import { config } from '../config'
import { TRADING_POLICY as P } from '../policy'
import { BPS, abs, cost, decimal, fee, max, proceeds, ratioBps, units } from './decimal'
import { applyFill, markAgent, paperFill, riskReason } from './accounting'
import { eligible, fitness, mutate, signal, sizeOrder, validateMarket } from './strategy'
import { OkxVenue, OrderRejected } from './okx'
import {
  agents,
  atomic,
  ensurePortfolios,
  event,
  modes,
  pendingOrder,
  paperCandidates,
  portfolio,
  requestFor,
  seedAgents,
  withTradingLock,
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

export type VenueFactory = (mode: TradingMode) => TradingVenue
const venues: VenueFactory = (mode) => new OkxVenue(mode)

export function safeTradingError(error: unknown) {
  return error instanceof Error && /^(TRADING_[A-Z_]+)$/.test(error.message)
    ? error.message
    : 'TRADING_RESPONSE_INVALID'
}

async function halt(mode: TradingMode, reason: string, db: Connection) {
  const p = await portfolio(mode, db)
  if (p.status !== 'stopped' || p.reason !== reason) {
    await query(
      "UPDATE trading_portfolios SET status='stopped',reason=$2 WHERE mode=$1",
      [mode, reason],
      db,
    )
    await event(mode, 'halt', reason, {}, db)
  }
}

async function loadMarkets(mode: TradingMode, venue: TradingVenue, db: Connection) {
  const markets = {} as Record<TradingSymbol, Market>
  for (const symbol of P.symbols) {
    const market = await venue.market(symbol)
    validateMarket(market)
    markets[symbol] = market
    await query(
      `INSERT INTO trading_markets(mode,symbol,at,bid,ask) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(mode,symbol) DO UPDATE SET at=excluded.at,bid=excluded.bid,ask=excluded.ask`,
      [
        mode,
        symbol,
        new Date(market.book.at),
        market.book.bids[0]![0].toString(),
        market.book.asks[0]![0].toString(),
      ],
      db,
    )
  }
  for (const symbol of P.symbols) validateMarket(markets[symbol])
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
  const team = await agents(p.mode, db)
  if (!p.account_identity) {
    if (account.balances.BTC.total || account.balances.ETH.total)
      throw new Error('TRADING_INITIAL_ASSETS')
    if (account.balances.USDT.available < BigInt(p.capital))
      throw new Error('TRADING_INSUFFICIENT_FUNDS')
    return
  }
  const expected = { USDT: BigInt(p.quote_offset), BTC: 0n, ETH: 0n }
  for (const agent of team) {
    expected.USDT += BigInt(agent.cash)
    expected[agent.symbol === 'BTC-USDT' ? 'BTC' : 'ETH'] += BigInt(agent.base)
  }
  for (const ccy of ['USDT', 'BTC', 'ETH'] as const) {
    const tolerance = units(ccy === 'USDT' ? '0.000001' : '0.000000000001')
    if (
      abs(account.balances[ccy].total - expected[ccy]) > tolerance ||
      account.balances[ccy].total - account.balances[ccy].available > tolerance
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
      `UPDATE trading_agents SET cash=$2,base=$3,basis=$4,realized=$5,fees=$6,round_trips=$7 WHERE id=$1`,
      [
        agent.id,
        fill.cash.toString(),
        fill.base.toString(),
        fill.basis.toString(),
        fill.realized.toString(),
        fill.fees.toString(),
        fill.roundTrips,
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
      row.mode,
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
async function recover(mode: TradingMode, venue: TradingVenue, db: Connection) {
  const row = await pendingOrder(mode, db)
  if (!row) return true
  if (row.status === 'prepared' || mode === 'paper') {
    await query(
      "UPDATE trading_orders SET status='canceled',reason='NOT_SENT',settled_at=now() WHERE id=$1",
      [row.id],
      db,
    )
    await event(mode, 'recovery', 'NOT_SENT', { clientId: row.client_id }, db)
    return true
  }
  const result = await venue.order(requestFor(row))
  if (!result) {
    await query("UPDATE trading_orders SET status='unknown' WHERE id=$1", [row.id], db)
    await halt(mode, 'TRADING_ORDER_UNKNOWN', db)
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
  const id = randomUUID()
  // The transaction reserves the only unresolved-order slot and fences concurrent owner stops.
  const row = await atomic(db, async () => {
    const current = await portfolio(p.mode, db, true)
    if (current.status !== 'running' && !(current.status === 'paused' && request.side === 'sell'))
      return null
    if (await pendingOrder(p.mode, db)) return null
    validateMarket(market)
    const team = await agents(p.mode, db)
    const fresh = team.find((a) => a.id === agent.id)
    if (!fresh || fresh.status !== 'active') return null
    if (request.side === 'buy') {
      const value = cost(request.qty, request.price)
      if (
        value + fee(value, P.maxFeeBps) > BigInt(fresh.cash) ||
        value > units(String(P.orderUsdt))
      )
        throw new Error('TRADING_ORDER_LIMIT')
      const [today] = await query(
        "SELECT count(*)::int AS count FROM trading_orders WHERE mode=$1 AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
        [p.mode],
        db,
      )
      if (today!.count >= P.maxOrdersPerDay) return null
      let invested = 0n,
        equity = 0n
      for (const member of team) {
        validateMarket(markets[member.symbol])
        const position = proceeds(BigInt(member.base), markets[member.symbol].book.bids[0]![0])
        invested += position
        equity += BigInt(member.cash) + position
      }
      const ceiling = equity < BigInt(current.capital) ? equity : BigInt(current.capital)
      if ((invested + value) * BPS > ceiling * BigInt(P.maxExposureBps)) return null
    } else if (request.qty > BigInt(fresh.base)) throw new Error('TRADING_ORDER_LIMIT')
    const [created] = await query<OrderRow>(
      `INSERT INTO trading_orders(id,mode,agent_id,client_id,symbol,side,qty,price,status,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9) RETURNING *`,
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
    const current = await portfolio(p.mode, db, true)
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
      await halt(p.mode, 'TRADING_ORDER_REJECTED', db)
      return
    }
    await query("UPDATE trading_orders SET status='unknown' WHERE id=$1", [row.id], db)
    await halt(p.mode, 'TRADING_ORDER_UNKNOWN', db)
    return
  }
  // Settlement happens on the next tick, after the exchange has made its fills visible.
}

async function mark(p: PortfolioRow, markets: Record<TradingSymbol, Market>, db: Connection) {
  const team = await agents(p.mode, db)
  let equity = 0n,
    exposure = 0n,
    cash = 0n
  for (const a of team) {
    const m = markAgent(a, markets[a.symbol].book.bids[0]![0])
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
    'SELECT equity FROM trading_equity WHERE mode=$1 ORDER BY at DESC LIMIT 1',
    [p.mode],
    db,
  )
  const dayEquity =
    p.risk_day === day ? BigInt(p.day_equity) : BigInt(previous?.equity || p.capital)
  const peak = max(BigInt(p.peak), equity)
  await query(
    'UPDATE trading_portfolios SET peak=$2,day_equity=$3,risk_day=$4 WHERE mode=$1',
    [p.mode, peak.toString(), dayEquity.toString(), day],
    db,
  )
  await query(
    'INSERT INTO trading_equity(mode,equity,cash,exposure) VALUES ($1,$2,$3,$4)',
    [p.mode, equity.toString(), cash.toString(), exposure.toString()],
    db,
  )
  const reason = riskReason(equity, peak, dayEquity)
  if (reason && (p.status === 'running' || p.status === 'paused')) {
    const changed = await query(
      "UPDATE trading_portfolios SET status='paused',reason=$2 WHERE mode=$1 AND status IN ('running','paused') AND (status <> 'paused' OR reason <> $2) RETURNING mode",
      [p.mode, reason],
      db,
    )
    if (changed.length) await event(p.mode, 'risk', reason, { equity: decimal(equity) }, db)
  }
}

async function evolve(db: Connection) {
  const p = await portfolio('paper', db)
  if (p.evolution_at && Date.now() - p.evolution_at.getTime() < 86_400_000) return
  const team = await agents('paper', db)
  let reason = 'COLLECTING_DATA'
  const enough =
    team.length === 4 &&
    team.every(
      (a) =>
        Date.now() - a.created_at.getTime() >= P.minEvaluationDays * 86_400_000 &&
        a.round_trips >= P.minRoundTrips,
    )
  if (enough) {
    const ranked = [...team].sort((a, b) => fitness(b) - fitness(a))
    if (team.some((a) => BigInt(a.base))) reason = 'POSITIONS_OPEN'
    else if (
      !eligible(ranked[0]!) ||
      !eligible(ranked[1]!) ||
      fitness(ranked[1]!) <= fitness(ranked[2]!)
    )
      reason = 'NO_PROVEN_EDGE'
    else {
      const evolved = await atomic(db, async () => {
        const locked = await portfolio('paper', db, true)
        if (locked.status !== 'running' || (await pendingOrder('paper', db))) return false
        const capital = team.reduce((s, a) => s + BigInt(a.cash), 0n)
        await query(
          "UPDATE trading_agents SET status='archived',archived_at=now() WHERE mode='paper' AND status='active'",
          [],
          db,
        )
        for (let i = 0; i < 4; i++) {
          const parent = ranked[i % 2]!
          const amount = capital / 4n + (i === 0 ? capital % 4n : 0n)
          const params = i < 2 ? parent.params : mutate(parent.params, p.generation + 1)
          await query(
            `INSERT INTO trading_agents(id,mode,name,symbol,kind,params,parent_id,generation,initial_cash,cash,peak)
            VALUES ($1,'paper',$2,$3,$4,$5,$6,$7,$8,$8,$8)`,
            [
              randomUUID(),
              `${parent.name.split(' · ')[0]} · ${p.generation + 1}${i < 2 ? '' : 'м'}`,
              parent.symbol,
              parent.kind,
              params,
              parent.id,
              p.generation + 1,
              amount.toString(),
            ],
            db,
          )
        }
        await query(
          "UPDATE trading_portfolios SET generation=generation+1 WHERE mode='paper'",
          [],
          db,
        )
        await event(
          'paper',
          'evolution',
          'LEADERS_CLONED',
          { parents: ranked.slice(0, 2).map((a) => a.id), generation: p.generation + 1 },
          db,
        )
        return true
      })
      if (evolved) reason = 'LEADERS_CLONED'
    }
  }
  await query(
    "UPDATE trading_portfolios SET evolution_at=now(),evolution_reason=$1 WHERE mode='paper'",
    [reason],
    db,
  )
}

/** Reallocate the live slot only while completely in cash, preserving the account risk history. */
async function promoteLive(db: Connection) {
  const p = await portfolio('live', db)
  if (p.evolution_at && Date.now() - p.evolution_at.getTime() < 86_400_000) return
  const [current] = await agents('live', db)
  const candidate = (await paperCandidates(db))[0]
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
        const locked = await portfolio('live', db, true)
        if (locked.status !== 'running' || (await pendingOrder('live', db))) return false
        await query(
          "UPDATE trading_agents SET status='archived',archived_at=now() WHERE id=$1",
          [current.id],
          db,
        )
        await query(
          `INSERT INTO trading_agents(id,mode,name,symbol,kind,params,parent_id,generation,initial_cash,cash,peak)
          VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,$8,$8)`,
          [
            randomUUID(),
            candidate.name,
            candidate.symbol,
            candidate.kind,
            candidate.params,
            candidate.id,
            p.generation + 1,
            current.cash,
          ],
          db,
        )
        await query(
          "UPDATE trading_portfolios SET generation=generation+1 WHERE mode='live'",
          [],
          db,
        )
        await event(
          'live',
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
    "UPDATE trading_portfolios SET evolution_at=now(),evolution_reason=$1 WHERE mode='live'",
    [reason],
    db,
  )
}

export async function tradingTick(factory: VenueFactory = venues, isStopping = () => false) {
  await ensurePortfolios()
  for (const mode of modes) {
    if (isStopping()) break
    try {
      await withTradingLock(mode, async (db) => {
        let p = await portfolio(mode, db)
        await query('UPDATE trading_portfolios SET heartbeat=now() WHERE mode=$1', [mode], db)
        if (!p.started_at || (p.last_tick && Date.now() - p.last_tick.getTime() < P.tickMs)) return
        await query('UPDATE trading_portfolios SET last_tick=now() WHERE mode=$1', [mode], db)
        const venue = factory(mode)
        if (!(await recover(mode, venue, db))) return
        if (mode !== 'paper') {
          const account = await venue.account()
          try {
            await reconcileAccount(p, account, venue, db)
          } catch (e) {
            await halt(mode, safeTradingError(e), db)
            throw e
          }
        }
        const markets = await loadMarkets(mode, venue, db)
        await query(
          "UPDATE trading_portfolios SET checked_at=now(),check_error='' WHERE mode=$1",
          [mode],
          db,
        )
        await mark(p, markets, db)
        p = await portfolio(mode, db)
        if (p.status !== 'running' && p.status !== 'paused') return
        if (mode === 'live' && p.status === 'running') await promoteLive(db)
        const forceExit =
          ['DAILY_LOSS_LIMIT', 'DRAWDOWN_LIMIT', 'OWNER_EXIT'].includes(p.reason) || p.demo_probe
        for (const agent of await agents(mode, db)) {
          if (isStopping() || (await pendingOrder(mode, db))) break
          const market = markets[agent.symbol]
          let decision = signal(
            agent,
            market,
            forceExit && BigInt(agent.base) >= market.instrument.minQty,
          )
          if (
            mode === 'demo' &&
            p.demo_probe &&
            !agent.round_trips &&
            BigInt(agent.base) < market.instrument.minQty
          )
            decision = { side: 'buy', reason: 'DEMO_PROBE' }
          if (mode === 'demo' && p.demo_probe && agent.round_trips > 0) {
            await query(
              "UPDATE trading_portfolios SET status='paused',reason='DEMO_PROBE_COMPLETE',demo_probe=false WHERE mode='demo'",
              [],
              db,
            )
            await event(mode, 'demo', 'DEMO_PROBE_COMPLETE', {}, db)
            break
          }
          await query(
            'UPDATE trading_agents SET last_signal=$2 WHERE id=$1',
            [agent.id, decision.reason],
            db,
          )
          if (!decision.side || (p.status === 'paused' && decision.side === 'buy')) continue
          const urgent =
            decision.side === 'sell' && ['RISK_EXIT', 'POSITION_STOP'].includes(decision.reason)
          if (
            !urgent &&
            agent.last_order_at &&
            Date.now() - agent.last_order_at.getTime() < P.cooldownMs
          )
            continue
          const request = sizeOrder(agent, market, decision.side, randomUUID().replaceAll('-', ''))
          if (request) await submit(p, agent, request, decision.reason, markets, venue, db)
        }
        if (mode === 'paper' && p.status === 'running') await evolve(db)
      })
    } catch (error) {
      const reason = safeTradingError(error)
      if (reason === 'TRADING_BUSY') continue
      await query('UPDATE trading_portfolios SET check_error=$2 WHERE mode=$1', [mode, reason])
    }
  }
}

export async function checkTrading(mode: TradingMode, factory: VenueFactory = venues) {
  await ensurePortfolios()
  return withTradingLock(mode, async (db) => {
    const venue = factory(mode)
    try {
      const p = await portfolio(mode, db)
      if (mode !== 'paper') {
        if (await pendingOrder(mode, db)) throw new Error('TRADING_ORDER_UNKNOWN')
        await reconcileAccount(p, await venue.account(), venue, db)
      }
      await loadMarkets(mode, venue, db)
      await query(
        "UPDATE trading_portfolios SET checked_at=now(),check_error='' WHERE mode=$1",
        [mode],
        db,
      )
      await event(mode, 'connection', 'CONNECTION_OK', {}, db)
    } catch (error) {
      const reason = safeTradingError(error)
      await query('UPDATE trading_portfolios SET check_error=$2 WHERE mode=$1', [mode, reason], db)
      throw new Error(reason)
    }
  })
}

export async function startTrading(
  mode: TradingMode,
  confirmation: string,
  demoProbe = false,
  factory: VenueFactory = venues,
) {
  await ensurePortfolios()
  return withTradingLock(mode, async (db) => {
    let champion: AgentRow | undefined
    if (mode === 'live') {
      if (!config().TRADING_LIVE_ENABLED) throw new Error('TRADING_LIVE_DISABLED')
      if (confirmation !== 'ТОРГОВАТЬ 100 USDT') throw new Error('TRADING_CONFIRMATION_REQUIRED')
      const demo = await portfolio('demo', db)
      const demoTeam = await agents('demo', db)
      if (
        !demoTeam.some((a) => a.round_trips > 0) ||
        demo.check_error ||
        !demo.checked_at ||
        Date.now() - demo.checked_at.getTime() > 600_000
      )
        throw new Error('TRADING_DEMO_REQUIRED')
      champion = (await paperCandidates(db))[0]
      if (!champion) throw new Error('TRADING_PAPER_REQUIRED')
    }
    const venue = factory(mode)
    const p = await portfolio(mode, db)
    if (p.status === 'running') return
    if (await pendingOrder(mode, db)) throw new Error('TRADING_ORDER_UNKNOWN')
    let account: Account | undefined
    if (mode !== 'paper') {
      account = await venue.account()
      await reconcileAccount(p, account, venue, db)
    }
    const markets = await loadMarkets(mode, venue, db)
    await atomic(db, async () => {
      const current = await portfolio(mode, db, true)
      // A stop pressed while the external checks were running wins over this start request.
      if (current.status !== p.status || current.reason !== p.reason)
        throw new Error('TRADING_CONTROL_CHANGED')
      await seedAgents(mode, db, champion)
      const team = await agents(mode, db)
      const equity = team.reduce(
        (sum, a) => sum + markAgent(a, markets[a.symbol].book.bids[0]![0]).equity,
        0n,
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
          'UPDATE trading_portfolios SET account_identity=$2,quote_offset=$3 WHERE mode=$1',
          [mode, account.identity, (account.balances.USDT.total - BigInt(p.capital)).toString()],
          db,
        )
      await query(
        "UPDATE trading_portfolios SET status='running',reason='',started_at=coalesce(started_at,now()),checked_at=now(),check_error='',last_tick=NULL,demo_probe=$2 WHERE mode=$1",
        [mode, mode === 'demo' && demoProbe],
        db,
      )
      await event(
        mode,
        'start',
        mode === 'live' ? 'LIVE_AUTHORIZED' : 'STARTED',
        { policy: P.version, capital: decimal(BigInt(p.capital)) },
        db,
      )
    })
  })
}

export async function controlTrading(mode: TradingMode, action: 'pause' | 'stop' | 'flatten') {
  await ensurePortfolios()
  const status = action === 'stop' ? 'stopped' : 'paused'
  const reason =
    action === 'stop' ? 'OWNER_STOP' : action === 'flatten' ? 'OWNER_EXIT' : 'OWNER_PAUSE'
  // This intentionally does not wait for the worker's session lock or a slow exchange.
  await query('UPDATE trading_portfolios SET status=$2,reason=$3 WHERE mode=$1', [
    mode,
    status,
    reason,
  ])
  await event(mode, action, reason)
}

export async function stopAllTrading() {
  await ensurePortfolios()
  await transaction(async (db) => {
    await query("UPDATE trading_portfolios SET status='stopped',reason='OWNER_STOP'", [], db)
    for (const mode of modes) await event(mode, 'stop', 'OWNER_STOP', {}, db)
  })
}

export async function resolveMissingOrder(
  mode: TradingMode,
  clientId: string,
  confirmation: string,
  factory: VenueFactory = venues,
) {
  if (mode === 'paper' || confirmation !== 'ПРОВЕРЕНО НА БИРЖЕ')
    throw new Error('TRADING_CONFIRMATION_REQUIRED')
  return withTradingLock(mode, async (db) => {
    const p = await portfolio(mode, db)
    const row = await pendingOrder(mode, db)
    if (
      p.status !== 'stopped' ||
      !row ||
      row.client_id !== clientId ||
      row.status !== 'unknown' ||
      Date.now() - row.created_at.getTime() < 60_000
    )
      throw new Error('TRADING_REVIEW_NOT_READY')
    const venue = factory(mode)
    if (await venue.order(requestFor(row))) throw new Error('TRADING_ORDER_EXISTS')
    await reconcileAccount(p, await venue.account(), venue, db)
    await atomic(db, async () => {
      await query(
        "UPDATE trading_orders SET status='rejected',reason='OWNER_VERIFIED_ABSENT',settled_at=now() WHERE id=$1",
        [row.id],
        db,
      )
      await event(mode, 'manual_review', 'OWNER_VERIFIED_ABSENT', { clientId }, db)
    })
  })
}
