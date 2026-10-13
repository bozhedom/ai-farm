import { randomUUID } from 'node:crypto'
import { query, type Connection } from '../db'
import { MANAGER_POLICY as P, SCOUT_POLICY as S } from '../policy'
import type { ManagerOutcome, ManagerTaskStatus } from '../contracts/manager'
import { decimal } from '../trading/decimal'
import { markAgent } from '../trading/accounting'
import { admitted, scoutFresh, scoutState } from '../trading/scout'
import { pickSymbol, recordAssignment } from '../trading/rotation'
import {
  agents,
  atomic,
  event,
  pendingOrder,
  portfolio,
  scope,
  withTradingLock,
} from '../trading/store'
import { exchanges, type AgentRow, type TradingScope } from '../trading/types'
import { proposalSchema, sameParams, type ManagerAgentSnapshot, type ManagerProposal } from './plan'

export interface TaskRow {
  id: string
  run_id: string
  exchange: TradingScope['exchange']
  status: ManagerTaskStatus
  reason: string
  source_agent_id: string
  agent_id: string | null
  source: ManagerAgentSnapshot
  proposal: ManagerProposal
  revision: number
  created_at: Date
  applied_at: Date | null
  evaluate_at: Date | null
  expires_at: Date
  outcome: ManagerOutcome | null
}
async function taskReason(task: TaskRow, reason: string, db: Connection, status = task.status) {
  if (task.reason === reason && task.status === status) return
  await query(
    'UPDATE trading_manager_tasks SET status=$2,reason=$3 WHERE id=$1',
    [task.id, status, reason],
    db,
  )
}

/** The caller holds the Paper scope lock and a transaction. No model or network call occurs here. */
export async function applyManagerTask(s: TradingScope, db: Connection) {
  if (s.mode !== 'paper') return
  const p = await portfolio(s, db, true)
  const [manager] = await query(
    'SELECT enabled FROM trading_manager WHERE id=true FOR SHARE',
    [],
    db,
  )
  const [task] = await query<TaskRow>(
    "SELECT * FROM trading_manager_tasks WHERE exchange=$1 AND status='queued' FOR UPDATE",
    [s.exchange],
    db,
  )
  if (!task) return
  if (task.expires_at.getTime() <= Date.now())
    return taskReason(task, 'MANAGER_TASK_EXPIRED', db, 'expired')
  if (task.revision !== p.manager_revision)
    return taskReason(task, 'MANAGER_OWNER_CHANGED', db, 'rejected')
  if (!manager?.enabled) return taskReason(task, 'MANAGER_PAUSED', db)
  const [state] = await query('SELECT mode FROM system_state WHERE id=true', [], db)
  if (state?.mode !== 'running') return taskReason(task, 'MANAGER_SYSTEM_PAUSED', db)
  if (p.status !== 'running') return taskReason(task, p.reason || 'MANAGER_PORTFOLIO_PAUSED', db)
  if (p.strategy_preset_pending) return taskReason(task, 'MANAGER_PRESET_PENDING', db)
  if (await pendingOrder(s, db)) return taskReason(task, 'MANAGER_ORDER_PENDING', db)
  const team = await agents(s, db)
  const a = team.find((a) => a.id === task.source_agent_id)
  if (!a) return taskReason(task, 'MANAGER_AGENT_CHANGED', db, 'rejected')
  const proposal = proposalSchema.parse(task.proposal)
  const source = task.source
  if (
    a.kind !== source.kind ||
    !sameParams(a.params, source.params) ||
    a.symbol !== source.symbol ||
    a.selector_version !== source.selectorVersion ||
    a.assigned_at.toISOString() !== source.assignedAt ||
    a.round_trips !== source.roundTrips
  )
    return taskReason(task, 'MANAGER_AGENT_CHANGED', db, 'rejected')
  if (BigInt(a.base) !== 0n || BigInt(a.basis) !== 0n)
    return taskReason(task, 'MANAGER_POSITION_OPEN', db)
  if (Date.now() - a.created_at.getTime() < P.minAgentAgeMs)
    return taskReason(task, 'MANAGER_AGENT_TOO_YOUNG', db)
  if (BigInt(a.cash) <= 0n || BigInt(a.cash) > BigInt(a.initial_cash))
    return taskReason(task, 'MANAGER_PRESERVE_AGENT', db, 'rejected')
  const scout = await scoutState(s, db)
  if (!scoutFresh(scout)) return taskReason(task, 'MANAGER_SCOUT_STALE', db)
  const others = team.filter((t) => t.id !== a.id).map((t) => t.symbol)
  const symbol =
    admitted(scout, a.symbol) && others.filter((c) => c === a.symbol).length < S.maxAgentsPerSymbol
      ? a.symbol
      : pickSymbol(proposal.kind, scout!.coins, others)
  if (!symbol) return taskReason(task, 'MANAGER_NO_MARKET', db)
  const id = randomUUID()
  await query(
    "UPDATE trading_agents SET status='archived',archived_at=now() WHERE id=$1",
    [a.id],
    db,
  )
  await query(
    `INSERT INTO trading_agents(id,exchange,mode,name,symbol,kind,params,parent_id,generation,initial_cash,cash,peak,selector_version)
     VALUES($1,$2,'paper',$3,$4,$5,$6,$7,$8,$9,$9,$9,$10)`,
    [
      id,
      s.exchange,
      `${a.name.split(' · ')[0]} · эксперимент`,
      symbol,
      proposal.kind,
      proposal.params,
      a.id,
      a.generation,
      a.cash,
      S.version,
    ],
    db,
  )
  await recordAssignment(s, id, symbol, a.symbol, 'MANAGER_EXPERIMENT_STARTED', db)
  await query(
    `UPDATE trading_manager_tasks SET status='observing',reason='MANAGER_COLLECTING_DATA',agent_id=$2,applied_at=now(),
     evaluate_at=now()+$3*interval '1 millisecond',expires_at=now()+$4*interval '1 millisecond' WHERE id=$1`,
    [task.id, id, P.evaluationMs, P.observationLifetimeMs],
    db,
  )
  await event(
    s,
    'manager',
    'MANAGER_EXPERIMENT_STARTED',
    { taskId: task.id, agentId: id, parentId: a.id },
    db,
  )
}

