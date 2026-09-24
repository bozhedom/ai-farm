import { randomUUID } from 'node:crypto'
import { audit, pool, query, transaction, type Connection } from './db'

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
    const [row] = await query<Job>(
      `SELECT j.* FROM jobs j CROSS JOIN system_state s
      WHERE j.kind=ANY($1) AND j.status='queued' AND j.run_after<=now() AND j.attempts<j.max_attempts
      AND (j.kind='evaluate' OR (j.kind='research' AND s.mode='running') OR (j.kind='fulfill' AND s.mode<>'emergency_stop'))
      ORDER BY CASE j.kind WHEN 'fulfill' THEN 0 ELSE 1 END,j.created_at
      FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      [kinds],
      db,
    )
    if (!row) return
    const [claimed] = await query<Job>(
      `UPDATE jobs SET status='running', attempts=attempts+1,
      locked_until=now()+interval '2 minutes', lease_token=$2 WHERE id=$1 RETURNING *`,
      [row.id, randomUUID()],
      db,
    )
    return claimed
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
        /POLICY|UNCERTAIN|BUDGET|INPUT|SOURCE|SCHEMA|REVIEW|OUTPUT/.test(code))
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
