import { randomUUID } from 'node:crypto'
import { pool, query, type Connection } from '../db'
import { TRADING_POLICY as P } from '../policy'
import { units } from './decimal'
import { eligible, fitness, seeds } from './strategy'
import { markAgent } from './accounting'
import type { AgentRow, OrderRequest, OrderRow, PortfolioRow, TradingMode } from './types'

export const modes: TradingMode[] = ['paper', 'demo', 'live']
export const unresolved = "('prepared','submitted','unknown')"

export async function ensurePortfolios(db: Connection = pool) {
  await query(
    "INSERT INTO trading_portfolios(mode) VALUES ('paper'),('demo'),('live') ON CONFLICT DO NOTHING",
    [],
    db,
  )
}

/** Session locks protect the complete read / reserve / exchange / settle sequence across workers. */
export async function withTradingLock<T>(
  mode: TradingMode,
  fn: (db: Connection) => Promise<T>,
): Promise<T> {
  const db = await pool.connect()
  let locked = false
  let broken = false
  try {
    const [row] = await query(
      'SELECT pg_try_advisory_lock(735093,hashtext($1)) AS locked',
      [mode],
      db,
    )
    locked = !!row?.locked
    if (!locked) throw new Error('TRADING_BUSY')
    return await fn(db)
  } finally {
    if (locked) {
      try {
        await query('SELECT pg_advisory_unlock(735093,hashtext($1))', [mode], db)
      } catch {
        broken = true
      }
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

export async function portfolio(mode: TradingMode, db: Connection = pool, lock = false) {
  const [row] = await query<PortfolioRow>(
    `SELECT * FROM trading_portfolios WHERE mode=$1${lock ? ' FOR UPDATE' : ''}`,
    [mode],
    db,
  )
  if (!row) throw new Error('TRADING_PORTFOLIO_NOT_FOUND')
  return row
}
export async function agents(mode: TradingMode, db: Connection = pool) {
  return query<AgentRow>(
    "SELECT * FROM trading_agents WHERE mode=$1 AND status='active' ORDER BY created_at,id",
    [mode],
    db,
  )
}
export async function pendingOrder(mode: TradingMode, db: Connection = pool) {
  return (
    await query<OrderRow>(
      `SELECT * FROM trading_orders WHERE mode=$1 AND status IN ${unresolved}`,
      [mode],
      db,
    )
  )[0]
}

/** A finished parent remains admissible immediately after paper evolution archives it. */
export async function paperCandidates(db: Connection = pool) {
  const p = await portfolio('paper', db)
  if (p.check_error || !p.checked_at || Date.now() - p.checked_at.getTime() > 600_000) return []
  const candidates = await query<AgentRow>(
    "SELECT * FROM trading_agents WHERE mode='paper' AND generation >= $1",
    [Math.max(1, p.generation - 1)],
    db,
  )
  const prices = await query<{ symbol: string; bid: string; at: Date }>(
    "SELECT * FROM trading_markets WHERE mode='paper'",
    [],
    db,
  )
  return candidates
    .filter((a) => {
      if (!eligible(a)) return false
      const price = prices.find((m) => m.symbol === a.symbol)
      if (!price || Date.now() - price.at.getTime() > 90_000) return false
      return markAgent(a, BigInt(price.bid)).equity > BigInt(a.initial_cash)
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
  mode: TradingMode,
  kind: string,
  reason: string,
  data: Record<string, unknown> = {},
  db: Connection = pool,
) {
  await query(
    'INSERT INTO trading_events(mode,kind,reason,data) VALUES ($1,$2,$3,$4)',
    [mode, kind, reason, data],
    db,
  )
}

export async function seedAgents(mode: TradingMode, db: Connection, champion?: AgentRow) {
  if ((await agents(mode, db)).length) return
  const choices = mode === 'paper' ? seeds : [champion || seeds[0]!]
  const capital = units(String(P.capitalUsdt)) / BigInt(choices.length)
  for (const seed of choices) {
    await query(
      `INSERT INTO trading_agents(id,mode,name,symbol,kind,params,generation,initial_cash,cash,peak,parent_id)
      VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7,$7,$8)`,
      [
        randomUUID(),
        mode,
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
}