async function evaluateTask(s: TradingScope, db: Connection) {
  const [task] = await query<TaskRow>(
    "SELECT * FROM trading_manager_tasks WHERE exchange=$1 AND status='observing' FOR UPDATE",
    [s.exchange],
    db,
  )
  if (!task) return
  const [a] = await query<AgentRow>(
    "SELECT * FROM trading_agents WHERE id=$1 AND exchange=$2 AND mode='paper'",
    [task.agent_id, s.exchange],
    db,
  )
  if (!a) throw new Error('MANAGER_AGENT_NOT_FOUND')
  const now = Date.now(),
    interrupted = a.status !== 'active',
    expired = task.expires_at.getTime() <= now
  if (
    !interrupted &&
    !expired &&
    (now < task.evaluate_at!.getTime() || a.round_trips < P.minRoundTrips)
  )
    return
  if (!interrupted && !expired && (await pendingOrder(s, db))) return
  const [price] = await query<{ bid: string; at: Date }>(
    "SELECT bid,at FROM trading_markets WHERE exchange=$1 AND mode='paper' AND symbol=$2",
    [s.exchange, a.symbol],
    db,
  )
  const fresh =
    price && now - price.at.getTime() >= 0 && now - price.at.getTime() <= P.priceMaxAgeMs
  const equity =
    BigInt(a.base) === 0n ? BigInt(a.cash) : fresh ? markAgent(a, BigInt(price.bid)).equity : null
  if (equity === null && !expired && !interrupted)
    return taskReason(task, 'MANAGER_PRICE_STALE', db)
  const pnl = equity === null ? null : equity - BigInt(a.initial_cash)
  const outcome: ManagerOutcome = {
    verdict: interrupted
      ? 'interrupted'
      : a.round_trips < P.minRoundTrips || pnl === null
        ? 'insufficient'
        : pnl > 0n
          ? 'positive'
          : 'negative',
    pnlUsdt: pnl === null ? null : decimal(pnl),
    feesUsdt: decimal(BigInt(a.fees)),
    roundTrips: a.round_trips,
    drawdownBps: a.max_drawdown_bps,
    evaluatedAt: new Date(now).toISOString(),
  }
  await query(
    "UPDATE trading_manager_tasks SET status='completed',reason='MANAGER_EVALUATED',outcome=$2 WHERE id=$1",
    [task.id, outcome],
    db,
  )
  await event(s, 'manager', 'MANAGER_EVALUATED', { taskId: task.id, agentId: a.id, ...outcome }, db)
}

/** Evaluation continues while planning is paused; it cannot start or stop a trading agent. */
export async function advanceManagerTasks() {
  const changed = await query(
    `UPDATE trading_manager SET tasks_checked_at=now() WHERE id=true
    AND (tasks_checked_at IS NULL OR tasks_checked_at<=now()-$1*interval '1 millisecond') RETURNING id`,
    [P.taskCheckMs],
  )
  if (!changed.length) return
  for (const exchange of exchanges) {
    const s = scope(exchange, 'paper')
    try {
      await withTradingLock(s, (db) =>
        atomic(db, async () => {
          await applyManagerTask(s, db)
          await evaluateTask(s, db)
        }),
      )
    } catch (error) {
      if (!(error instanceof Error && error.message === 'TRADING_BUSY')) throw error
    }
  }
}
