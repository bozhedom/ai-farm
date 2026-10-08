export type InfrastructureChecks = {
  database: boolean
  worker: boolean
  payments: boolean
  backup: boolean
}
export type ServiceChecks = InfrastructureChecks & {
  providerHeartbeat: boolean
  model: boolean
  search: boolean
}
export type ObservationSample =
  | { version?: 1; at: string; ok: boolean; checks: InfrastructureChecks | null }
  | { version: 2; at: string; ok: boolean; checks: ServiceChecks | null }
const infrastructureKeys = ['database', 'worker', 'payments', 'backup'] as const
const serviceKeys = [...infrastructureKeys, 'providerHeartbeat', 'model', 'search'] as const
export const observationTargetSeconds = 48 * 60 * 60
export const maximumSampleGapMs = 90000

export function isFresh(value: unknown, maximumMs: number, now = new Date()) {
  const time = typeof value === 'string' || value instanceof Date ? new Date(value).getTime() : NaN
  const age = now.getTime() - time
  return Number.isFinite(age) && age >= -5000 && age < maximumMs
}

function intervalSummary(
  samples: ObservationSample[],
  healthy: (sample: ObservationSample) => boolean,
  now: Date,
) {
  const first = samples[0],
    last = samples.at(-1)
  let healthySince: string | null = null,
    gaps = 0,
    failed = 0
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!
    const previous = samples[i - 1]
    const delta = previous ? Date.parse(sample.at) - Date.parse(previous.at) : 0
    const gap = !!previous && (delta > maximumSampleGapMs || delta < 0)
    if (gap) gaps++
    if (!healthy(sample)) {
      failed++
      healthySince = null
    } else if (!healthySince || gap) healthySince = sample.at
  }
  const fresh = isFresh(last?.at, maximumSampleGapMs, now)
  const healthySeconds =
    healthySince && last
      ? Math.max(0, Math.floor((Date.parse(last.at) - Date.parse(healthySince)) / 1000))
      : 0
  return {
    startedAt: first?.at || null,
    lastAt: last?.at || null,
    healthySince,
    samples: samples.length,
    failedSamples: failed,
    gaps,
    fresh,
    healthySeconds,
    targetSeconds: observationTargetSeconds,
    complete: fresh && healthySeconds >= observationTargetSeconds,
  }
}

export function observationSummary(samples: ObservationSample[], now = new Date()) {
  const fullCheckPassed = (sample: ObservationSample) =>
    sample.version === 2 &&
    sample.ok &&
    !!sample.checks &&
    serviceKeys.every((key) => sample.checks![key] === true)
  return {
    ...intervalSummary(samples, fullCheckPassed, now),
    // Old samples remain evidence of infrastructure uptime, not of provider readiness.
    failedSamples: samples.filter((sample) => !sample.ok).length,
    legacySamples: samples.filter((sample) => sample.version !== 2).length,
    infrastructure: intervalSummary(
      samples,
      (sample) =>
        !!sample.checks &&
        (sample.version === 2 || sample.ok) &&
        infrastructureKeys.every((key) => sample.checks![key] === true),
      now,
    ),
  }
}

/** Only the versioned, complete readiness contract can start the new observation window. */
export function parseReadinessChecks(value: unknown, responseOk: boolean): ServiceChecks | null {
  if (!value || typeof value !== 'object') return null
  const body = value as Record<string, any>
  if (
    body.version !== 2 ||
    !body.checks ||
    !serviceKeys.every((key) => typeof body.checks[key] === 'boolean')
  )
    return null
  const checks = Object.fromEntries(
    serviceKeys.map((key) => [key, body.checks[key]]),
  ) as ServiceChecks
  const ok = serviceKeys.every((key) => checks[key])
  if (body.status !== (ok ? 'ok' : 'degraded') || responseOk !== ok) return null
  return checks
}

export function parseSamples(value: unknown): ObservationSample[] {
  if (!Array.isArray(value) || value.length > 10081) throw new Error('INVALID_OBSERVATION_FILE')
  return value.map((s) => {
    if (
      !s ||
      typeof s.at !== 'string' ||
      !Number.isFinite(Date.parse(s.at)) ||
      typeof s.ok !== 'boolean' ||
      (s.version !== undefined && s.version !== 1 && s.version !== 2)
    )
      throw new Error('INVALID_OBSERVATION_FILE')
    if (
      s.checks !== null &&
      (!s.checks ||
        !(s.version === 2 ? serviceKeys : infrastructureKeys).every(
          (key) => typeof s.checks[key] === 'boolean',
        ))
    )
      throw new Error('INVALID_OBSERVATION_FILE')
    if (s.ok !== (!!s.checks && Object.values(s.checks).every((v) => v === true)))
      throw new Error('INVALID_OBSERVATION_FILE')
    return {
      ...(s.version === undefined ? {} : { version: s.version }),
      at: s.at,
      ok: s.ok,
      checks: s.checks,
    }
  })
}
