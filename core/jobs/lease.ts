import { query, transaction, type Connection } from '../db'
import type { Job } from '../queue'
import { lockResearchWindow } from '../research-window'

type WindowState = Awaited<ReturnType<typeof lockResearchWindow>>

/**
 * Saves results only while this worker still owns the job. Provider answers and their charges
 * stay in tool_calls either way; a late worker never writes over a newer lease.
 */
export async function withLease<T>(
  job: Job,
  fn: (db: Connection, state: WindowState) => Promise<T>,
): Promise<T> {
  const result = await transaction(async (db) => {
    const state = await lockResearchWindow(db)
    const [lease] = await query(
      `SELECT id FROM jobs WHERE id=$1 AND status='running'
       AND lease_token=$2 AND locked_until>clock_timestamp() FOR UPDATE`,
      [job.id, job.lease_token],
      db,
    )
    if (!lease) return { error: 'LEASE_LOST' as const }
    return { value: await fn(db, state) }
  })
  if ('error' in result) throw new Error(result.error)
  return result.value
}

/** Lifecycle and safety stops must reach the queue; anything else may be recorded and skipped. */
export function mustPropagate(error: unknown) {
  return (
    error instanceof Error &&
    /^(WORKER_DRAINING|STOPPED|PAUSED|RESEARCH_WINDOW_CLOSED|LEASE_LOST|RESERVATION_CLOSED|BUDGET_BLOCKED|OPENAI_BUDGET_BLOCKED|OPENROUTER_COST_REVIEW_REQUIRED|PROVIDER_CHANGED_DURING_JOB)$/.test(
      error.message,
    )
  )
}

export function errorCode(error: unknown, fallback: string) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
    ? error.message
    : fallback
}
