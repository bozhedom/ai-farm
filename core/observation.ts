export type ServiceChecks = {
  database: boolean
  worker: boolean
  payments: boolean
  backup: boolean
}
export type ObservationSample = { at: string; ok: boolean; checks: ServiceChecks | null }
export const observationTargetSeconds = 48 * 60 * 60
export const maximumSampleGapMs = 90000

export function isFresh(value: unknown, maximumMs: number, now = new Date()) {
  const time = typeof value === 'string' || value instanceof Date ? new Date(value).getTime() : NaN
  const age = now.getTime() - time
  return Number.isFinite(age) && age >= -5000 && age < maximumMs
}

export function observationSummary(samples: ObservationSample[], now = new Date()) {
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
    if (!sample.ok) {
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

export function parseSamples(value: unknown): ObservationSample[] {
  if (!Array.isArray(value) || value.length > 10081) throw new Error('INVALID_OBSERVATION_FILE')
  return value.map((s) => {
    if (
      !s ||
      typeof s.at !== 'string' ||
      !Number.isFinite(Date.parse(s.at)) ||
      typeof s.ok !== 'boolean'
    )
      throw new Error('INVALID_OBSERVATION_FILE')
    if (
      s.checks !== null &&
      (!s.checks ||
        !['database', 'worker', 'payments', 'backup'].every(
          (key) => typeof s.checks[key] === 'boolean',
        ))
    )
      throw new Error('INVALID_OBSERVATION_FILE')
    if (s.ok !== (!!s.checks && Object.values(s.checks).every((v) => v === true)))
      throw new Error('INVALID_OBSERVATION_FILE')
    return { at: s.at, ok: s.ok, checks: s.checks }
  })
}
