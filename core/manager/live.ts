import { createHash } from 'node:crypto'
import { config } from '../config'
import { query, transaction, type Connection } from '../db'
import { MANAGER_POLICY as P, SCOUT_POLICY } from '../policy'
import { directionAllowed } from '../work-focus'
import { decimal, proceeds, units } from '../trading/decimal'
import { agents, event, pendingOrder, portfolio, scope } from '../trading/store'
import { scoutFresh, scoutState } from '../trading/scout'
import { ownerEntryReason, tradingInstructions } from '../trading/owner-rules'
import type { AgentRow, TradingScope } from '../trading/types'
import { livePlanSchema, liveCritiqueSchema, type LivePlan } from './live-plan'

export const bybitScope = scope('bybit', 'live')
export function strategyFingerprint(a: AgentRow) {
  // The scout may change the pair while an idea waits. Parameters concern the strategy's basket.
  return createHash('sha256')
    .update(
      JSON.stringify([
        a.id,
        a.kind,
        a.params.lookback,
        a.params.entryBps,
        a.params.takeProfitBps,
        a.selector_version,
        a.last_order_at?.toISOString() ?? null,
      ]),
    )
    .digest('hex')
}
export interface LiveSnapshot {
  at: string
  triggerKey: string
  trigger: 'loss' | 'idle' | 'risk_stop'
  status: string
  reason: string
  capital: string
  equityUsdt: string
  pnlUsdt: string
  realizedUsdt: string
  feesUsdt: string
  idleHours: number
  lossBand: number
  source: {
    id: string
    fingerprint: string
    kind: AgentRow['kind']
    params: AgentRow['params']
    symbol: string
    cashUsdt: string
    baseQuantity: string
    roundTrips: number
    lastOrderAt: string | null
  }
  rules: Awaited<ReturnType<typeof tradingInstructions>>['rules']
  candidates: {
    symbol: string
    score: number
    changeBps: number
    movementBps: number
    trendBps: number
  }[]
  recentTrades: Record<string, unknown>[]
  previousReviews: Record<string, unknown>[]
}

