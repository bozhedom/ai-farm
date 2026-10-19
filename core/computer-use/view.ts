import { config, computerUseReady } from '../config'
import { query } from '../db'
import type {
  ComputerApprovalView,
  ComputerOpportunityView,
  ComputerStepView,
  ComputerTaskView,
  ComputerUseView,
} from '../contracts/computer-use'
import { rotationGoals } from './goals'
import { COMPUTER_USE_POLICY as P } from './policy'
import {
  computerUseProvider,
  dailySpend,
  ensureComputerUse,
  type ComputerUseRow,
  type TaskRow,
} from './runtime'

type TaskCostRow = TaskRow & { spent_microusd: string | number; spent_kopecks: number }

const taskSql = `SELECT t.*,
  coalesce((SELECT sum(c.charged_microusd) FROM tool_calls c WHERE c.reservation_id=t.reservation_id),0)::bigint AS spent_microusd,
  coalesce((SELECT sum(c.charged_kopecks) FROM tool_calls c WHERE c.reservation_id=t.reservation_id),0)::int AS spent_kopecks
  FROM computer_use_tasks t`

function taskView(
  row: TaskCostRow,
  steps: ComputerStepView[] = [],
  latestScreenshotStepId: string | null = null,
): ComputerTaskView {
  return {
    id: row.id,
    goal: row.goal,
    source: row.source,
    status: row.status,
    stepCount: row.step_count,
    stepLimit: row.step_limit,
    costCapMicrousd: row.cost_cap_microusd,
    spentMicrousd: Number(row.spent_microusd),
    spentKopecks: row.spent_kopecks,
    demo: row.is_demo,
    provider: row.provider,
    model: row.model,
    report: row.report,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() || null,
    finishedAt: row.finished_at?.toISOString() || null,
    steps,
    latestScreenshotStepId,
  }
}

export async function computerUseView(): Promise<ComputerUseView> {
  await ensureComputerUse()
  const c = config()
  const [states, systems, spent, current, approvals, history, opportunities, queued] =
    await Promise.all([
      query<ComputerUseRow>('SELECT * FROM computer_use WHERE id=true'),
      query('SELECT mode,worker_heartbeat FROM system_state WHERE id=true'),
      dailySpend(),
      query<TaskCostRow>(
        `${taskSql} WHERE t.status IN ('running','waiting_approval') ORDER BY t.created_at LIMIT 1`,
      ),
      query(
        `SELECT a.*,t.goal FROM computer_use_approvals a JOIN computer_use_tasks t ON t.id=a.task_id
         WHERE a.status='pending' ORDER BY a.created_at`,
      ),
      query<TaskCostRow>(
        `${taskSql} WHERE t.status NOT IN ('running','waiting_approval') ORDER BY t.created_at DESC LIMIT 20`,
      ),
      query('SELECT * FROM computer_use_opportunities ORDER BY created_at DESC LIMIT 60'),
      query("SELECT count(*)::int AS n FROM computer_use_tasks WHERE status='queued'"),
    ])
  const state = states[0]!
  const system = systems[0]
  const now = Date.now()
  const workerAge = system?.worker_heartbeat ? now - system.worker_heartbeat.getTime() : Infinity
  const workerAlive = workerAge >= 0 && workerAge < 90_000
  const provider = computerUseProvider()
  const blocked: string[] = []
  const ready = computerUseReady(c)
  if (ready) blocked.push(ready)
  if (system?.mode !== 'running') blocked.push('COMPUTER_USE_SYSTEM_PAUSED')
  if (!workerAlive) blocked.push('COMPUTER_USE_WORKER_UNAVAILABLE')
  if (state.failures >= P.maxFailuresInRow) blocked.push('COMPUTER_USE_FAILURES')
  if (!provider.demo && spent.microusd >= c.COMPUTER_USE_DAILY_CAP_MICROUSD)
    blocked.push('COMPUTER_USE_DAILY_LIMIT')
  let currentView: ComputerTaskView | null = null
  if (current[0]) {
    const steps = await query(
      'SELECT * FROM computer_use_steps WHERE task_id=$1 ORDER BY step_no DESC LIMIT 40',
      [current[0].id],
    )
    const views: ComputerStepView[] = steps.map((s) => ({
      id: s.id,
      stepNo: s.step_no,
      action: s.action,
      decision: s.decision,
      reason: s.reason,
      reasoning: s.reasoning,
      urlBefore: s.url_before,
      urlAfter: s.url_after,
      title: s.title,
      hasScreenshot: !!s.screenshot_path,
      createdAt: s.created_at.toISOString(),
    }))
    currentView = taskView(current[0], views, views.find((s) => s.hasScreenshot)?.id ?? null)
  }
  return {
    state: {
      enabled: state.enabled,
      running: !!state.lease_until && state.lease_until.getTime() > now,
      workerAlive,
      blocked,
      lastError: state.last_error,
      ...provider,
      stepLimit: c.COMPUTER_USE_STEP_LIMIT,
      taskCapMicrousd: c.COMPUTER_USE_TASK_CAP_MICROUSD,
      dailyCapMicrousd: c.COMPUTER_USE_DAILY_CAP_MICROUSD,
      spentTodayMicrousd: spent.microusd,
      spentTodayKopecks: spent.kopecks,
      queuedOwnerGoals: queued[0]!.n,
      failures: state.failures,
      rotationGoals: rotationGoals.length,
    },
    current: currentView,
    approvals: approvals.map((a): ComputerApprovalView => ({
      id: a.id,
      taskId: a.task_id,
      goal: a.goal,
      stepNo: a.step_no,
      action: a.action,
      reason: a.reason,
      createdAt: a.created_at.toISOString(),
    })),
    history: history.map((row) => taskView(row)),
    opportunities: opportunities.map((o): ComputerOpportunityView => ({
      id: o.id,
      taskId: o.task_id,
      title: o.title,
      url: o.url,
      summary: o.summary,
      kind: o.kind,
      requiresHuman: o.requires_human,
      demo: o.is_demo,
      status: o.status,
      createdAt: o.created_at.toISOString(),
    })),
  }
}
