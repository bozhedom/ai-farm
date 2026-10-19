import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { config, computerUseReady, paidModelId } from '../config'
import { audit, query, transaction, type Connection } from '../db'
import { closeReservation, reserveBudget } from '../budget'
import { rotationGoals } from './goals'
import {
  COMPUTER_USE_POLICY as P,
  classifyAction,
  forbiddenTextReason,
  hostOf,
  isPrivateHost,
  validateGoal,
  type PageContext,
} from './policy'
import { browserActionNames, parseToolCall, type BrowserAction, type ToolCall } from './schema'
import { VmAgentUnavailable, vmAgentFromConfig, type VmAgentClient } from './client'
import {
  astraStep,
  demoScript,
  prepareStepRequest,
  type ComputerUseModel,
  type StepHistory,
} from './model'

export interface ComputerUseRow {
  enabled: boolean
  rotation_index: number
  failures: number
  lease_id: string | null
  lease_until: Date | null
  last_error: string
}
export interface TaskRow {
  id: string
  goal: string
  source: 'owner' | 'rotation'
  status: 'queued' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled'
  step_count: number
  step_limit: number
  cost_cap_microusd: number
  reservation_id: string | null
  provider: string
  model: string
  is_demo: boolean
  session_id: string | null
  report: string
  error: string
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}
export type StepDecision =
  'allowed' | 'approval' | 'approved' | 'rejected' | 'blocked' | 'invalid' | 'failed'

export function computerUseProvider() {
  const c = config()
  const demo = c.MODEL_PROVIDER === 'demo'
  return {
    provider: c.MODEL_PROVIDER,
    model: demo ? 'demo' : c.MODEL_PROVIDER === 'openai' ? paidModelId(c) : c.MODEL_PROVIDER,
    demo,
  }
}

export async function ensureComputerUse(db?: Connection) {
  await query('INSERT INTO computer_use(id) VALUES(true) ON CONFLICT DO NOTHING', [], db)
}

