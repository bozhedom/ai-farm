import { createHash, randomUUID } from 'node:crypto'
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
  normalizeUrl,
  validateGoal,
  type PageContext,
} from './policy'
import {
  browserActionNames,
  chunkStoredText,
  parseToolCall,
  type BrowserAction,
  type ToolCall,
  type VmAction,
} from './schema'
import { VmAgentUnavailable, vmAgentFromConfig, type VmAgentClient } from './client'
import {
  astraDocument,
  astraStep,
  demoScript,
  prepareDocumentRequest,
  prepareStepRequest,
  stepBudget,
  type ComputerUseModel,
  type DocumentWriter,
  type ModelInput,
  type StepHistory,
  type StoredForModel,
  type VisitedUrl,
} from './model'
import {
  aiForbiddenReason,
  forbiddenClaimReason,
  isFreelancePlatform,
  platformGoals,
  platformOf,
} from './platforms'

export interface ComputerUseRow {
  enabled: boolean
  auto_proposals: boolean
  rotation_index: number
  failures: number
  lease_id: string | null
  lease_until: Date | null
  manual_until: Date | null
  manual_session_id: string | null
  last_error: string
}
export interface PermitRow {
  id: string
  task_id: string
  platform_domain: string
  purpose: 'proposal' | 'delivery' | 'reply'
  proposal_id: string | null
  status: 'open' | 'used' | 'expired' | 'superseded'
  created_at: Date
  expires_at: Date
  used_at: Date | null
  used_step_no: number | null
  used_url: string
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

export type ControlAction = 'enable' | 'pause' | 'auto_proposals_on' | 'auto_proposals_off'
const controlWords: Record<ControlAction, string> = {
  enable: 'Владелец включил работу модели в браузере на отдельной машине.',
  pause: 'Владелец выключил работу модели в браузере. Начатое задание ждёт.',
  auto_proposals_on:
    'Владелец разрешил модели самой отправлять отклики, ответы и результаты на площадках, где выполнен вход.',
  auto_proposals_off: 'Владелец запретил самостоятельную отправку откликов и ответов.',
}
export async function controlComputerUse(action: ControlAction) {
  await ensureComputerUse()
  await transaction(async (db) => {
    await query('SELECT * FROM computer_use WHERE id=true FOR UPDATE', [], db)
    if (action === 'enable')
      await query(
        "UPDATE computer_use SET enabled=true,failures=0,last_error='',updated_at=now() WHERE id=true",
        [],
        db,
      )
    else if (action === 'pause')
      await query('UPDATE computer_use SET enabled=false,updated_at=now() WHERE id=true', [], db)
    else
      await query(
        'UPDATE computer_use SET auto_proposals=$1,updated_at=now() WHERE id=true',
        [action === 'auto_proposals_on'],
        db,
      )
    await audit('computer_use_control', controlWords[action], { action }, db)
  })
}

/** The owner marks where the browser profile is logged in; only known platforms are accepted. */
export async function setPlatformLogin(domain: string, loggedIn: boolean) {
  const name = domain.trim().toLowerCase()
  if (!isFreelancePlatform(name)) throw new Error('COMPUTER_USE_PLATFORM_UNKNOWN')
  await query(
    `INSERT INTO computer_use_platforms(domain,logged_in) VALUES($1,$2)
     ON CONFLICT (domain) DO UPDATE SET logged_in=EXCLUDED.logged_in,updated_at=now()`,
    [name, loggedIn],
  )
  await audit(
    'computer_use_platform',
    loggedIn
      ? 'Владелец отметил площадку как открытую под его аккаунтом.'
      : 'Владелец снял отметку входа на площадке.',
    { domain: name, loggedIn },
  )
}
export async function loggedInPlatforms(db?: Connection) {
  const rows = await query<{ domain: string }>(
    'SELECT domain FROM computer_use_platforms WHERE logged_in ORDER BY domain',
    [],
    db,
  )
  return rows.map((row) => row.domain).filter(isFreelancePlatform)
}
/** Goals in rotation order: logged-in platforms first, then the research themes. */
export async function currentRotationGoals(db?: Connection) {
  const platforms = await loggedInPlatforms(db)
  return [...platformGoals(platforms, config().COMPUTER_USE_PROPOSALS_PER_DAY), ...rotationGoals]
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
  await query(
    "UPDATE computer_use_send_permits SET status='expired' WHERE task_id=$1 AND status='open'",
    [task.id],
    db,
  )
  await query(
    "UPDATE computer_use_proposals SET status='expired' WHERE task_id=$1 AND status='draft'",
    [task.id],
    db,
  )
  if (task.reservation_id) await closeReservation(task.reservation_id, db)
}

/** A permit nobody used in 15 minutes closes with its draft; the model sees the status. */
async function expirePermits() {
  await transaction(async (db) => {
    const expired = await query<PermitRow>(
      `UPDATE computer_use_send_permits SET status='expired'
       WHERE status='open' AND expires_at <= now() RETURNING *`,
      [],
      db,
    )
    for (const permit of expired)
      if (permit.proposal_id)
        await query(
          "UPDATE computer_use_proposals SET status='expired' WHERE id=$1 AND status='draft'",
          [permit.proposal_id],
          db,
        )
  })
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

type Claim = {
  task: TaskRow
  leaseId: string
  /** The previous step's screen within this tick: its hash and whether the model got it. */
  lastImage?: { stepNo: number; sha: string; sent: boolean }
}

/**
 * The screenshot is left out of a step only when the model saw a byte-identical screen on the
 * directly preceding step of this tick and that step was note_opportunity: a record on the
 * server that changes nothing in the browser, typically followed by another record or a
 * navigate from the links. Proposals, documents and permits are followed by clicks into the
 * page, so they always get a picture. Never twice in a row; page text and links are always sent.
 */
export function canOmitScreenshot(
  stepNo: number,
  sha: string,
  last: Claim['lastImage'],
  previous: StepHistory | undefined,
) {
  if (!P.omitUnchangedScreenshots) return false
  if (!last || !last.sent || last.stepNo !== stepNo - 1 || last.sha !== sha) return false
  if (!previous || previous.stepNo !== stepNo - 1) return false
  return previous.action.name === 'note_opportunity' && previous.decision === 'allowed'
}

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
    // The owner is at the browser: no model step until the manual lease ends.
    if (owner.manual_until && owner.manual_until.getTime() > now) return null
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
      const goals = await currentRotationGoals(db)
      const goal = goals[owner.rotation_index % goals.length]!
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
     WHERE id=true AND lease_id=$1 AND enabled AND (manual_until IS NULL OR manual_until <= now())
     RETURNING id`,
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

/**
 * Addresses this task has opened, most recent first: arrivals on a page (a navigate or an action
 * that changed the address) and navigate attempts that reached the VM. Feeds the model's
 * visited list and the loop guard.
 */
export async function visitedUrls(taskId: string, db?: Connection): Promise<VisitedUrl[]> {
  const rows = await query(
    'SELECT step_no,action,decision,url_before,url_after FROM computer_use_steps WHERE task_id=$1 ORDER BY step_no',
    [taskId],
    db,
  )
  const seen = new Map<string, VisitedUrl & { last: number }>()
  const entry = (url: string, stepNo: number) => {
    const key = normalizeUrl(url)
    const found = seen.get(key) ?? { url: key, visits: 0, navigates: 0, last: stepNo }
    found.last = stepNo
    seen.set(key, found)
    return found
  }
  for (const row of rows) {
    const reached = ['allowed', 'approved', 'failed'].includes(row.decision)
    if (!reached) continue
    if (row.action?.name === 'navigate' && typeof row.action.url === 'string')
      entry(row.action.url, row.step_no).navigates++
    const after = String(row.url_after || '')
    if (
      /^https?:\/\//.test(after) &&
      row.decision !== 'failed' &&
      (row.action?.name === 'navigate' ||
        normalizeUrl(after) !== normalizeUrl(String(row.url_before || '')))
    )
      entry(after, row.step_no).visits++
  }
  return [...seen.values()]
    .sort((a, b) => b.last - a.last)
    .map(({ url, visits, navigates }) => ({ url, visits, navigates }))
}

async function finishTask(
  task: TaskRow,
  status: 'done' | 'failed',
  report: string,
  error: string,
  agent: VmAgentClient,
  endedBy: 'model' | 'limit' = 'model',
) {
  await transaction(async (db) => {
    await query('SELECT id FROM computer_use WHERE id=true FOR UPDATE', [], db)
    await endTask(db, task, status, report, error)
    // Only a real failure counts towards the pause after three in a row; a task that reached its
    // step or cost limit worked normally.
    await query(
      status === 'done'
        ? "UPDATE computer_use SET failures=0,last_error='' WHERE id=true"
        : 'UPDATE computer_use SET failures=failures+1,last_error=$1 WHERE id=true',
      status === 'done' ? [] : [error],
      db,
    )
    await audit(
      'computer_use_task',
      status !== 'done'
        ? 'Задание браузера остановлено без отчёта.'
        : endedBy === 'limit'
          ? 'Задание браузера завершено по лимиту, отчёт собран сервером из записей задания.'
          : 'Задание браузера завершено, отчёт сохранён.',
      { taskId: task.id, status, error, source: task.source, endedBy },
      db,
    )
  })
  if (task.session_id) await agent.endSession(task.session_id).catch(() => undefined)
}

export type LimitReason = 'COMPUTER_USE_STEP_LIMIT' | 'COMPUTER_USE_TASK_CAP'
const limitWords: Record<LimitReason, string> = {
  COMPUTER_USE_STEP_LIMIT: 'израсходованы все шаги задания',
  COMPUTER_USE_TASK_CAP: 'исчерпан лимит расходов на одно задание',
}
const decisionWords: Record<string, string> = {
  take: 'беру сам',
  human: 'нужен владелец',
  skip: 'пропуск',
}
const proposalWords: Record<string, string> = {
  draft: 'черновик',
  sent: 'отправлен',
  failed: 'не отправлен',
  expired: 'истёк',
}
const usd = (microusd: number) => `$${(microusd / 1_000_000).toFixed(2)}`

/**
 * The report of a task that reached its step or cost limit before the model called `finish`:
 * assembled by the server from what the task recorded, with no extra model call.
 */
export async function limitReport(task: TaskRow, reason: LimitReason, db?: Connection) {
  const [opportunities, proposals, documents, pages, spent] = await Promise.all([
    query(
      `SELECT title,url,decision,fit,requires_human,ai_forbidden,estimated_value_minor,estimated_currency
       FROM computer_use_opportunities WHERE task_id=$1 ORDER BY step_no LIMIT 20`,
      [task.id],
      db,
    ),
    query(
      'SELECT status,count(*)::int AS n FROM computer_use_proposals WHERE task_id=$1 GROUP BY status ORDER BY status',
      [task.id],
      db,
    ),
    query(
      'SELECT title FROM computer_use_documents WHERE task_id=$1 ORDER BY step_no LIMIT 5',
      [task.id],
      db,
    ),
    query<{ url: string }>(
      `SELECT url_after AS url FROM computer_use_steps WHERE task_id=$1 AND url_after ~ '^https?://'
       GROUP BY url_after ORDER BY min(step_no) LIMIT 12`,
      [task.id],
      db,
    ),
    taskSpend(task.reservation_id, db),
  ])
  const cost =
    task.cost_cap_microusd > 0
      ? `, расход ${usd(spent.microusd)} из ${usd(task.cost_cap_microusd)}`
      : ''
  const lines = [
    `Задание завершено сервером: ${limitWords[reason]} (шагов ${task.step_count} из ${task.step_limit}${cost}). Модель не вызвала finish; ниже то, что записано в задании.`,
  ]
  if (opportunities.length) {
    lines.push('', `Находки (${opportunities.length}):`)
    opportunities.forEach((o, index) => {
      const notes = [
        decisionWords[o.decision] || o.decision,
        `соответствие ${o.fit}/100`,
        o.requires_human ? 'нужен человек' : '',
        o.ai_forbidden ? 'ИИ запрещён' : '',
        o.estimated_value_minor != null
          ? `оценка ${o.estimated_value_minor} ${o.estimated_currency} в минимальных единицах`
          : '',
      ].filter(Boolean)
      lines.push(`${index + 1}. ${o.title} - ${o.url} (${notes.join(', ')})`)
    })
  } else lines.push('', 'Находок не записано.')
  if (proposals.length)
    lines.push(
      '',
      `Отклики: ${proposals.map((p) => `${proposalWords[p.status] || p.status} ${p.n}`).join(', ')}.`,
    )
  if (documents.length)
    lines.push('', `Документы: ${documents.map((d) => `«${d.title}»`).join(', ')}.`)
  if (pages.length) lines.push('', 'Просмотренные страницы:', ...pages.map((p) => `- ${p.url}`))
  lines.push('', 'Находки - записи для проверки человеком, не доход.')
  return lines.join('\n').slice(0, 4000)
}

/** Reaching the step or cost limit is a normal end: done, the server's report, no failure. */
async function finishAtLimit(task: TaskRow, reason: LimitReason, agent: VmAgentClient) {
  await finishTask(task, 'done', await limitReport(task, reason), '', agent, 'limit')
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
  action: VmAction,
): Promise<{ ok: boolean; error: string; url: string; title: string }> {
  const sessionId = await ensureSession(task, agent)
  return agent.act(sessionId, action)
}

/**
 * A decided approval becomes a step: the owner's action runs or the refusal is recorded. The
 * approval is marked executed before the VM is contacted: an outward action runs at most once,
 * even if the worker dies between the action and its step row.
 */
async function applyResolvedApproval(task: TaskRow, agent: VmAgentClient, stepNo: number) {
  const [approval] = await query(
    `UPDATE computer_use_approvals SET executed_at=now() WHERE id=(
       SELECT id FROM computer_use_approvals WHERE task_id=$1
       AND status IN ('approved','rejected','expired') AND executed_at IS NULL
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
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

// ---------------------------------------------------------------------------------------------
// Freelance work: self-assessment, proposals, stored text, deliverables and send permits.

const utcDay = "created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"

async function openPermit(taskId: string, db?: Connection) {
  const [permit] = await query<PermitRow>(
    "SELECT * FROM computer_use_send_permits WHERE task_id=$1 AND status='open' AND expires_at > now()",
    [taskId],
    db,
  )
  return permit ?? null
}

/** What the model may refer to by id: this task's proposals, documents and the open permit. */
async function storedFor(taskId: string): Promise<StoredForModel> {
  const [proposals, documents, permit] = await Promise.all([
    query(
      'SELECT id,status,platform_domain,opportunity_url,length(text)::int AS chars FROM computer_use_proposals WHERE task_id=$1 ORDER BY created_at DESC LIMIT 5',
      [taskId],
    ),
    query(
      'SELECT id,title,kind,length(text)::int AS chars,left(text,1500) AS preview FROM computer_use_documents WHERE task_id=$1 ORDER BY created_at DESC LIMIT 5',
      [taskId],
    ),
    openPermit(taskId),
  ])
  return {
    proposals: proposals.map((p) => ({
      id: p.id,
      status: p.status,
      domain: p.platform_domain,
      url: p.opportunity_url,
      chars: p.chars,
    })),
    documents: documents.map((d, index) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      chars: d.chars,
      // The newest document carries its preview; older ones are known by id and title.
      preview: index === 0 ? d.preview : '',
    })),
    permit: permit
      ? {
          id: permit.id,
          domain: permit.platform_domain,
          purpose: permit.purpose,
          expiresAt: permit.expires_at.toISOString(),
        }
      : null,
  }
}

/**
 * Issues a single-use permit inside the caller's transaction. A previous open permit of the task
 * is superseded with its draft; the daily per-platform count is enforced here, not in prompts.
 */
async function grantPermit(
  db: Connection,
  task: TaskRow,
  domain: string,
  purpose: PermitRow['purpose'],
  proposalId: string | null,
) {
  const [count] = await query(
    `SELECT count(*)::int AS n FROM computer_use_send_permits WHERE platform_domain=$1 AND ${utcDay}`,
    [domain],
    db,
  )
  if (count!.n >= P.maxSendPermitsPerDomainPerDay)
    return { id: null, reason: 'COMPUTER_USE_SEND_LIMIT' }
  const superseded = await query<PermitRow>(
    "UPDATE computer_use_send_permits SET status='superseded' WHERE task_id=$1 AND status='open' RETURNING proposal_id",
    [task.id],
    db,
  )
  for (const old of superseded)
    if (old.proposal_id)
      await query(
        "UPDATE computer_use_proposals SET status='expired' WHERE id=$1 AND status='draft'",
        [old.proposal_id],
        db,
      )
  const id = randomUUID()
  await query(
    `INSERT INTO computer_use_send_permits(id,task_id,platform_domain,purpose,proposal_id,expires_at)
     VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 millisecond')`,
    [id, task.id, domain, purpose, proposalId, P.permitLifetimeMs],
    db,
  )
  await audit(
    'computer_use_permit',
    'Сервер выдал модели разрешение на одну отправку на площадке.',
    { taskId: task.id, permitId: id, domain, purpose, proposalId },
    db,
  )
  return { id, reason: '' }
}

/** The checks shared by draft_proposal and prepare_send; the first failing code wins. */
async function sendingAllowed(domain: string, db?: Connection) {
  const c = config()
  if (!isFreelancePlatform(domain)) return 'COMPUTER_USE_PLATFORM_UNKNOWN'
  const [owner] = await query<ComputerUseRow>('SELECT * FROM computer_use WHERE id=true', [], db)
  if (!c.COMPUTER_USE_AUTO_PROPOSALS || !owner?.auto_proposals)
    return 'COMPUTER_USE_AUTO_PROPOSALS_OFF'
  if (!(await loggedInPlatforms(db)).includes(domain)) return 'COMPUTER_USE_PLATFORM_NOT_LOGGED_IN'
  return ''
}

type DraftCall = Extract<ToolCall, { name: 'draft_proposal' }>
async function draftProposal(task: TaskRow, stepNo: number, call: DraftCall, base: StepRecord) {
  const c = config()
  const domain = call.platform_domain
  const reason =
    (await sendingAllowed(domain)) ||
    (platformOf(call.opportunity_url) !== domain ? 'COMPUTER_USE_PLATFORM_MISMATCH' : '') ||
    forbiddenTextReason(call.text) ||
    forbiddenClaimReason(call.text)
  if (reason) {
    await recordStep(task, stepNo, { ...base, decision: 'blocked', reason })
    return
  }
  const result = await transaction(async (db) => {
    await query('SELECT id FROM computer_use WHERE id=true FOR UPDATE', [], db)
    const [opportunity] = await query(
      'SELECT id,decision,ai_forbidden FROM computer_use_opportunities WHERE task_id=$1 AND url=$2',
      [task.id, call.opportunity_url],
      db,
    )
    if (!opportunity) return 'COMPUTER_USE_OPPORTUNITY_REQUIRED'
    if (opportunity.ai_forbidden) return 'COMPUTER_USE_AI_FORBIDDEN'
    if (opportunity.decision !== 'take') return 'COMPUTER_USE_DECISION_NOT_TAKE'
    const [count] = await query(
      `SELECT count(*)::int AS n FROM computer_use_proposals WHERE platform_domain=$1 AND ${utcDay}`,
      [domain],
      db,
    )
    if (count!.n >= c.COMPUTER_USE_PROPOSALS_PER_DAY) return 'COMPUTER_USE_PROPOSAL_LIMIT'
    const [sends] = await query(
      `SELECT count(*)::int AS n FROM computer_use_send_permits WHERE platform_domain=$1 AND ${utcDay}`,
      [domain],
      db,
    )
    if (sends!.n >= P.maxSendPermitsPerDomainPerDay) return 'COMPUTER_USE_SEND_LIMIT'
    const id = randomUUID()
    await query(
      `INSERT INTO computer_use_proposals(id,task_id,step_no,opportunity_id,opportunity_url,platform_domain,text,price_amount,price_currency,is_demo)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        task.id,
        stepNo,
        opportunity.id,
        call.opportunity_url,
        domain,
        call.text,
        call.price_amount,
        call.price_currency,
        task.is_demo,
      ],
      db,
    )
    const permit = await grantPermit(db, task, domain, 'proposal', id)
    if (!permit.id) throw new Error(permit.reason)
    await recordStep(task, stepNo, { ...base, reason: 'COMPUTER_USE_PERMIT_GRANTED' }, db)
    return ''
  })
  if (result) await recordStep(task, stepNo, { ...base, decision: 'blocked', reason: result })
}

type PrepareCall = Extract<ToolCall, { name: 'prepare_send' }>
async function prepareSend(task: TaskRow, stepNo: number, call: PrepareCall, base: StepRecord) {
  const reason = await sendingAllowed(call.domain)
  if (reason) {
    await recordStep(task, stepNo, { ...base, decision: 'blocked', reason })
    return
  }
  await transaction(async (db) => {
    await query('SELECT id FROM computer_use WHERE id=true FOR UPDATE', [], db)
    const permit = await grantPermit(db, task, call.domain, call.purpose, null)
    await recordStep(
      task,
      stepNo,
      permit.id
        ? { ...base, reason: 'COMPUTER_USE_PERMIT_GRANTED' }
        : { ...base, decision: 'blocked', reason: permit.reason },
      db,
    )
  })
}

/** Stored text of this task only: a proposal or a document, by id. */
async function storedText(taskId: string, id: string) {
  const [proposal] = await query(
    'SELECT text FROM computer_use_proposals WHERE id=$1 AND task_id=$2',
    [id, taskId],
  )
  if (proposal) return { kind: 'proposal' as const, text: proposal.text as string }
  const [document] = await query(
    'SELECT text FROM computer_use_documents WHERE id=$1 AND task_id=$2',
    [id, taskId],
  )
  if (document) return { kind: 'document' as const, text: document.text as string }
  return null
}

type TypeStoredCall = Extract<ToolCall, { name: 'type_stored' }>
async function typeStored(
  task: TaskRow,
  agent: VmAgentClient,
  stepNo: number,
  call: TypeStoredCall,
  page: PageContext,
  base: StepRecord,
) {
  const stored = await storedText(task.id, call.id)
  if (!stored) {
    await recordStep(task, stepNo, {
      ...base,
      decision: 'blocked',
      reason: 'COMPUTER_USE_STORED_NOT_FOUND',
    })
    return
  }
  // The same field rules as `type`: never into a password, card, code or payment field.
  const verdict = classifyAction(
    { name: 'type', text: stored.text.replace(/\n/g, ' ').slice(0, 2000) },
    page,
  )
  if (verdict.verdict !== 'allow') {
    await recordStep(task, stepNo, { ...base, decision: 'blocked', reason: verdict.reason })
    return
  }
  let result = { ok: true, error: '', url: page.url, title: page.title }
  for (const text of chunkStoredText(stored.text)) {
    result = await perform(task, agent, { name: 'insert_text', text })
    if (!result.ok) break
  }
  await recordStep(task, stepNo, {
    ...base,
    action: { ...call, kind: stored.kind, chars: stored.text.length },
    decision: result.ok ? 'allowed' : 'failed',
    reason: result.ok ? '' : result.error.slice(0, 200),
    urlAfter: result.url,
    title: result.title,
  })
}

type DocumentCall = Extract<ToolCall, { name: 'write_document' }>
async function writeDocument(
  task: TaskRow,
  stepNo: number,
  call: DocumentCall,
  base: StepRecord,
  writer: DocumentWriter,
) {
  const c = config()
  const [count] = await query(
    'SELECT count(*)::int AS n FROM computer_use_documents WHERE task_id=$1',
    [task.id],
  )
  const reason =
    forbiddenTextReason(`${call.title} ${call.brief}`) ||
    (count!.n >= P.maxDocumentsPerTask ? 'COMPUTER_USE_DOCUMENT_LIMIT' : '')
  if (reason) {
    await recordStep(task, stepNo, { ...base, decision: 'blocked', reason })
    return
  }
  const input = {
    taskId: task.id,
    reservationId: task.reservation_id!,
    stepNo,
    goal: task.goal,
    title: call.title,
    brief: call.brief,
    kind: call.kind,
  }
  if (!task.is_demo) {
    const estimate = prepareDocumentRequest(input).maximumMicrousd
    const spent = await taskSpend(task.reservation_id)
    const day = await dailySpend()
    const over =
      spent.microusd + estimate > task.cost_cap_microusd
        ? 'COMPUTER_USE_TASK_CAP'
        : day.microusd + estimate > c.COMPUTER_USE_DAILY_CAP_MICROUSD
          ? 'COMPUTER_USE_DAILY_LIMIT'
          : ''
    if (over) {
      await recordStep(task, stepNo, { ...base, decision: 'blocked', reason: over })
      return
    }
  }
  const { text } = await writer(input)
  const id = randomUUID()
  await transaction(async (db) => {
    await recordStep(task, stepNo, { ...base, action: { ...call, id } }, db)
    await query(
      `INSERT INTO computer_use_documents(id,task_id,step_no,title,brief,kind,text,is_demo)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, task.id, stepNo, call.title, call.brief, call.kind, text.slice(0, 12000), task.is_demo],
      db,
    )
  })
}

