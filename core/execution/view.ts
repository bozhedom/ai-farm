import { query } from '../db'
import { decimal, units } from '../trading/decimal'
import type { ExecutionView } from '../contracts/execution'
import { executionReady } from './config'
import { ensureExecution, portfolio } from './store'
import type { ExecutionLeg, ExecutionMode, ExecutionOperation, ExecutionTrack } from './types'

export async function executionView(
  track: ExecutionTrack,
  mode: ExecutionMode,
): Promise<ExecutionView> {
  await ensureExecution()
  const p = await portfolio(track, mode)
  const [operations, legs, events, network] = await Promise.all([
    query<ExecutionOperation>(
      'SELECT * FROM execution_operations WHERE track=$1 AND mode=$2 ORDER BY created_at DESC LIMIT 30',
      [track, mode],
    ),
    query<ExecutionLeg>(
      'SELECT l.* FROM execution_legs l JOIN execution_operations o ON o.id=l.operation_id WHERE o.track=$1 AND o.mode=$2 ORDER BY l.created_at DESC LIMIT 80',
      [track, mode],
    ),
    query<{ id: string; code: string; created_at: Date }>(
      'SELECT id,code,created_at FROM execution_events WHERE track=$1 AND mode=$2 ORDER BY id DESC LIMIT 30',
      [track, mode],
    ),
    query<{ asset: string; amount: string }>(
      "SELECT l.receipt->'networkFee'->>'asset' asset,sum((l.receipt->'networkFee'->>'amount')::numeric)::text amount FROM execution_legs l JOIN execution_operations o ON o.id=l.operation_id WHERE o.track=$1 AND o.mode=$2 AND l.receipt->'networkFee' IS NOT NULL GROUP BY 1",
      [track, mode],
    ),
  ])
  // Deliberate allowlist: signed raw transactions, request payloads, key IDs and account pins stay private.
  return {
    track,
    mode,
    status: p.status,
    currency: track === 'defi' ? 'USDC' : track === 'prediction' ? 'USD' : 'USDT',
    capital: decimal(units(p.capital)),
    available: decimal(units(p.cash)),
    equity: decimal(units(p.equity)),
    realized: decimal(units(p.realized)),
    fees: decimal(units(p.fees)),
    networkFees: network,
    settings: p.settings,
    activated: !!p.started_at,
    reason: p.reason,
    readiness: executionReady(track, mode),
    workerAlive: !p.started_at || Date.now() - (p.heartbeat || p.started_at).getTime() < 90_000,
    heartbeat: p.heartbeat?.toISOString() || null,
    closeRequested: p.close_requested,
    operations: operations.map((o) => ({
      id: o.id,
      status: o.status,
      symbol: o.plan.symbol,
      quantity: o.plan.quantity,
      pnl: o.pnl,
      fees: o.fees,
      createdAt: o.created_at.toISOString(),
      closedAt: o.closed_at?.toISOString() || null,
    })),
    legs: legs.map((l) => ({
      id: l.id,
      operationId: l.operation_id,
      venue: l.prepared.intent.venue,
      action: l.prepared.intent.action,
      symbol: l.prepared.intent.symbol,
      state: l.state,
      quantity: l.prepared.intent.quantity,
      filled: l.receipt?.filledQuantity || '0',
      price: l.prepared.intent.limitPrice,
      quote: l.receipt?.grossQuote || '0',
      fee: l.receipt?.quoteFee || '0',
      externalId: l.receipt?.externalId || l.prepared.externalId,
      at: l.created_at.toISOString(),
    })),
    events: events.map((e) => ({ id: e.id, code: e.code, at: e.created_at.toISOString() })),
  }
}