/** Charged model costs of one task, from the shared ledger. */
export async function taskSpend(reservationId: string | null, db?: Connection) {
  if (!reservationId) return { microusd: 0, kopecks: 0 }
  const [row] = await query(
    `SELECT coalesce(sum(charged_microusd),0)::bigint AS microusd,
            coalesce(sum(charged_kopecks),0)::int AS kopecks
     FROM tool_calls WHERE reservation_id=$1`,
    [reservationId],
    db,
  )
  return { microusd: Number(row!.microusd), kopecks: row!.kopecks as number }
}
export async function dailySpend(db?: Connection) {
  const [row] = await query(
    `SELECT coalesce(sum(t.charged_microusd),0)::bigint AS microusd,
            coalesce(sum(t.charged_kopecks),0)::int AS kopecks
     FROM tool_calls t JOIN budget_reservations r ON r.id=t.reservation_id
     WHERE r.category='computer_use'
       AND t.created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [],
    db,
  )
  return { microusd: Number(row!.microusd), kopecks: row!.kopecks as number }
}

// ---------------------------------------------------------------------------------------------
// Owner actions. Models never call these; the office API validates the input first.

export async function controlComputerUse(action: 'enable' | 'pause') {
  await ensureComputerUse()
  await transaction(async (db) => {
    await query('SELECT * FROM computer_use WHERE id=true FOR UPDATE', [], db)
    if (action === 'enable')
      await query(
        "UPDATE computer_use SET enabled=true,failures=0,last_error='',updated_at=now() WHERE id=true",
        [],
        db,
      )
    else await query('UPDATE computer_use SET enabled=false,updated_at=now() WHERE id=true', [], db)
    await audit(
      'computer_use_control',
      action === 'enable'
        ? 'Владелец включил работу модели в браузере на отдельной машине.'
        : 'Владелец выключил работу модели в браузере. Начатое задание ждёт.',
      { action },
      db,
    )
  })
}

export async function addOwnerGoal(text: string) {
  const goal = validateGoal(text)
  const c = config()
  const provider = computerUseProvider()
  return transaction(async (db) => {
    await query('SELECT * FROM computer_use WHERE id=true FOR UPDATE', [], db)
    const [count] = await query(
      "SELECT count(*)::int AS n FROM computer_use_tasks WHERE status='queued'",
      [],
      db,
    )
    if (count!.n >= P.maxQueuedOwnerGoals) throw new Error('COMPUTER_USE_QUEUE_FULL')
    const id = randomUUID()
    await query(
      `INSERT INTO computer_use_tasks(id,goal,source,status,step_limit,cost_cap_microusd,provider,model,is_demo)
       VALUES($1,$2,'owner','queued',$3,$4,$5,$6,$7)`,
      [
        id,
        goal,
        c.COMPUTER_USE_STEP_LIMIT,
        provider.demo ? 0 : c.COMPUTER_USE_TASK_CAP_MICROUSD,
        provider.provider,
        provider.model,
        provider.demo,
      ],
      db,
    )
    await audit('computer_use_goal', 'Владелец поставил задание для браузера.', { id }, db)
    return id
  })
}

export async function cancelTask(id: string) {
  return transaction(async (db) => {
    const [task] = await query<TaskRow>(
      'SELECT * FROM computer_use_tasks WHERE id=$1 FOR UPDATE',
      [id],
      db,
    )
    if (!task) throw new Error('COMPUTER_TASK_NOT_FOUND')
    if (!['queued', 'running', 'waiting_approval'].includes(task.status))
      throw new Error('COMPUTER_USE_TASK_FINISHED')
    await endTask(db, task, 'cancelled', '', 'COMPUTER_USE_CANCELLED')
    await audit('computer_use_cancel', 'Владелец отменил задание браузера.', { id }, db)
    return task.session_id
  })
}

export async function resolveApproval(id: string, decision: 'approve' | 'reject') {
  await transaction(async (db) => {
    const [approval] = await query(
      "SELECT * FROM computer_use_approvals WHERE id=$1 AND status='pending' FOR UPDATE",
      [id],
      db,
    )
    if (!approval) throw new Error('COMPUTER_APPROVAL_NOT_FOUND')
    await query(
      'UPDATE computer_use_approvals SET status=$2,resolved_at=now() WHERE id=$1',
      [id, decision === 'approve' ? 'approved' : 'rejected'],
      db,
    )
    await query(
      "UPDATE computer_use_tasks SET status='running' WHERE id=$1 AND status='waiting_approval'",
      [approval.task_id],
      db,
    )
    await audit(
      'computer_use_approval',
      decision === 'approve'
        ? 'Владелец разрешил действие в браузере.'
        : 'Владелец отклонил действие в браузере.',
      { id, taskId: approval.task_id, decision },
      db,
    )
  })
}

export async function setOpportunityStatus(id: string, status: 'new' | 'saved' | 'dismissed') {
  const rows = await query(
    'UPDATE computer_use_opportunities SET status=$2 WHERE id=$1 RETURNING id',
    [id, status],
  )
  if (!rows.length) throw new Error('COMPUTER_OPPORTUNITY_NOT_FOUND')
}

// ---------------------------------------------------------------------------------------------
// Worker loop.

async function endTask(
  db: Connection,
  task: TaskRow,
  status: 'done' | 'failed' | 'cancelled',
  report: string,
  error: string,
) {
  await query(
    `UPDATE computer_use_tasks SET status=$2,report=$3,error=$4,finished_at=now()
     WHERE id=$1 AND status IN ('queued','running','waiting_approval')`,
    [task.id, status, report.slice(0, 4000), error],
    db,
  )
  await query(
    "UPDATE computer_use_approvals SET status='expired',resolved_at=now() WHERE task_id=$1 AND status='pending'",
    [task.id],
    db,
  )
  if (task.reservation_id) await closeReservation(task.reservation_id, db)
}

/** Nothing restarts an approval the owner has not seen for a day; the model learns it expired. */
async function expireApprovals() {
  await transaction(async (db) => {
    const expired = await query(
      `UPDATE computer_use_approvals SET status='expired',resolved_at=now()
       WHERE status='pending' AND created_at < now()-$1*interval '1 millisecond' RETURNING task_id`,
      [P.approvalLifetimeMs],
      db,
    )
    for (const row of expired)
      await query(
        "UPDATE computer_use_tasks SET status='running' WHERE id=$1 AND status='waiting_approval'",
        [row.task_id],
        db,
      )
  })
}

export function screenshotRoot() {
  return resolve(config().COMPUTER_USE_SCREENSHOT_DIR)
}
/** Resolves a stored relative path and refuses anything outside the screenshot directory. */
export function screenshotFile(path: string) {
  const root = screenshotRoot()
  const file = resolve(root, path)
  if (!file.startsWith(root + sep) || !/^[0-9a-f-]{36}\/\d+\.png$/.test(path)) return null
  return file
}
export async function readScreenshot(path: string) {
  const file = screenshotFile(path)
  if (!file) return null
  try {
    return await readFile(file)
  } catch {
    return null
  }
}
async function saveScreenshot(taskId: string, stepNo: number, png: Buffer) {
  const path = `${taskId}/${stepNo}.png`
  const file = screenshotFile(path)
  if (!file || png.length > P.maxScreenshotBytes) return { path: null, bytes: 0 }
  try {
    await mkdir(join(screenshotRoot(), taskId), { recursive: true })
    await writeFile(file, png)
  } catch {
    // A read-only or missing directory loses the picture, not the step: the model still sees it.
    return { path: null, bytes: 0 }
  }
  return { path, bytes: png.length }
}
let cleanedAt = 0
/** Screenshots of old finished tasks leave the disk; the step rows and reports stay. */
export async function cleanupScreenshots(now = Date.now()) {
  if (now - cleanedAt < 60 * 60_000) return
  cleanedAt = now
  const old = await query(
    `SELECT id FROM computer_use_tasks WHERE finished_at < now()-$1*interval '1 day'
     AND EXISTS(SELECT 1 FROM computer_use_steps s WHERE s.task_id=computer_use_tasks.id AND s.screenshot_path IS NOT NULL)
     LIMIT 50`,
    [P.screenshotRetentionDays],
  )
  for (const row of old) {
    await rm(join(screenshotRoot(), row.id), { recursive: true, force: true })
    await query('UPDATE computer_use_steps SET screenshot_path=NULL WHERE task_id=$1', [row.id])
  }
}

type Claim = { task: TaskRow; leaseId: string }

async function claimTask(): Promise<Claim | null> {
  return transaction(async (db) => {
    // The same first locks as meteredCall; nothing else is held across the model request.
    const [system] = await query('SELECT mode FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [owner] = await query<ComputerUseRow>(
      'SELECT * FROM computer_use WHERE id=true FOR UPDATE',
      [],
      db,
    )
    if (!owner) return null
    const now = Date.now()
    if (owner.lease_until && owner.lease_until.getTime() > now) return null
    if (owner.lease_id)
      await query('UPDATE computer_use SET lease_id=NULL,lease_until=NULL WHERE id=true', [], db)
    const c = config()
    if (!owner.enabled || system?.mode !== 'running' || computerUseReady(c)) return null
    if (owner.failures >= P.maxFailuresInRow) return null
    const spent = await dailySpend(db)
    if (!computerUseProvider().demo && spent.microusd >= c.COMPUTER_USE_DAILY_CAP_MICROUSD) {
      await query(
        "UPDATE computer_use SET last_error='COMPUTER_USE_DAILY_LIMIT' WHERE id=true",
        [],
        db,
      )
      return null
    }
    let [task] = await query<TaskRow>(
      "SELECT * FROM computer_use_tasks WHERE status='running' LIMIT 1 FOR UPDATE",
      [],
      db,
    )
    if (!task) {
      const waiting = await query(
        "SELECT id FROM computer_use_tasks WHERE status='waiting_approval' LIMIT 1",
        [],
        db,
      )
      if (waiting.length) return null
      ;[task] = await query<TaskRow>(
        "SELECT * FROM computer_use_tasks WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE",
        [],
        db,
      )
    }
    if (!task) {
      const [last] = await query<{ status: string; finished_at: Date }>(
        'SELECT status,finished_at FROM computer_use_tasks WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
        [],
        db,
      )
      if (last) {
        const age = now - last.finished_at.getTime()
        if (last.status === 'failed' && age < P.failureCooldownMs) return null
        if (age < P.rotationPauseMs) return null
      }
      const provider = computerUseProvider()
      const goal = rotationGoals[owner.rotation_index % rotationGoals.length]!
      const id = randomUUID()
      await query(
        `INSERT INTO computer_use_tasks(id,goal,source,status,step_limit,cost_cap_microusd,provider,model,is_demo)
         VALUES($1,$2,'rotation','queued',$3,$4,$5,$6,$7)`,
        [
          id,
          goal,
          c.COMPUTER_USE_STEP_LIMIT,
          provider.demo ? 0 : c.COMPUTER_USE_TASK_CAP_MICROUSD,
          provider.provider,
          provider.model,
          provider.demo,
        ],
        db,
      )
      await query('UPDATE computer_use SET rotation_index=rotation_index+1 WHERE id=true', [], db)
      ;[task] = await query<TaskRow>('SELECT * FROM computer_use_tasks WHERE id=$1', [id], db)
    }
    const provider = computerUseProvider()
    if (
      task!.provider !== provider.provider ||
      task!.model !== provider.model ||
      task!.is_demo !== provider.demo
    ) {
      await endTask(db, task!, 'failed', '', 'PROVIDER_CHANGED_DURING_JOB')
      return null
    }
    if (!task!.reservation_id) {
      try {
        task!.reservation_id = await reserveBudget(`computer-use:${task!.id}`, 'computer_use', db)
      } catch (error) {
        if (!(error instanceof Error && error.message === 'BUDGET_BLOCKED')) throw error
        await query(
          "UPDATE computer_use SET last_error='BUDGET_BLOCKED' WHERE id=true AND last_error<>'BUDGET_BLOCKED'",
          [],
          db,
        )
        return null
      }
      await query(
        'UPDATE computer_use_tasks SET reservation_id=$2 WHERE id=$1',
        [task!.id, task!.reservation_id],
        db,
      )
    }
    const leaseId = randomUUID()
    await query(
      `UPDATE computer_use_tasks SET status='running',started_at=coalesce(started_at,now()) WHERE id=$1`,
      [task!.id],
      db,
    )
    await query(
      `UPDATE computer_use SET lease_id=$1,lease_until=now()+$2*interval '1 millisecond',last_error='' WHERE id=true`,
      [leaseId, P.leaseMs],
      db,
    )
    return { task: { ...task!, status: 'running' }, leaseId }
  })
}

async function renewLease(leaseId: string) {
  const rows = await query(
    `UPDATE computer_use SET lease_until=now()+$2*interval '1 millisecond'
     WHERE id=true AND lease_id=$1 AND enabled RETURNING id`,
    [leaseId, P.leaseMs],
  )
  return rows.length > 0
}
async function releaseLease(leaseId: string) {
  await query(
    'UPDATE computer_use SET lease_id=NULL,lease_until=NULL WHERE id=true AND lease_id=$1',
    [leaseId],
  )
}

type StepRecord = {
  action: Record<string, unknown>
  decision: StepDecision
  reason?: string
  reasoning?: string
  urlBefore?: string
  urlAfter?: string
  title?: string
  screenshot?: { path: string | null; bytes: number }
  callKey?: string | null
}
/** One step row; the task's counter moves with it. Refused when the task is no longer running. */
async function recordStep(task: TaskRow, stepNo: number, record: StepRecord, db?: Connection) {
  const run = async (tx: Connection) => {
    const updated = await query(
      "UPDATE computer_use_tasks SET step_count=$2 WHERE id=$1 AND status='running' AND step_count=$2-1 RETURNING id",
      [task.id, stepNo],
      tx,
    )
    if (!updated.length) throw new Error('COMPUTER_USE_LEASE_LOST')
    const id = randomUUID()
    await query(
      `INSERT INTO computer_use_steps(id,task_id,step_no,action,decision,reason,reasoning,url_before,url_after,title,screenshot_path,screenshot_bytes,call_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        task.id,
        stepNo,
        record.action,
        record.decision,
        record.reason || '',
        (record.reasoning || '').slice(0, 2000),
        (record.urlBefore || '').slice(0, 4000),
        (record.urlAfter || '').slice(0, 4000),
        (record.title || '').slice(0, 500),
        record.screenshot?.path ?? null,
        record.screenshot?.bytes ?? 0,
        record.callKey ?? null,
      ],
      tx,
    )
    return id
  }
  return db ? run(db) : transaction(run)
}