/** Read-only projection of the authorized account, never keys or account identity. */
export async function bybitSnapshot(): Promise<LiveSnapshot | null> {
  if (!config().BYBIT_STRATEGY_REVIEW_ENABLED || !config().TRADING_LIVE_ENABLED) return null
  return transaction(async (db) => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], db)
    const p = await portfolio(bybitScope, db)
    if (
      !p.started_at ||
      !BigInt(p.capital) ||
      !(
        p.status === 'running' ||
        (p.status === 'paused' && ['DAILY_LOSS_LIMIT', 'DRAWDOWN_LIMIT'].includes(p.reason))
      )
    )
      return null
    const team = await agents(bybitScope, db)
    const a = team.find((a) => !a.residual_only)
    if (!a || a.selector_version !== SCOUT_POLICY.version) return null
    const now = Date.now()
    const prices = await query<{ symbol: string; bid: string; at: Date }>(
      "SELECT symbol,bid,at FROM trading_markets WHERE exchange='bybit' AND mode='live'",
      [],
      db,
    )
    let equity = 0n
    for (const member of team) {
      equity += BigInt(member.cash)
      if (BigInt(member.base)) {
        const m = prices.find((m) => m.symbol === member.symbol)
        if (!m || now - m.at.getTime() < 0 || now - m.at.getTime() > P.priceMaxAgeMs) return null
        equity += proceeds(BigInt(member.base), BigInt(m.bid))
      }
    }
    if (
      !p.heartbeat ||
      now - p.heartbeat.getTime() < 0 ||
      now - p.heartbeat.getTime() > P.priceMaxAgeMs
    )
      return null
    const [lifetime] = await query(
      "SELECT sum(realized)::text AS realized,sum(fees)::text AS fees FROM trading_agents WHERE exchange='bybit' AND mode='live'",
      [],
      db,
    )
    const pnl = equity - BigInt(p.capital)
    const lossBand =
      pnl < 0n ? Number((-pnl * 10000n) / BigInt(p.capital) / BigInt(P.liveReviewLossStepBps)) : 0
    const idleMs = Math.max(0, now - (a.last_order_at?.getTime() ?? a.created_at.getTime()))
    if (p.status === 'running' && pnl >= 0n && idleMs < P.liveReviewIdleMs) return null
    const trigger = p.status === 'paused' ? 'risk_stop' : pnl < 0n ? 'loss' : 'idle'
    const [lastExit] = await query(
      "SELECT id FROM trading_orders WHERE exchange='bybit' AND mode='live' AND side='sell' AND filled_qty>0 ORDER BY settled_at DESC NULLS LAST LIMIT 1",
      [],
      db,
    )
    const triggerKey = createHash('sha256')
      .update(
        JSON.stringify([
          a.id,
          lastExit?.id ?? null,
          idleMs >= P.liveReviewIdleMs ? a.last_order_at?.toISOString() : null,
          lifetime!.realized,
          lossBand,
          p.reason,
          p.status === 'running' ? Math.floor(idleMs / P.liveReviewIdleMs) : 0,
        ]),
      )
      .digest('hex')
    const scout = await scoutState(bybitScope, db)
    const recentTrades = await query(
      `SELECT symbol,side,status,reason,created_at,settled_at,
      (filled_qty/1e18)::text AS quantity,(quote/1e18)::text AS quote_usdt,
      (quote_fee/1e18)::text AS quote_fee_usdt,(base_fee/1e18)::text AS base_fee
      FROM trading_orders WHERE exchange='bybit' AND mode='live' ORDER BY created_at DESC LIMIT 12`,
      [],
      db,
    )
    const previousReviews = await query(
      `SELECT status,reason,proposal,review,created_at,applied_at,
      source->>'pnlUsdt' AS previous_pnl_usdt FROM trading_live_reviews ORDER BY created_at DESC LIMIT 3`,
      [],
      db,
    )
    return {
      at: new Date(now).toISOString(),
      triggerKey,
      trigger,
      status: p.status,
      reason: p.reason,
      capital: p.capital,
      equityUsdt: decimal(equity),
      pnlUsdt: decimal(pnl),
      realizedUsdt: decimal(BigInt(lifetime!.realized)),
      feesUsdt: decimal(BigInt(lifetime!.fees)),
      idleHours: Math.floor(idleMs / 3600000),
      lossBand,
      source: {
        id: a.id,
        fingerprint: strategyFingerprint(a),
        kind: a.kind,
        params: a.params,
        symbol: a.symbol,
        cashUsdt: decimal(BigInt(a.cash)),
        baseQuantity: decimal(BigInt(a.base)),
        roundTrips: a.round_trips,
        lastOrderAt: a.last_order_at?.toISOString() ?? null,
      },
      rules: (await tradingInstructions(db)).rules,
      candidates: scoutFresh(scout)
        ? scout!.coins
            .filter((c) => c.eligible)
            .slice(0, 8)
            .map(({ symbol, score, changeBps, movementBps, trendBps }) => ({
              symbol,
              score,
              changeBps,
              movementBps,
              trendBps,
            }))
        : [],
      recentTrades,
      previousReviews,
    }
  })
}
export async function pendingBybitReview(snapshot: LiveSnapshot | null, requested: boolean) {
  if (!snapshot) return null
  const [previous] = await query(
    'SELECT trigger_key,status,source FROM trading_live_reviews ORDER BY created_at DESC LIMIT 1',
  )
  if (previous && ['analyzing', 'queued'].includes(previous.status)) return null
  if (!requested && previous) {
    if (previous.trigger_key === snapshot.triggerKey) return null
    const before = previous.source as LiveSnapshot
    const worse =
      units(snapshot.realizedUsdt) < units(before.realizedUsdt) ||
      snapshot.lossBand > before.lossBand
    const stopped =
      snapshot.trigger === 'risk_stop' &&
      (before.trigger !== 'risk_stop' || snapshot.reason !== before.reason)
    const idle =
      snapshot.status === 'running' &&
      snapshot.idleHours >= P.liveReviewIdleMs / 3600000 &&
      (snapshot.source.lastOrderAt !== before.source.lastOrderAt ||
        snapshot.idleHours >= before.idleHours + P.liveReviewIdleMs / 3600000)
    if (!worse && !stopped && !idle) return null
  }
  return snapshot
}
export async function maintainBybitReviews() {
  await query(`UPDATE trading_live_reviews SET status='expired',reason='MANAGER_TASK_EXPIRED'
    WHERE status='queued' AND expires_at<=now()`)
  await query(`UPDATE trading_live_reviews t SET status='failed',reason=r.error
    FROM trading_manager_runs r WHERE r.id=t.run_id AND t.status='analyzing' AND r.status IN ('failed','discarded')`)
}

