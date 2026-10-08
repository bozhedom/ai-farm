import { randomUUID } from 'node:crypto'
import { audit, query, type Connection } from './db'
import { POLICY } from './policy'

type WindowState = {
  mode: 'running' | 'paused' | 'emergency_stop'
  generation: number
  generation_started_at: Date
  research_enabled: boolean
  schedule_enabled: boolean
  research_scope: 'rotate' | 'all'
  research_deadline: Date
  research_window_expired: boolean
  research_window_key: string
}

/** Call inside a transaction, before taking job or reservation locks. */
export async function lockResearchWindow(db: Connection) {
  await query('SELECT id FROM system_state WHERE id=true FOR UPDATE', [], db)
  // Late call settlement also locks budget before reservations. Keep that order
  // when closing queued work, including when this guard runs inside meteredCall.
  await query('SELECT pg_advisory_xact_lock(735093)', [], db)
  const [state] = await query<WindowState>(
    `SELECT *, generation_started_at + $1 * interval '24 hours' AS research_deadline,
     clock_timestamp() >= generation_started_at + $1 * interval '24 hours' AS research_window_expired,
     'research-window:' || generation::text || ':' || extract(epoch FROM generation_started_at)::text AS research_window_key
     FROM system_state WHERE id=true`,
    [POLICY.researchWindowDays],
    db,
  )
  if (!state) throw new Error('SYSTEM_STATE_UNAVAILABLE')
  if (!state.research_window_expired) return state
  if (state.research_enabled)
    await query('UPDATE system_state SET research_enabled=false WHERE id=true', [], db)
  state.research_enabled = false
  const retired = await query<{ id: string }>(
    `UPDATE jobs SET status='failed',error_code='RESEARCH_WINDOW_CLOSED',finished_at=clock_timestamp(),
     locked_until=null,lease_token=null WHERE kind='research' AND status='queued' RETURNING id`,
    [],
    db,
  )
  if (retired.length) {
    await query(
      "UPDATE budget_reservations SET status='closed' WHERE dedupe_key=ANY($1::text[])",
      [retired.map((job) => `research:${job.id}`)],
      db,
    )
    await audit(
      'research_window_jobs_closed',
      'Окно исследований истекло. Задания в очереди завершены; ответы, расходы и история сохранены.',
      { jobIds: retired.map((job) => job.id), window: state.research_window_key },
      db,
    )
  }
  const reason = `Эксперимент завершён без денежного победителя: за ${POLICY.researchWindowDays} дней нет реальных сопоставимых продаж.`
  const recorded = await query(
    `INSERT INTO evaluations(id,evaluation_key,generation,decision,reason,details)
     VALUES($1,$2,$3,'CLOSED',$4,$5) ON CONFLICT(evaluation_key) DO NOTHING RETURNING id`,
    [
      randomUUID(),
      state.research_window_key,
      state.generation,
      reason,
      {
        realRevenueKopecks: 0,
        startedAt: state.generation_started_at,
        deadline: state.research_deadline,
      },
    ],
    db,
  )
  if (recorded.length)
    await audit(
      'evaluation',
      reason,
      { generation: state.generation, decision: 'CLOSED', window: state.research_window_key },
      db,
    )
  return state
}