/**
 * Marks the permit used before the VM acts (at most one send per permit even if the worker
 * dies), performs the action and records the proposal as sent or failed with the page it ended on.
 */
async function performPermitted(
  task: TaskRow,
  agent: VmAgentClient,
  stepNo: number,
  action: BrowserAction,
  permit: PermitRow,
  base: StepRecord,
) {
  const [used] = await query<PermitRow>(
    `UPDATE computer_use_send_permits SET status='used',used_at=now(),used_step_no=$2
     WHERE id=$1 AND status='open' AND expires_at > now() RETURNING *`,
    [permit.id, stepNo],
  )
  if (!used) return false
  const result = await perform(task, agent, action)
  await transaction(async (db) => {
    await recordStep(
      task,
      stepNo,
      {
        ...base,
        decision: result.ok ? 'allowed' : 'failed',
        reason: result.ok ? 'COMPUTER_USE_SEND_PERMIT' : result.error.slice(0, 200),
        urlAfter: result.url,
        title: result.title,
      },
      db,
    )
    await query(
      'UPDATE computer_use_send_permits SET used_url=$2 WHERE id=$1',
      [permit.id, result.url.slice(0, 2000)],
      db,
    )
    if (permit.proposal_id)
      await query(
        result.ok
          ? "UPDATE computer_use_proposals SET status='sent',sent_at=now(),sent_url=$2 WHERE id=$1 AND status='draft'"
          : "UPDATE computer_use_proposals SET status='failed',sent_url=$2 WHERE id=$1 AND status='draft'",
        [permit.proposal_id, result.url.slice(0, 2000)],
        db,
      )
    await audit(
      'computer_use_send',
      result.ok
        ? 'Модель отправила текст на площадке по разрешению на одну отправку.'
        : 'Отправка по разрешению не удалась; разрешение использовано.',
      { taskId: task.id, permitId: permit.id, purpose: permit.purpose, ok: result.ok },
      db,
    )
  })
  return true
}