async function historyOf(taskId: string): Promise<StepHistory[]> {
  const rows = await query(
    'SELECT step_no,action,decision,reason,url_after FROM computer_use_steps WHERE task_id=$1 ORDER BY step_no DESC LIMIT $2',
    [taskId, P.maxHistorySteps],
  )
  return rows.reverse().map((row) => ({
    stepNo: row.step_no,
    action: row.action,
    decision: row.decision,
    reason: row.reason,
    urlAfter: row.url_after,
  }))
}

async function finishTask(
  task: TaskRow,
  status: 'done' | 'failed',
  report: string,
  error: string,
  agent: VmAgentClient,
) {
  await transaction(async (db) => {
    await query('SELECT id FROM computer_use WHERE id=true FOR UPDATE', [], db)
    await endTask(db, task, status, report, error)
    await query(
      status === 'done'
        ? "UPDATE computer_use SET failures=0,last_error='' WHERE id=true"
        : 'UPDATE computer_use SET failures=failures+1,last_error=$1 WHERE id=true',
      status === 'done' ? [] : [error],
      db,
    )
    await audit(
      'computer_use_task',
      status === 'done'
        ? 'Задание браузера завершено, отчёт сохранён.'
        : 'Задание браузера остановлено без отчёта.',
      { taskId: task.id, status, error, source: task.source },
      db,
    )
  })
  if (task.session_id) await agent.endSession(task.session_id).catch(() => undefined)
}

