import { randomUUID } from 'node:crypto'
import { audit, pool, query, transaction, type Connection } from './db'
import { templateSchema, type Template } from './policy'
import { config } from './config'

export type Job = {
  id: string
  kind: 'research' | 'fulfill' | 'evaluate'
  payload: Record<string, string>
  attempts: number
  max_attempts: number
  lease_token: string
}
export async function enqueue(
  kind: Job['kind'],
  key: string,
  payload: Record<string, string> = {},
  db: Connection = pool,
) {
  const [row] = await query(
    'INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id,status',
    [randomUUID(), kind, key, payload],
    db,
  )
  return row!
}
export async function claimJob(kinds: Job['kind'][]): Promise<Job | undefined> {
  return transaction(async (db) => {
    // Serialize research claims across workers, including a manual run racing the scheduler.
    if (kinds.includes('research'))
      await query('SELECT id FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [row] = await query<Job>(
      `SELECT j.* FROM jobs j CROSS JOIN system_state s
      WHERE j.kind=ANY($1) AND j.status='queued' AND j.run_after<=now() AND j.attempts<j.max_attempts
      AND (j.kind='evaluate' OR (j.kind='research' AND s.mode='running' AND s.research_enabled) OR (j.kind='fulfill' AND s.mode<>'emergency_stop'))
      AND (j.kind<>'research' OR NOT EXISTS (SELECT 1 FROM jobs active WHERE active.kind='research' AND active.status='running'))
      AND (j.kind<>'research' OR j.dedupe_key !~ '^research:[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR ($2 AND s.schedule_enabled))
      ORDER BY CASE j.kind WHEN 'fulfill' THEN 0 ELSE 1 END,j.created_at
      FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      [kinds, config().AUTONOMY_ENABLED],
      db,
    )
    if (!row) return
    const [claimed] = await query<Job>(
      `UPDATE jobs SET status='running', attempts=attempts+1,started_at=COALESCE(started_at,now()),
      locked_until=now()+interval '2 minutes', lease_token=$2 WHERE id=$1 RETURNING *`,
      [row.id, randomUUID()],
      db,
    )
    return claimed
  })
}

/** Owners may start a new run when the previous one ends; parallel clicks share the active job. */
export async function requestResearch(template?: Template) {
  if (template !== undefined) templateSchema.parse(template)
  return transaction(async (db) => {
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    if (state?.mode !== 'running') throw new Error('RESEARCH_PAUSED')
    if (!state.research_enabled) throw new Error('RESEARCH_WINDOW_CLOSED')
    const [active] = await query(
      `SELECT id,status FROM jobs WHERE kind='research' AND status IN ('queued','running')
       AND (status='running' OR dedupe_key !~ '^research:[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR $1)
       ORDER BY created_at LIMIT 1`,
      [config().AUTONOMY_ENABLED && state.schedule_enabled],
      db,
    )
    if (active) return { id: active.id as string, status: active.status as string, reused: true }
    const job = await enqueue(
      'research',
      `manual-research:${randomUUID()}`,
      template ? { templates: JSON.stringify([template]) } : {},
      db,
    )
    await audit(
      'research_requested',
      'Владелец запустил дополнительное исследование.',
      { jobId: job.id, template: template || 'auto' },
      db,
    )
    return { id: job.id as string, status: job.status as string, reused: false }
  })
}
export async function heartbeatJob(job: Job) {
  const result = await query(
    "UPDATE jobs SET locked_until=now()+interval '2 minutes' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
    [job.id, job.lease_token],
  )
  if (!result.length) throw new Error('LEASE_LOST')
}
export async function finishJob(job: Job, error?: unknown) {
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
      ? error.message
      : error
        ? 'JOB_FAILED'
        : null
  await transaction(async (db) => {
    const [current] = await query(
      'SELECT * FROM jobs WHERE id=$1 AND lease_token=$2 FOR UPDATE',
      [job.id, job.lease_token],
      db,
    )
    if (!current || current.status !== 'running') return
    const terminal =
      !!code &&
      (job.attempts >= job.max_attempts ||
        /POLICY|UNCERTAIN|BUDGET|INPUT|SOURCE|SCHEMA|REVIEW|OUTPUT|PROVIDER_CHANGED/.test(code))
    await query(
      `UPDATE jobs SET status=$2,error_code=$3,locked_until=null,lease_token=null,
      run_after=now()+make_interval(secs=>$4),finished_at=CASE WHEN $2 IN ('done','failed') THEN now() ELSE null END WHERE id=$1`,
      [
        job.id,
        code ? (terminal ? 'failed' : 'queued') : 'done',
        code,
        Math.min(300, job.attempts * 15),
      ],
      db,
    )
    if (terminal) {
      await query(
        "UPDATE orders SET status='manual_review' WHERE id::text=$1 AND status IN ('paid','running')",
        [job.payload.orderId || ''],
        db,
      )
      await query(
        "UPDATE budget_reservations SET status='closed' WHERE dedupe_key=$1 OR id IN (SELECT reservation_id FROM orders WHERE id::text=$2)",
        [`research:${job.id}`, job.payload.orderId || ''],
        db,
      )
    }
    await audit(
      code ? 'job_error' : 'job_done',
      code ? `Задание остановлено: ${code}` : 'Задание выполнено',
      { jobId: job.id, kind: job.kind, terminal },
      db,
    )
  })
}
export async function recoverJobs() {
  await transaction(async (db) => {
    const rows = await query(
      `UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
      error_code='LEASE_EXPIRED',locked_until=null,lease_token=null,run_after=now()
      WHERE status='running' AND locked_until<now() RETURNING *`,
      [],
      db,
    )
    for (const row of rows) {
      await audit(
        'job_recovered',
        'Восстановлено задание после пропущенного heartbeat',
        { jobId: row.id, status: row.status },
        db,
      )
      if (row.status === 'failed') {
        await query(
          "UPDATE orders SET status='manual_review' WHERE id::text=$1 AND status IN ('paid','running')",
          [row.payload.orderId || ''],
          db,
        )
        await query(
          "UPDATE budget_reservations SET status='closed' WHERE dedupe_key=$1 OR id IN (SELECT reservation_id FROM orders WHERE id::text=$2)",
          [`research:${row.id}`, row.payload.orderId || ''],
          db,
        )
      }
    }
  })
}

export async function expireResearchSlots(day: string) {
  await transaction(async (db) => {
    const stale = await query(
      `UPDATE jobs SET status='failed',error_code='RESEARCH_SLOT_EXPIRED',finished_at=now()
      WHERE kind='research' AND status='queued' AND (
        (dedupe_key ~ '^research:[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND right(dedupe_key,10)<$1)
        OR (dedupe_key LIKE 'manual-research:%' AND created_at < ($1::date::timestamp AT TIME ZONE 'UTC'))
      ) RETURNING id`,
      [day],
      db,
    )
    for (const job of stale) {
      await query(
        "UPDATE budget_reservations SET status='closed' WHERE dedupe_key=$1",
        [`research:${job.id}`],
        db,
      )
      await audit(
        'research_slot_expired',
        'Пропущен устаревший суточный слот; исследования не накапливаются после паузы.',
        { jobId: job.id },
        db,
      )
    }
  })
}
