import { query, type Connection, pool } from '../db'
import { SCOUT_POLICY as S } from '../policy'
import { validateMarket } from './strategy'
import { inspectCandidate, screen, type ScoutCoin } from './universe'
import type { TradingScope, TradingSymbol, TradingVenue } from './types'

export type ScoutRow = {
  exchange: TradingScope['exchange']
  mode: TradingScope['mode']
  policy_version: string
  scanned_at: Date | null
  attempted_at: Date
  error: string
  coins: ScoutCoin[]
}
export async function scoutState(s: TradingScope, db: Connection = pool) {
  return (
    await query<ScoutRow>(
      'SELECT * FROM trading_scouts WHERE exchange=$1 AND mode=$2',
      [s.exchange, s.mode],
      db,
    )
  )[0]
}
export function scoutFresh(s: ScoutRow | undefined, now = Date.now()) {
  return (
    !!s &&
    s.policy_version === S.version &&
    !s.error &&
    !!s.scanned_at &&
    now - s.scanned_at.getTime() <= S.freshMs
  )
}
export function admitted(s: ScoutRow | undefined, symbol: TradingSymbol) {
  return scoutFresh(s) && !!s!.coins.find((c) => c.symbol === symbol && c.eligible)
}
const safeError = (e: unknown) =>
  e instanceof Error && /^TRADING_[A-Z_]+$/.test(e.message) ? e.message : 'TRADING_RESPONSE_INVALID'

/** Called under the portfolio lock. A failed refresh preserves the last successful report. */
export async function refreshScout(
  s: TradingScope,
  venue: TradingVenue,
  active: TradingSymbol[],
  db: Connection,
  force = false,
) {
  let saved = await scoutState(s, db)
  const interval = saved?.error ? S.retryMs : S.scanMs
  if (
    !force &&
    saved?.policy_version === S.version &&
    Date.now() - saved.attempted_at.getTime() < interval
  )
    return saved
  await query(
    `INSERT INTO trading_scouts(exchange,mode,policy_version) VALUES($1,$2,$3)
    ON CONFLICT(exchange,mode) DO UPDATE SET attempted_at=now()`,
    [s.exchange, s.mode, S.version],
    db,
  )
  try {
    const started = new Date()
    const listings = await venue.discover()
    if (
      !listings.length ||
      listings.length > 10_000 ||
      new Set(listings.map((c) => c.symbol)).size !== listings.length
    )
      throw new Error('TRADING_CATALOG_INVALID')
    const coins = listings
      .map((c) => screen(c))
      .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    const suitable = coins.filter((c) => c.reason === 'SCOUT_ON_RADAR')
    const previousChecks = new Map(saved?.coins.map((c) => [c.symbol, c.inspectedAt]) || [])
    for (const coin of coins) coin.inspectedAt = previousChecks.get(coin.symbol) || null
    // Keep current pairs and leaders fresh while giving the rest of the catalogue a turn.
    // A permanently quiet top twelve must not starve every lower-ranked moving coin.
    const priority = [...suitable.filter((c) => active.includes(c.symbol)), ...suitable.slice(0, 4)]
    const remaining = suitable
      .filter((c) => !priority.includes(c))
      .sort((a, b) => (a.inspectedAt || 0) - (b.inspectedAt || 0) || b.score - a.score)
    const investigate = [...new Set([...priority, ...remaining])].slice(0, S.maxCandidates)
    // Bounded concurrency keeps the broad scan to two bulk calls plus at most 12 detailed checks.
    let next = 0
    await Promise.all(
      [0, 1].map(async () => {
        while (next < investigate.length) {
          const coin = investigate[next++]!
          coin.inspectedAt = Date.now()
          try {
            const market = await venue.market(coin.symbol)
            validateMarket(market)
            if (market.instrument.symbol !== coin.symbol)
              throw new Error('TRADING_INSTRUMENT_INVALID')
            coin.reason = inspectCandidate(coin, market)
          } catch (error) {
            coin.reason = safeError(error)
          }
        }
      }),
    )
    if (investigate.length && investigate.every((c) => c.reason.startsWith('TRADING_')))
      throw new Error(investigate[0]!.reason)
    coins.sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        b.score - a.score ||
        a.symbol.localeCompare(b.symbol),
    )
    await query(
      `UPDATE trading_scouts SET policy_version=$3,scanned_at=$4,error='',coins=$5 WHERE exchange=$1 AND mode=$2`,
      [s.exchange, s.mode, S.version, started, JSON.stringify(coins)],
      db,
    )
  } catch (error) {
    await query(
      'UPDATE trading_scouts SET error=$3 WHERE exchange=$1 AND mode=$2',
      [s.exchange, s.mode, safeError(error)],
      db,
    )
  }
  saved = await scoutState(s, db)
  return saved!
}