function safeError(error: unknown) {
  if (error instanceof VmAgentUnavailable) return error.message
  if (
    error instanceof Error &&
    /^(COMPUTER_|BUDGET_|OPENAI_|OPENROUTER_|PROVIDER_|MODEL_|UNCERTAIN_|CONTEXT_|INVALID_|STOPPED$|PAUSED$|RESERVATION_)[A-Z_0-9]*$/.test(
      error.message,
    )
  )
    return error.message
  return 'COMPUTER_USE_STEP_FAILED'
}
/** Codes that leave the task resumable: nothing about the task itself went wrong. */
const resumable =
  /^(STOPPED|PAUSED|COMPUTER_USE_PAUSED|COMPUTER_USE_DAILY_LIMIT|BUDGET_BLOCKED|OPENAI_BUDGET_BLOCKED|WORKER_DRAINING|COMPUTER_USE_LEASE_LOST)$/

type Outcome = { kind: 'continue' | 'stop' }

async function ensureSession(task: TaskRow, agent: VmAgentClient) {
  if (task.session_id) return task.session_id
  const sessionId = await agent.startSession()
  await query('UPDATE computer_use_tasks SET session_id=$2 WHERE id=$1', [task.id, sessionId])
  task.session_id = sessionId
  return sessionId
}

