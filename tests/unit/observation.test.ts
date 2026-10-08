import { expect, it } from 'vitest'
import {
  observationSummary,
  parseReadinessChecks,
  parseSamples,
  type ObservationSample,
} from '../../core/observation'
const start = Date.parse('2026-10-01T10:00:00Z')
const infrastructureChecks = { database: true, worker: true, payments: true, backup: true }
const checks = { ...infrastructureChecks, providerHeartbeat: true, model: true, search: true }
const sample = (seconds: number, ok = true): ObservationSample => ({
  version: 2,
  at: new Date(start + seconds * 1000).toISOString(),
  ok,
  checks: ok ? checks : null,
})
it('requires 48 actual consecutive hours and a fresh final sample', () => {
  const samples = Array.from({ length: 2881 }, (_, i) => sample(i * 60))
  const now = new Date(start + 48 * 3600000)
  expect(observationSummary(samples.slice(0, -1), now).complete).toBe(false)
  expect(observationSummary(samples, now)).toMatchObject({
    complete: true,
    healthySeconds: 172800,
    gaps: 0,
    failedSamples: 0,
  })
  expect(observationSummary(samples, new Date(now.getTime() + 120000)).complete).toBe(false)
})
it('breaks the healthy interval on downtime, skipped samples and a backwards clock', () => {
  expect(
    observationSummary([sample(0), sample(60, false), sample(120)], new Date(start + 120000)),
  ).toMatchObject({ healthySeconds: 0, failedSamples: 1 })
  expect(
    observationSummary([sample(0), sample(60), sample(300), sample(360)], new Date(start + 360000)),
  ).toMatchObject({ healthySeconds: 60, gaps: 1 })
  expect(observationSummary([sample(60), sample(0)], new Date(start))).toMatchObject({
    healthySeconds: 0,
    gaps: 1,
  })
})
it('preserves old infrastructure evidence without crediting it as provider readiness', () => {
  const legacy = Array.from({ length: 2881 }, (_, i) => ({
    at: new Date(start + i * 60000).toISOString(),
    ok: true,
    checks: infrastructureChecks,
  }))
  const parsed = parseSamples(legacy)
  expect(parsed).toEqual(legacy)
  expect(observationSummary(parsed, new Date(start + 48 * 3600000))).toMatchObject({
    complete: false,
    healthySeconds: 0,
    failedSamples: 0,
    legacySamples: 2881,
    infrastructure: { complete: true, healthySeconds: 172800, failedSamples: 0 },
  })
  const mixed = [...parsed, sample(172860), sample(172920)]
  expect(observationSummary(parseSamples(mixed), new Date(start + 172920000))).toMatchObject({
    complete: false,
    healthySeconds: 60,
    legacySamples: 2881,
    infrastructure: { complete: true, healthySeconds: 172920 },
  })
  const failedLegacy = { at: legacy[0]!.at, ok: false, checks: null }
  expect(observationSummary(parseSamples([failedLegacy, legacy[1]]))).toMatchObject({
    healthySeconds: 0,
    failedSamples: 1,
    legacySamples: 2,
    infrastructure: { failedSamples: 1 },
  })
})
it.each(['model', 'search', 'providerHeartbeat'] as const)(
  'breaks dependency evidence on a failed %s check while retaining infrastructure uptime',
  (key) => {
    const samples = [
      sample(0),
      { ...sample(60), version: 2 as const, ok: false, checks: { ...checks, [key]: false } },
      sample(120),
    ]
    expect(observationSummary(parseSamples(samples), new Date(start + 120000))).toMatchObject({
      complete: false,
      healthySeconds: 0,
      failedSamples: 1,
      legacySamples: 0,
      infrastructure: { healthySeconds: 120, failedSamples: 0 },
    })
  },
)
it('accepts detailed degraded readiness but refuses legacy or contradictory endpoint responses', () => {
  const healthy = { version: 2, status: 'ok', checks }
  expect(parseReadinessChecks(healthy, true)).toEqual(checks)
  const degraded = { version: 2, status: 'degraded', checks: { ...checks, search: false } }
  expect(parseReadinessChecks(degraded, false)).toEqual(degraded.checks)
  for (const body of [
    { status: 'ok', checks: infrastructureChecks },
    { ...healthy, checks: infrastructureChecks },
    { ...healthy, checks: { ...checks, model: 'true' } },
    { ...healthy, status: 'degraded' },
    null,
  ])
    expect(parseReadinessChecks(body, true)).toBeNull()
  expect(parseReadinessChecks(healthy, false)).toBeNull()
  expect(parseReadinessChecks(degraded, true)).toBeNull()
})
it('rejects incomplete or contradictory versioned history instead of silently upgrading it', () => {
  expect(() => parseSamples([{ ...sample(0), checks: infrastructureChecks }])).toThrow(
    'INVALID_OBSERVATION_FILE',
  )
  expect(() => parseSamples([{ ...sample(0), checks: { ...checks, model: false } }])).toThrow(
    'INVALID_OBSERVATION_FILE',
  )
  expect(() => parseSamples([{ ...sample(0), version: 3 }])).toThrow('INVALID_OBSERVATION_FILE')
})
it('rejects corrupt or contradictory persisted evidence', () => {
  expect(() => parseSamples([{ ...sample(0), checks: null }])).toThrow('INVALID_OBSERVATION_FILE')
  expect(() => parseSamples([{ ...sample(0), at: 'invalid' }])).toThrow('INVALID_OBSERVATION_FILE')
  expect(parseSamples([sample(0)])).toEqual([sample(0)])
  expect(observationSummary([], new Date(start))).toMatchObject({
    complete: false,
    fresh: false,
    samples: 0,
  })
})
