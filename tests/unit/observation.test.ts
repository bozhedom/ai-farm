import { expect, it } from 'vitest'
import { observationSummary, parseSamples, type ObservationSample } from '../../core/observation'
const start = Date.parse('2026-10-01T10:00:00Z')
const checks = { database: true, worker: true, payments: true, backup: true }
const sample = (seconds: number, ok = true): ObservationSample => ({
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
