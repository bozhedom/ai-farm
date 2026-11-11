import { query, type Connection } from '../db'
import { decimal } from './decimal'
import type { TradingScope } from './types'

/** Actual fill deltas only. Old events without accounting fields are not invented or backfilled. */
export async function executionStats(s: TradingScope, db?: Connection) {
  const [r] = await query(
    `SELECT
    count(*) FILTER (WHERE (data->>'qty')::numeric>0)::int AS fills,
    count(*) FILTER (WHERE data->>'side'='sell' AND (data->>'qty')::numeric>0)::int AS exits,
    count(*) FILTER (WHERE (data->>'realizedUsdt')::numeric>0)::int AS profitable_exits,
    count(*) FILTER (WHERE (data->>'realizedUsdt')::numeric<0)::int AS losing_exits,
    count(*) FILTER (WHERE (data->>'closedPosition')::boolean)::int AS closed_positions,
    coalesce(sum((data->>'realizedUsdt')::numeric*1e18),0)::numeric(78,0)::text AS realized,
    coalesce(sum((data->>'feeUsdt')::numeric*1e18),0)::numeric(78,0)::text AS fees,
    avg((data->>'holdingMs')::numeric) FILTER (WHERE data->>'side'='sell' AND (data->>'qty')::numeric>0)::bigint::text AS holding_ms,
    min(created_at) AS since
    FROM trading_events WHERE exchange=$1 AND mode=$2 AND kind='order_settled'
    AND data ? 'realizedUsdt' AND created_at>now()-interval '24 hours'`,
    [s.exchange, s.mode],
    db,
  )
  return {
    windowHours: 24,
    recordedSince: r!.since?.toISOString() ?? null,
    fills: r!.fills,
    exits: r!.exits,
    profitableExits: r!.profitable_exits,
    losingExits: r!.losing_exits,
    closedPositions: r!.closed_positions,
    realizedUsdt: decimal(BigInt(r!.realized)),
    feesUsdt: decimal(BigInt(r!.fees)),
    averageHoldingSeconds: r!.holding_ms === null ? null : Math.round(Number(r!.holding_ms) / 1000),
  }
}