/** Caller holds the Bybit Live trading lock and transaction. No external action here. */
export async function applyBybitReview(s: TradingScope, db: Connection) {
  if (
    s.exchange !== 'bybit' ||
    s.mode !== 'live' ||
    !config().BYBIT_STRATEGY_REVIEW_ENABLED ||
    !config().TRADING_LIVE_ENABLED
  )
    return
  // Match profile/instruction publication order; skip this tick if an owner edit is active.
  const [profileLock] = await query('SELECT pg_try_advisory_xact_lock(735097) AS locked', [], db)
  if (!profileLock?.locked) return
  const p = await portfolio(s, db, true)
  const [manager] = await query(
    'SELECT enabled,instruction_revision FROM trading_manager WHERE id=true FOR SHARE',
    [],
    db,
  )
  const [task] = await query(
    `SELECT t.*,r.is_demo FROM trading_live_reviews t JOIN trading_manager_runs r ON r.id=t.run_id WHERE t.status='queued' FOR UPDATE OF t`,
    [],
    db,
  )
  if (!task) return
  const finish = async (reason: string, status = 'queued') => {
    await query(
      'UPDATE trading_live_reviews SET status=$2,reason=$3 WHERE run_id=$1',
      [task.run_id, status, reason],
      db,
    )
  }
  if (task.is_demo) return finish('MANAGER_DEMO_RELEASED', 'rejected')
  if (task.instruction_revision !== manager?.instruction_revision)
    return finish('MANAGER_INSTRUCTIONS_CHANGED', 'rejected')
  if (task.expires_at.getTime() <= Date.now()) return finish('MANAGER_TASK_EXPIRED', 'expired')
  if (!manager?.enabled) return finish('MANAGER_PAUSED')
  if (!(await directionAllowed('manager', db)) || !(await directionAllowed('trading', db)))
    return finish('WORK_FOCUS_MANAGER_DISABLED')
  const [system] = await query('SELECT mode FROM system_state WHERE id=true', [], db)
  if (system?.mode !== 'running') return finish('MANAGER_SYSTEM_PAUSED')
  if (p.status !== 'running') return finish('MANAGER_RISK_PAUSED')
  if (p.check_error) return finish('MANAGER_SCOUT_STALE')
  if (await pendingOrder(s, db)) return finish('MANAGER_ORDER_PENDING')
  const a = (await agents(s, db)).find((a) => a.id === task.agent_id && !a.residual_only)
  const snapshot = task.source as LiveSnapshot
  if (
    !a ||
    strategyFingerprint(a) !== snapshot.source.fingerprint ||
    p.capital !== snapshot.capital
  )
    return finish('MANAGER_AGENT_CHANGED', 'rejected')
  if (BigInt(a.base) || BigInt(a.basis)) return finish('MANAGER_POSITION_OPEN')
  const scout = await scoutState(s, db)
  if (!scoutFresh(scout)) return finish('MANAGER_SCOUT_STALE')
  const [market] = await query(
    "SELECT at FROM trading_markets WHERE exchange='bybit' AND mode='live' AND symbol=$1",
    [a.symbol],
    db,
  )
  if (
    !market ||
    Date.now() - market.at.getTime() < 0 ||
    Date.now() - market.at.getTime() > P.priceMaxAgeMs
  )
    return finish('MANAGER_SCOUT_STALE')
  const plan = livePlanSchema.parse(task.proposal)
  if (!plan.proposal || !liveCritiqueSchema.parse(task.review).approved)
    return finish('MANAGER_LIVE_REJECTED', 'rejected')
  const rules = (await tradingInstructions(db, true)).rules
  if (ownerEntryReason(rules, { ...a, kind: plan.proposal.kind }))
    return finish('MANAGER_OWNER_CHANGED', 'rejected')
  await query(
    'UPDATE trading_agents SET kind=$2,params=$3 WHERE id=$1',
    [a.id, plan.proposal.kind, plan.proposal.params],
    db,
  )
  await query(
    "UPDATE trading_live_reviews SET status='applied',reason='MANAGER_LIVE_APPLIED',applied_at=now() WHERE run_id=$1",
    [task.run_id],
    db,
  )
  await event(
    s,
    'manager',
    'MANAGER_LIVE_APPLIED',
    {
      runId: task.run_id,
      agentId: a.id,
      before: { kind: a.kind, params: a.params },
      after: plan.proposal,
    },
    db,
  )
}
export function validateLivePlan(plan: LivePlan, snapshot: LiveSnapshot) {
  const p = plan.proposal
  if (
    p &&
    p.kind === snapshot.source.kind &&
    p.params.lookback === snapshot.source.params.lookback &&
    p.params.entryBps === snapshot.source.params.entryBps &&
    p.params.takeProfitBps === snapshot.source.params.takeProfitBps
  )
    throw new Error('MANAGER_UNCHANGED_PROPOSAL')
  if (p && snapshot.rules.allowedKinds && !snapshot.rules.allowedKinds.includes(p.kind))
    throw new Error('MANAGER_TARGET_INVALID')
  return plan
}