async function perform(
  task: TaskRow,
  agent: VmAgentClient,
  action: BrowserAction,
): Promise<{ ok: boolean; error: string; url: string; title: string }> {
  const sessionId = await ensureSession(task, agent)
  return agent.act(sessionId, action)
}

/** A decided approval becomes a step: the owner's action runs or the refusal is recorded. */
async function applyResolvedApproval(task: TaskRow, agent: VmAgentClient, stepNo: number) {
  const [approval] = await query(
    `SELECT * FROM computer_use_approvals WHERE task_id=$1 AND status IN ('approved','rejected','expired')
     AND executed_at IS NULL ORDER BY created_at LIMIT 1`,
    [task.id],
  )
  if (!approval) return false
  const action = approval.action as BrowserAction
  if (approval.status === 'approved') {
    const result = await perform(task, agent, action)
    await recordStep(task, stepNo, {
      action,
      decision: result.ok ? 'approved' : 'failed',
      reason: result.ok ? 'COMPUTER_USE_OWNER_APPROVED' : result.error,
      urlAfter: result.url,
      title: result.title,
    })
  } else
    await recordStep(task, stepNo, {
      action,
      decision: 'rejected',
      reason:
        approval.status === 'rejected'
          ? 'COMPUTER_USE_OWNER_REJECTED'
          : 'COMPUTER_USE_APPROVAL_EXPIRED',
    })
  await query('UPDATE computer_use_approvals SET executed_at=now() WHERE id=$1', [approval.id])
  return true
}

/** Text of the directly preceding typed steps, so card data typed in pieces is recognised. */
export function typedBefore(history: StepHistory[]) {
  let text = ''
  for (let i = history.length - 1; i >= 0; i--) {
    const step = history[i]!
    if (step.action.name !== 'type' || step.decision !== 'allowed') break
    text = `${String(step.action.text ?? '')}${text}`
  }
  return text.slice(-4000)
}

