import { audit, query, transaction } from '../db'
import { VmAgentUnavailable, vmAgentFromConfig, type VmAgentClient } from './client'
import { COMPUTER_USE_POLICY as P } from './policy'
import type { BrowserAction } from './schema'
import { ensureComputerUse, type ComputerUseRow } from './runtime'

/**
 * The owner's remote control of the VM browser: log platforms in once, fix a stuck page. The
 * owner acts on a session of their own in the same persistent profile; while the manual lease
 * lasts, the worker runs no model step, and nothing typed here is stored or shown to the model.
 * Only the length of typed text reaches the audit log.
 */

let cached: VmAgentClient | null = null
/** One client per process: the demo stand-in keeps its sessions between requests. */
function agent() {
  cached ??= vmAgentFromConfig()
  return cached
}
/** Tests inject a stand-in; `null` returns to the configured link. */
export function setManualAgent(value: VmAgentClient | null) {
  cached = value
}

export async function manualState() {
  await ensureComputerUse()
  const [row] = await query<ComputerUseRow>('SELECT * FROM computer_use WHERE id=true')
  const until = row?.manual_until?.getTime() ?? 0
  return { active: until > Date.now(), until: until ? new Date(until).toISOString() : null }
}

/** Starts or extends the lease. The worker hands its task back at the next step. */
export async function startManual() {
  await ensureComputerUse()
  await transaction(async (db) => {
    const [row] = await query<ComputerUseRow>(
      'SELECT * FROM computer_use WHERE id=true FOR UPDATE',
      [],
      db,
    )
    const fresh = !row?.manual_until || row.manual_until.getTime() <= Date.now()
    await query(
      `UPDATE computer_use SET manual_until=now()+$1*interval '1 millisecond',updated_at=now() WHERE id=true`,
      [P.manualLeaseMs],
      db,
    )
    if (fresh)
      await audit(
        'computer_use_manual',
        'Владелец взял управление браузером на машине. Шаги модели приостановлены.',
        {},
        db,
      )
  })
  return manualState()
}

/** Ends the lease and the owner's browser session; the profile keeps its logins. */
export async function stopManual() {
  await ensureComputerUse()
  const sessionId = await transaction(async (db) => {
    const [row] = await query<ComputerUseRow>(
      'SELECT * FROM computer_use WHERE id=true FOR UPDATE',
      [],
      db,
    )
    await query(
      'UPDATE computer_use SET manual_until=NULL,manual_session_id=NULL,updated_at=now() WHERE id=true',
      [],
      db,
    )
    if (row?.manual_until)
      await audit('computer_use_manual', 'Владелец вернул управление модели.', {}, db)
    return row?.manual_session_id ?? null
  })
  if (sessionId)
    await agent()
      .endSession(sessionId)
      .catch(() => undefined)
  return manualState()
}

async function requireActive() {
  const state = await manualState()
  if (!state.active) throw new Error('COMPUTER_USE_MANUAL_NOT_ACTIVE')
}

/** The owner's own VM session, started on first use and replaced when the VM lost it. */
async function manualSession(retry = true): Promise<string> {
  const [row] = await query<ComputerUseRow>(
    'SELECT manual_session_id FROM computer_use WHERE id=true',
  )
  if (row?.manual_session_id) {
    try {
      await agent().state(row.manual_session_id)
      return row.manual_session_id
    } catch (error) {
      if (!(error instanceof VmAgentUnavailable && error.message === 'COMPUTER_USE_SESSION_LOST'))
        throw error
      await query(
        'UPDATE computer_use SET manual_session_id=NULL WHERE id=true AND manual_session_id=$1',
        [row.manual_session_id],
      )
      if (!retry) throw error
    }
  }
  const id = await agent().startSession()
  await query('UPDATE computer_use SET manual_session_id=$1 WHERE id=true', [id])
  return id
}

/** A live picture for the owner only; nothing is written to disk or the step log. */
export async function manualScreenshot() {
  await requireActive()
  const id = await manualSession()
  const shot = await agent().screenshot(id)
  return { png: shot.png, url: shot.url, title: shot.title }
}

/**
 * Performs one owner action. The text of `type` never reaches the database: the audit row holds
 * the action name, the character count and the page it ended on. Each action extends the lease.
 */
export async function manualAct(action: BrowserAction) {
  await requireActive()
  const id = await manualSession()
  const result = await agent().act(id, action)
  await query(
    `UPDATE computer_use SET manual_until=now()+$1*interval '1 millisecond' WHERE id=true AND manual_until > now()`,
    [P.manualLeaseMs],
  )
  await audit('computer_use_manual_action', 'Действие владельца в браузере на машине.', {
    action: action.name,
    chars: action.name === 'type' ? action.text.length : undefined,
    key: action.name === 'key' ? action.key : undefined,
    host:
      action.name === 'navigate' && URL.canParse(action.url) ? new URL(action.url).host : undefined,
    ok: result.ok,
    error: result.error,
    urlAfterHost: URL.canParse(result.url) ? new URL(result.url).host : '',
  })
  return { ok: result.ok, error: result.error, url: result.url, title: result.title }
}
