import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from './db'
import { config } from './config'
import { loopHealth, type LoopRow } from './worker-loops'
import {
  isFresh,
  observationSummary,
  parseSamples,
  type InfrastructureChecks,
  type ServiceChecks,
} from './observation'

export const healthDirectory = () => process.env.HEALTH_DIRECTORY || '.health'
async function readStatus(name: string) {
  try {
    return JSON.parse(await readFile(join(healthDirectory(), name), 'utf8')) ?? { invalid: true }
  } catch (error) {
    // Only a missing file means observation has not started. An unreadable or
    // malformed history must remain visible as a monitoring failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { invalid: true }
  }
}
export async function serviceReadiness(now = new Date()) {
  const [state, backup, loops] = await Promise.all([
    query(
      'SELECT worker_heartbeat,payment_heartbeat,provider_readiness FROM system_state WHERE id=true',
    )
      .then((rows) => rows[0])
      .catch(() => null),
    readStatus('backup.json'),
    query<LoopRow>('SELECT * FROM worker_loops')
      .then((rows) => loopHealth(rows, now))
      .catch(() => []),
  ])
  const infrastructureChecks: InfrastructureChecks = {
    database: !!state,
    worker: isFresh(state?.worker_heartbeat, 90000, now),
    payments: isFresh(state?.payment_heartbeat, 120000, now),
    backup: backup?.status === 'ok' && isFresh(backup?.completedAt, 26 * 3600000, now),
  }
  const readiness = state?.provider_readiness
  const providerHeartbeat = isFresh(readiness?.checkedAt, 90000, now)
  const checks: ServiceChecks = {
    ...infrastructureChecks,
    providerHeartbeat,
    model: providerHeartbeat && readiness?.model === true,
    search: providerHeartbeat && readiness?.search === true,
  }
  const c = config()
  return {
    version: 2 as const,
    status: Object.values(checks).every(Boolean) ? 'ok' : 'degraded',
    checks,
    infrastructure: {
      status: Object.values(infrastructureChecks).every(Boolean) ? 'ok' : 'degraded',
      checks: infrastructureChecks,
    },
    providers: {
      status: checks.model && checks.search ? 'ok' : 'degraded',
      checkedAt:
        typeof readiness?.checkedAt === 'string' && Number.isFinite(Date.parse(readiness.checkedAt))
          ? readiness.checkedAt
          : null,
      fresh: providerHeartbeat,
      model: {
        provider: c.MODEL_PROVIDER,
        preflightReady: checks.model,
        verification:
          c.MODEL_PROVIDER === 'ollama'
            ? ('local_probe' as const)
            : c.MODEL_PROVIDER === 'demo'
              ? ('demo' as const)
              : ('not_probed' as const),
      },
      search: {
        provider: c.SEARCH_PROVIDER,
        preflightReady: checks.search,
        verification:
          c.SEARCH_PROVIDER === 'searxng'
            ? ('local_probe' as const)
            : c.SEARCH_PROVIDER === 'demo'
              ? ('demo' as const)
              : ('not_probed' as const),
      },
    },
    // Informational: one line per worker loop. Codes and details stay in the office.
    loops: loops.map((loop) => ({ name: loop.name, state: loop.state })),
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