async function requestApproval(
  task: TaskRow,
  stepNo: number,
  action: BrowserAction,
  reason: string,
  record: StepRecord,
) {
  await transaction(async (db) => {
    await recordStep(task, stepNo, record, db)
    await query(
      'INSERT INTO computer_use_approvals(id,task_id,step_no,action,reason) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), task.id, stepNo, action, reason.slice(0, 1000)],
      db,
    )
    await query(
      "UPDATE computer_use_tasks SET status='waiting_approval' WHERE id=$1 AND status='running'",
      [task.id],
      db,
    )
    await audit(
      'computer_use_approval_requested',
      'Модель просит подтверждение владельца перед действием в браузере.',
      { taskId: task.id, stepNo, action: action.name },
      db,
    )
  })
}

async function runStep(
  claim: Claim,
  agent: VmAgentClient,
  model: ComputerUseModel,
): Promise<Outcome> {
  const [task] = await query<TaskRow>('SELECT * FROM computer_use_tasks WHERE id=$1', [
    claim.task.id,
  ])
  if (!task || task.status !== 'running') {
    if (task?.session_id && task.status !== 'waiting_approval')
      await agent.endSession(task.session_id).catch(() => undefined)
    return { kind: 'stop' }
  }
  if (!(await renewLease(claim.leaseId))) return { kind: 'stop' }
  const stepNo = task.step_count + 1
  if (await applyResolvedApproval(task, agent, stepNo)) return { kind: 'continue' }
  if (task.step_count >= task.step_limit) {
    await finishTask(task, 'failed', '', 'COMPUTER_USE_STEP_LIMIT', agent)
    return { kind: 'stop' }
  }
  const c = config()
  const sessionId = await ensureSession(task, agent)
  const shot = await agent.screenshot(sessionId)
  const screenshot = await saveScreenshot(task.id, stepNo, shot.png)
  const page: PageContext = { url: shot.url, title: shot.title, focused: shot.focused }
  const history = await historyOf(task.id)
  const [found] = await query(
    'SELECT count(*)::int AS n FROM computer_use_opportunities WHERE task_id=$1',
    [task.id],
  )
  const input = {
    taskId: task.id,
    reservationId: task.reservation_id!,
    goal: task.goal,
    stepNo,
    stepLimit: task.step_limit,
    history,
    page,
    png: shot.png,
    opportunities: found!.n as number,
  }
  if (!task.is_demo) {
    const estimate = prepareStepRequest(input).maximumMicrousd
    const spent = await taskSpend(task.reservation_id)
    if (spent.microusd + estimate > task.cost_cap_microusd) {
      await finishTask(task, 'failed', '', 'COMPUTER_USE_TASK_CAP', agent)
      return { kind: 'stop' }
    }
    const day = await dailySpend()
    if (day.microusd + estimate > c.COMPUTER_USE_DAILY_CAP_MICROUSD) {
      await query("UPDATE computer_use SET last_error='COMPUTER_USE_DAILY_LIMIT' WHERE id=true")
      return { kind: 'stop' }
    }
  }
  const callKey = `computer-use:${task.id}:${stepNo}`
  const raw = await model(input)
  let call: ToolCall
  try {
    call = parseToolCall(raw.name, raw.arguments)
  } catch {
    const invalidInRow = history
      .slice(-(P.maxInvalidInRow - 1))
      .filter((h) => h.decision === 'invalid')
    await recordStep(task, stepNo, {
      action: { name: raw.name.slice(0, 60) },
      decision: 'invalid',
      reason: 'COMPUTER_USE_TOOL_CALL_INVALID',
      reasoning: raw.note,
      urlBefore: page.url,
      urlAfter: page.url,
      title: page.title,
      screenshot,
      callKey,
    })
    if (invalidInRow.length >= P.maxInvalidInRow - 1) {
      await finishTask(task, 'failed', '', 'COMPUTER_USE_MODEL_INVALID', agent)
      return { kind: 'stop' }
    }
    return { kind: 'continue' }
  }
  const base: StepRecord = {
    action: call,
    decision: 'allowed',
    reasoning: raw.note,
    urlBefore: page.url,
    urlAfter: page.url,
    title: page.title,
    screenshot,
    callKey,
  }
  if (call.name === 'finish') {
    await recordStep(task, stepNo, base)
    await finishTask(task, 'done', call.report, '', agent)
    return { kind: 'stop' }
  }
  if (call.name === 'note_opportunity') {
    const host = hostOf(call.url)
    const reason =
      !host || isPrivateHost(host)
        ? 'COMPUTER_USE_URL_SCHEME'
        : forbiddenTextReason(`${call.title} ${call.summary}`) ||
          ((found!.n as number) >= P.maxOpportunitiesPerTask
            ? 'COMPUTER_USE_OPPORTUNITY_LIMIT'
            : '')
    if (reason) {
      await recordStep(task, stepNo, { ...base, decision: 'blocked', reason })
      return { kind: 'continue' }
    }
    await transaction(async (db) => {
      await recordStep(task, stepNo, base, db)
      await query(
        `INSERT INTO computer_use_opportunities(id,task_id,step_no,title,url,summary,kind,requires_human,is_demo)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (task_id,url) DO NOTHING`,
        [
          randomUUID(),
          task.id,
          stepNo,
          call.title,
          call.url,
          call.summary,
          call.kind,
          call.requiresHuman,
          task.is_demo,
        ],
        db,
      )
    })
    return { kind: 'continue' }
  }
  if (call.name === 'request_approval') {
    const verdict = classifyAction(call.action, page)
    if (verdict.verdict === 'blocked') {
      await recordStep(task, stepNo, { ...base, decision: 'blocked', reason: verdict.reason })
      return { kind: 'continue' }
    }
    await requestApproval(task, stepNo, call.action, call.reason, {
      ...base,
      decision: 'approval',
      reason: 'COMPUTER_USE_MODEL_REQUESTED',
    })
    return { kind: 'stop' }
  }
  if (!browserActionNames.includes(call.name)) throw new Error('COMPUTER_USE_TOOL_CALL_INVALID')
  const action = call as BrowserAction
  const context: PageContext =
    action.name === 'click'
      ? { ...page, target: await agent.inspect(sessionId, action.x, action.y) }
      : action.name === 'type'
        ? { ...page, typedBefore: typedBefore(history) }
        : page
  const verdict = classifyAction(action, context)
  if (verdict.verdict === 'blocked') {
    await recordStep(task, stepNo, { ...base, decision: 'blocked', reason: verdict.reason })
    return { kind: 'continue' }
  }
  if (verdict.verdict === 'approval') {
    await requestApproval(task, stepNo, action, verdict.reason, {
      ...base,
      decision: 'approval',
      reason: verdict.reason,
    })
    return { kind: 'stop' }
  }
  const result = await perform(task, agent, action)
  await recordStep(task, stepNo, {
    ...base,
    decision: result.ok ? 'allowed' : 'failed',
    reason: result.ok ? '' : result.error.slice(0, 200),
    urlAfter: result.url,
    title: result.title,
  })
  return { kind: 'continue' }
}

