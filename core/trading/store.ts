import { randomUUID } from 'node:crypto'
import { pool, query, transaction, type Connection } from '../db'
import { TRADING_POLICY as P } from '../policy'
import { units } from './decimal'
import { eligible, fitness, seeds } from './strategy'
import { markAgent } from './accounting'
import {
  exchanges,
  type AgentRow,
  type OrderRequest,
  type OrderRow,
  type PortfolioRow,
  type TradingMode,
  type TradingScope,
  type TradingExchange,
} from './types'

export const modes: TradingMode[] = ['paper', 'demo', 'live']
export const unresolved = "('prepared','submitted','unknown')"
export const scope = (exchange: TradingExchange, mode: TradingMode): TradingScope => ({
  exchange,
  mode,
})
export const scopeKey = (s: TradingScope) => `${s.exchange}:${s.mode}`

export async function ensurePortfolios(db: Connection = pool) {
  await query(
    `INSERT INTO trading_portfolios(exchange,mode,capital,peak,day_equity)
    SELECT e,m,amount,amount,amount FROM unnest($1::text[]) e
    CROSS JOIN unnest($2::text[]) m
    CROSS JOIN LATERAL (SELECT CASE WHEN m='live' AND e<>'okx' THEN 0 ELSE $3::numeric END AS amount) allocation
    ON CONFLICT DO NOTHING`,
    [exchanges, modes, units(String(P.defaultCapitalUsdt)).toString()],
    db,
  )
}

/** Independent session locks fence each exchange/mode across workers and owner requests. */
export async function withTradingLock<T>(
  s: TradingScope,
  fn: (db: Connection) => Promise<T>,
): Promise<T> {
  const db = await pool.connect()
  let locked = false,
    broken = false
  try {
    const [row] = await query(
      'SELECT pg_try_advisory_lock(735093,hashtext($1)) AS locked',
      [scopeKey(s)],
      db,
    )
    locked = !!row?.locked
    if (!locked) throw new Error('TRADING_BUSY')
    return await fn(db)
  } finally {
    if (locked)
      try {
        await query('SELECT pg_advisory_unlock(735093,hashtext($1))', [scopeKey(s)], db)
      } catch {
        broken = true
      }
    db.release(broken)
  }
}

export async function atomic<T>(db: Connection, fn: () => Promise<T>): Promise<T> {
  await query('BEGIN', [], db)
  try {
    const result = await fn()
    await query('COMMIT', [], db)
    return result
  } catch (error) {
    await query('ROLLBACK', [], db)
    throw error
  }
}

export async function portfolio(s: TradingScope, db: Connection = pool, lock = false) {
  const [row] = await query<PortfolioRow>(
    `SELECT * FROM trading_portfolios WHERE exchange=$1 AND mode=$2${lock ? ' FOR UPDATE' : ''}`,
    [s.exchange, s.mode],
    db,
  )
  if (!row) throw new Error('TRADING_PORTFOLIO_NOT_FOUND')
  return row
}
export async function agents(s: TradingScope, db: Connection = pool) {
  return query<AgentRow>(
    "SELECT * FROM trading_agents WHERE exchange=$1 AND mode=$2 AND status='active' ORDER BY created_at,id",
    [s.exchange, s.mode],
    db,
  )
}
export async function pendingOrder(s: TradingScope, db: Connection = pool) {
  return (
    await query<OrderRow>(
      `SELECT * FROM trading_orders WHERE exchange=$1 AND mode=$2 AND status IN ${unresolved}`,
      [s.exchange, s.mode],
      db,
    )
  )[0]
}

/** Each venue must establish its own evidence. Last-generation parents survive a selection. */
export async function paperCandidates(exchange: TradingExchange, db: Connection = pool) {
  const p = await portfolio(scope(exchange, 'paper'), db)
  if (p.check_error || !p.checked_at || Date.now() - p.checked_at.getTime() > 600_000) return []
  const candidates = await query<AgentRow>(
    "SELECT * FROM trading_agents WHERE exchange=$1 AND mode='paper' AND generation >= $2",
    [exchange, Math.max(1, p.generation - 1)],
    db,
  )
  const prices = await query<{ symbol: string; bid: string; at: Date }>(
    "SELECT * FROM trading_markets WHERE exchange=$1 AND mode='paper'",
    [exchange],
    db,
  )
  return candidates
    .filter((a) => {
      if (!eligible(a)) return false
      const price = prices.find((m) => m.symbol === a.symbol)
      return (
        !!price &&
        Date.now() - price.at.getTime() <= 90_000 &&
        markAgent(a, BigInt(price.bid)).equity > BigInt(a.initial_cash)
      )
    })
    .sort((a, b) => fitness(b) - fitness(a))
}
export function requestFor(row: OrderRow): OrderRequest {
  return {
    clientId: row.client_id,
    symbol: row.symbol,
    side: row.side,
    qty: BigInt(row.qty),
    price: BigInt(row.price),
  }
}
export async function event(
  s: TradingScope,
  kind: string,
  reason: string,
  data: Record<string, unknown> = {},
  db: Connection = pool,
) {
  await query(
    'INSERT INTO trading_events(exchange,mode,kind,reason,data) VALUES ($1,$2,$3,$4,$5)',
    [s.exchange, s.mode, kind, reason, data],
    db,
  )
}
export async function seedAgents(s: TradingScope, db: Connection, champion?: AgentRow) {
  if ((await agents(s, db)).length) return
  if (champion && champion.exchange !== s.exchange) throw new Error('TRADING_EXCHANGE_MISMATCH')
  const choices = s.mode === 'paper' ? seeds : [champion || seeds[0]!]
  const p = await portfolio(s, db)
  const capital = BigInt(p.capital) / BigInt(choices.length)
  for (const seed of choices)
    await query(
      `INSERT INTO trading_agents(id,exchange,mode,name,symbol,kind,params,generation,initial_cash,cash,peak,parent_id) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$8,$8,$9)`,
      [
        randomUUID(),
        s.exchange,
        s.mode,
        seed.name,
        seed.symbol,
        seed.kind,
        seed.params,
        capital.toString(),
        champion?.id || null,
      ],
      db,
    )
}

/** Initial funding plan only. Once activated, balances and risk history are immutable inputs. */
export async function allocateLive(amounts: Record<TradingExchange, number>) {
  for (const exchange of exchanges) {
    const value = amounts[exchange]
    if (!Number.isSafeInteger(value) || value < 0 || (value > 0 && value < P.minLiveCapitalUsdt))
      throw new Error('TRADING_ALLOCATION_INVALID')
  }
  await ensurePortfolios()
  await transaction(async (db) => {
    const rows = await query<PortfolioRow>(
      "SELECT * FROM trading_portfolios WHERE mode='live' ORDER BY exchange,mode FOR UPDATE",
      [],
      db,
    )
    for (const p of rows) {
      const amount = units(String(amounts[p.exchange])).toString()
      if (p.capital === amount) continue
      if (
        p.started_at ||
        p.account_identity ||
        (await agents(p, db)).length ||
        (await pendingOrder(p, db))
      )
        throw new Error('TRADING_ALLOCATION_LOCKED')
      await query(
        "UPDATE trading_portfolios SET capital=$2,peak=$2,day_equity=$2,checked_at=NULL,check_error='' WHERE exchange=$1 AND mode='live'",
        [p.exchange, amount],
        db,
      )
      await event(p, 'allocation', 'ALLOCATION_UPDATED', { capital: amounts[p.exchange] }, db)
    }
  })
}
