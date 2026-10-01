import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { parseSamples, type ObservationSample, type ServiceChecks } from '../core/observation'

// This process has no model, database credentials, customer data or Docker socket.
const directory = process.env.HEALTH_DIRECTORY || '.health'
const target = process.env.READINESS_URL || 'http://web:3000/api/readiness'
const filename = join(directory, 'observation.json')
await mkdir(directory, { recursive: true })
let samples: ObservationSample[] = []
try {
  samples = parseSamples(JSON.parse(await readFile(filename, 'utf8')))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error('OBSERVATION_HISTORY_INVALID')
    process.exit(1) // Preserve invalid history for review instead of silently claiming a fresh run.
  }
}
let stopping = false
const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true
    stop.abort()
  })
while (!stopping) {
  const started = Date.now()
  let checks: ServiceChecks | null = null
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(8000), redirect: 'error' })
    const body = await response.json()
    if (
      body &&
      ['database', 'worker', 'payments', 'backup'].every(
        (key) => typeof body.checks?.[key] === 'boolean',
      )
    )
      checks = {
        database: body.checks.database,
        worker: body.checks.worker,
        payments: body.checks.payments,
        backup: body.checks.backup,
      }
    if (!response.ok && checks && Object.values(checks).every(Boolean)) checks = null
  } catch {
    /* A failed sample must be recorded, including an unreachable web process. */
  }
  samples.push({
    at: new Date().toISOString(),
    ok: !!checks && Object.values(checks).every(Boolean),
    checks,
  })
  samples = samples.slice(-10081) // Seven days at one sample per minute; no customer material.
  await writeFile(filename + '.tmp', JSON.stringify(samples), { mode: 0o644 })
  await rename(filename + '.tmp', filename)
  await setTimeout(Math.max(1000, 60000 - (Date.now() - started)), undefined, {
    signal: stop.signal,
  }).catch(() => {})
}