export type ComputerUseDeps = { agent?: VmAgentClient; model?: ComputerUseModel }

/**
 * Drives at most one browser task per worker: screenshot, model, validation, policy, VM. Stops
 * on pause, stop, budget limits, an approval request or the end of the task; a resumable stop
 * leaves the task running without a lease.
 */
export async function computerUseTick(deps: ComputerUseDeps = {}, isStopping = () => false) {
  await ensureComputerUse()
  await expireApprovals()
  await cleanupScreenshots()
  if (isStopping()) return false
  const claim = await claimTask()
  if (!claim) return false
  const agent = deps.agent ?? vmAgentFromConfig()
  const model = deps.model ?? astraStep(demoScript)
  try {
    while (!isStopping()) {
      const outcome = await runStep(claim, agent, model)
      if (outcome.kind !== 'continue') break
    }
  } catch (error) {
    const code = safeError(error)
    if (resumable.test(code))
      await query('UPDATE computer_use SET last_error=$1 WHERE id=true AND lease_id=$2', [
        code,
        claim.leaseId,
      ])
    else {
      const [task] = await query<TaskRow>('SELECT * FROM computer_use_tasks WHERE id=$1', [
        claim.task.id,
      ])
      if (task && ['running', 'waiting_approval'].includes(task.status))
        await finishTask(task, 'failed', '', code, agent)
    }
  } finally {
    await releaseLease(claim.leaseId)
  }
  return true
}
