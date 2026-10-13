import { query } from '../db'
import { MANAGER_POLICY as P } from '../policy'
import type { ManagerView } from '../contracts/manager'
import {
  ensureManager,
  managerBudget,
  managerModelBlocker,
  managerProvider,
  type ManagerRow,
} from './runtime'
import type { TaskRow } from './tasks'

export async function managerView(): Promise<ManagerView> {
  await ensureManager()
  const [states, systems, budget, runs, tasks] = await Promise.all([
    query<ManagerRow>('SELECT * FROM trading_manager WHERE id=true'),
    query(
      "SELECT mode,worker_heartbeat,provider_readiness,EXISTS(SELECT 1 FROM trading_agents WHERE mode='paper' AND status='active') AS paper_ready FROM system_state WHERE id=true",
    ),
    managerBudget(),
    query(`SELECT r.id,r.status,r.plan->>'summary' AS summary,r.error,r.created_at,r.finished_at,r.is_demo,
      coalesce((SELECT sum(t.charged_kopecks)::int FROM tool_calls t WHERE t.reservation_id=r.reservation_id),0) AS cost
      FROM trading_manager_runs r ORDER BY r.created_at DESC LIMIT 12`),
    query<
      TaskRow & { is_demo: boolean }
    >(`SELECT t.*,r.is_demo FROM trading_manager_tasks t JOIN trading_manager_runs r ON r.id=t.run_id
      ORDER BY CASE WHEN t.status IN ('queued','observing') THEN 0 ELSE 1 END,t.created_at DESC LIMIT 40`),
  ])
  const state = states[0]!,
    system = systems[0],
    now = Date.now(),
    provider = managerProvider()
  const workerAge = system?.worker_heartbeat ? now - system.worker_heartbeat.getTime() : Infinity
  const workerAlive = workerAge >= 0 && workerAge < 90_000
  const blocked: string[] = []
  if (!workerAlive) blocked.push('MANAGER_WORKER_UNAVAILABLE')
  if (!system?.paper_ready) blocked.push('MANAGER_NO_PAPER')
  const modelBlocker = managerModelBlocker()
  if (modelBlocker) blocked.push(modelBlocker)
  if (system?.mode !== 'running') blocked.push('MANAGER_SYSTEM_PAUSED')
  if (system?.provider_readiness?.model !== true) blocked.push('MANAGER_MODEL_UNAVAILABLE')
  if (budget.uncertain) blocked.push('MANAGER_COST_REVIEW')
  if (budget.runs >= P.maxDailyRuns) blocked.push('MANAGER_DAILY_LIMIT')
  if (budget.spent + budget.reserved >= P.dailyKopecks) blocked.push('MANAGER_BUDGET_LIMIT')
  const midnight = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z') + 86_400_000
  const nextAt = Math.max(
    now,
    state.requested_at ? now : (state.attempted_at?.getTime() || 0) + P.intervalMs,
    budget.runs >= P.maxDailyRuns || budget.spent >= P.dailyKopecks ? midnight : 0,
  )
  return {
    state: {
      enabled: state.enabled,
      thinking: !!state.lease_until && state.lease_until.getTime() > now,
      requested: !!state.requested_at,
      workerAlive,
      nextReviewAt: state.enabled ? new Date(nextAt).toISOString() : null,
      blocked,
      lastError: state.last_error,
      intervalHours: P.intervalMs / 3_600_000,
      manualCooldownMinutes: P.manualCooldownMs / 60_000,
      minEvaluationHours: P.evaluationMs / 3_600_000,
      minRoundTrips: P.minRoundTrips,
      maxObservationDays: P.observationLifetimeMs / 86_400_000,
      maxDailyRuns: P.maxDailyRuns,
      runsToday: budget.runs,
      ...provider,
      spentKopecks: budget.spent,
      reservedKopecks: budget.reserved,
      dailyLimitKopecks: P.dailyKopecks,
    },
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      summary: r.summary || '',
      error: r.error,
      createdAt: r.created_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() || null,
      demo: r.is_demo,
      costKopecks: r.cost,
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      demo: t.is_demo,
      exchange: t.exchange,
      status: t.status,
      reason: t.reason,
      hypothesis: t.proposal.hypothesis,
      rationale: t.proposal.rationale,
      kind: t.proposal.kind,
      params: t.proposal.params,
      sourceAgentId: t.source_agent_id,
      agentId: t.agent_id,
      createdAt: t.created_at.toISOString(),
      appliedAt: t.applied_at?.toISOString() || null,
      evaluateAt: t.evaluate_at?.toISOString() || null,
      expiresAt: t.expires_at.toISOString(),
      outcome: t.outcome,
    })),
  }
}
