import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from './db'
import { isFresh, observationSummary, parseSamples, type ServiceChecks } from './observation'

export const healthDirectory = () => process.env.HEALTH_DIRECTORY || '.health'
async function readStatus(name: string) {
  try {
    return JSON.parse(await readFile(join(healthDirectory(), name), 'utf8'))
  } catch {
    return null
  }
}
export async function serviceReadiness(now = new Date()) {
  const [state, backup] = await Promise.all([
    query('SELECT worker_heartbeat,payment_heartbeat FROM system_state WHERE id=true')
      .then((rows) => rows[0])
      .catch(() => null),
    readStatus('backup.json'),
  ])
  const checks: ServiceChecks = {
    database: !!state,
    worker: isFresh(state?.worker_heartbeat, 90000, now),
    payments: isFresh(state?.payment_heartbeat, 120000, now),
    backup: backup?.status === 'ok' && isFresh(backup?.completedAt, 26 * 3600000, now),
  }
  return {
    status: Object.values(checks).every(Boolean) ? 'ok' : 'degraded',
    checks,
    checkedAt: now.toISOString(),
  }
}
export async function operationsStatus(now = new Date()) {
  const [readiness, backup, saved] = await Promise.all([
    serviceReadiness(now),
    readStatus('backup.json'),
    readStatus('observation.json'),
  ])
  let observation = observationSummary([], now),
    observationError = false
  if (saved !== null) {
    try {
      observation = observationSummary(parseSamples(saved), now)
    } catch {
      observationError = true
    }
  }
  return {
    ...readiness,
    backupAt:
      typeof backup?.completedAt === 'string' && Number.isFinite(Date.parse(backup.completedAt))
        ? backup.completedAt
        : null,
    observation,
    observationError,
  }
}