async function runStep(
  claim: Claim,
  agent: VmAgentClient,
  model: ComputerUseModel,
  writer: DocumentWriter,
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
    await finishAtLimit(task, 'COMPUTER_USE_STEP_LIMIT', agent)
    return { kind: 'stop' }
  }
  const c = config()
  const sessionId = await ensureSession(task, agent)
  const shot = await agent.screenshot(sessionId)
  const screenshot = await saveScreenshot(task.id, stepNo, shot.png)
  const page: PageContext = { url: shot.url, title: shot.title, focused: shot.focused }
  const history = await historyOf(task.id)
  const sha = createHash('sha256').update(shot.png).digest('hex')
  const omitImage = canOmitScreenshot(stepNo, sha, claim.lastImage, history.at(-1))
  claim.lastImage = { stepNo, sha, sent: !omitImage }
  const [found] = await query(
    'SELECT count(*)::int AS n FROM computer_use_opportunities WHERE task_id=$1',
    [task.id],
  )
  const [owner] = await query<ComputerUseRow>('SELECT * FROM computer_use WHERE id=true')
  const spent = task.is_demo ? { microusd: 0, kopecks: 0 } : await taskSpend(task.reservation_id)
  const visited = await visitedUrls(task.id)
  const input: ModelInput = {
    taskId: task.id,
    reservationId: task.reservation_id!,
    goal: task.goal,
    stepNo,
    stepLimit: task.step_limit,
    history,
    page,
    png: omitImage ? null : shot.png,
    screenshotUnchangedSince: omitImage ? stepNo - 1 : undefined,
    reading: { text: shot.text ?? '', links: shot.links ?? [] },
    opportunities: found!.n as number,
    stored: await storedFor(task.id),
    platforms: {
      loggedIn: await loggedInPlatforms(),
      autoProposals: c.COMPUTER_USE_AUTO_PROPOSALS && !!owner?.auto_proposals,
      proposalsPerDay: c.COMPUTER_USE_PROPOSALS_PER_DAY,
    },
    budget: stepBudget(stepNo, task.step_limit, spent.microusd, task.cost_cap_microusd),
    visited: visited.slice(0, P.maxVisitedShown),
  }
  if (!task.is_demo) {
    const estimate = prepareStepRequest(input).maximumMicrousd
    if (spent.microusd + estimate > task.cost_cap_microusd) {
      await finishAtLimit(task, 'COMPUTER_USE_TASK_CAP', agent)
      return { kind: 'stop' }
    }
    const day = await dailySpend()
    if (day.microusd + estimate > c.COMPUTER_USE_DAILY_CAP_MICROUSD) {
      await query("UPDATE computer_use SET last_error='COMPUTER_USE_DAILY_LIMIT' WHERE id=true")
      return { kind: 'stop' }
    }
    // Another step of the same size would not fit under the cap: this one is the last. The flag
    // only shortens the request (false -> true), so the estimate above still covers it.
    if (spent.microusd + 2 * estimate > task.cost_cap_microusd)
      input.budget = stepBudget(
        stepNo,
        task.step_limit,
        spent.microusd,
        task.cost_cap_microusd,
        true,
      )
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
        : forbiddenTextReason(`${call.title} ${call.summary} ${call.reason}`) ||
          ((found!.n as number) >= P.maxOpportunitiesPerTask
            ? 'COMPUTER_USE_OPPORTUNITY_LIMIT'
            : '')
    if (reason) {
      await recordStep(task, stepNo, { ...base, decision: 'blocked', reason })
      return { kind: 'continue' }
    }
    // The server decides what a ban on AI means: such a job is skipped whatever the model said.
    const aiForbidden =
      call.ai_forbidden || !!aiForbiddenReason(`${call.title}\n${call.summary}\n${call.reason}`)
    const decision = aiForbidden ? 'skip' : call.decision
    const record: StepRecord = {
      ...base,
      action: { ...call, ai_forbidden: aiForbidden, decision },
      reason: aiForbidden ? 'COMPUTER_USE_AI_FORBIDDEN' : '',
    }
    await transaction(async (db) => {
      await recordStep(task, stepNo, record, db)
      await query(
        `INSERT INTO computer_use_opportunities(id,task_id,step_no,title,url,summary,kind,requires_human,is_demo,decision,fit,ai_forbidden,estimated_value_minor,estimated_currency,reason,platform_domain)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (task_id,url) DO NOTHING`,
        [
          randomUUID(),
          task.id,
          stepNo,
          call.title,
          call.url,
          call.summary,
          call.kind,
          call.requiresHuman || decision === 'human',
          task.is_demo,
          decision,
          call.fit,
          aiForbidden,
          call.estimated_value?.amount ?? null,
          call.estimated_value?.currency ?? null,
          call.reason,
          platformOf(call.url),
        ],
        db,
      )
    })
    return { kind: 'continue' }
  }
  if (call.name === 'draft_proposal') {
    await draftProposal(task, stepNo, call, base)
    return { kind: 'continue' }
  }
  if (call.name === 'prepare_send') {
    await prepareSend(task, stepNo, call, base)
    return { kind: 'continue' }
  }
  if (call.name === 'type_stored') {
    await typeStored(task, agent, stepNo, call, page, base)
    return { kind: 'continue' }
  }
  if (call.name === 'write_document') {
    await writeDocument(task, stepNo, call, base, writer)
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
  if (omitImage && action.name === 'click') {
    // Coordinates without a picture are a guess; the next step carries the screenshot again.
    await recordStep(task, stepNo, {
      ...base,
      decision: 'blocked',
      reason: 'COMPUTER_USE_SCREENSHOT_REQUIRED',
    })
    return { kind: 'continue' }
  }
  if (action.name === 'navigate') {
    const target = normalizeUrl(action.url)
    const before = visited.find((v) => v.url === target)
    if (before && before.navigates >= P.maxNavigatesPerUrl) {
      await recordStep(task, stepNo, {
        ...base,
        decision: 'blocked',
        reason: 'COMPUTER_USE_LOOP_URL',
      })
      return { kind: 'continue' }
    }
  }
  const permit = await openPermit(task.id)
  const context: PageContext = {
    ...page,
    permit: permit ? { domain: permit.platform_domain } : null,
    ...(action.name === 'click'
      ? { target: await agent.inspect(sessionId, action.x, action.y) }
      : action.name === 'type'
        ? { typedBefore: typedBefore(history) }
        : {}),
  }
  let verdict = classifyAction(action, context)
  if (verdict.reason === 'COMPUTER_USE_SEND_PERMIT') {
    if (permit && (await performPermitted(task, agent, stepNo, action, permit, base)))
      return { kind: 'continue' }
    // The permit went away between the check and the claim: the ordinary rules apply.
    verdict = classifyAction(action, { ...context, permit: null })
  }
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

export type ComputerUseDeps = {
  agent?: VmAgentClient
  model?: ComputerUseModel
  document?: DocumentWriter
  now?: () => number
}

/**
 * Drives at most one browser task per worker: screenshot, model, validation, policy, VM. Stops
 * on pause, stop, budget limits, an approval request, the end of the task or the tick budget;
 * a resumable stop leaves the task running without a lease and the next tick picks it up.
 */
export async function computerUseTick(deps: ComputerUseDeps = {}, isStopping = () => false) {
  await ensureComputerUse()
  await expireApprovals()
  await expirePermits()
  await cleanupScreenshots()
  if (isStopping()) return false
  const claim = await claimTask()
  if (!claim) return false
  const agent = deps.agent ?? vmAgentFromConfig()
  const model = deps.model ?? astraStep(demoScript)
  const writer = deps.document ?? astraDocument
  const now = deps.now ?? Date.now
  const startedAt = now()
  try {
    while (!isStopping() && now() - startedAt < P.tickBudgetMs) {
      const outcome = await runStep(claim, agent, model, writer)
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
