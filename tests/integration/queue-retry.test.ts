import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import { meteredCall, reserveBudget } from '../../core/budget'
import { claimJob, expireResearchSlots, finishJob } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { requestScout } from '../../core/autonomy'
import { applyMigrations, resetDatabase } from './helpers/db'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await pool.end()
})

describe('queue after a restart', () => {
  it('skips yesterday’s manual scouts that never started and still ranks the batch', async () => {
    const queued = await requestScout()
    const job = (await claimJob(['scout']))!
    const rest = queued.jobs.filter((j) => j.id !== job.id)
    await runJob(job)
    await finishJob(job)
    await query(`UPDATE jobs SET created_at=now()-interval '1 day' WHERE id=ANY($1::uuid[])`, [
      rest.map((j) => j.id),
    ])
    await expireResearchSlots(new Date().toISOString().slice(0, 10))
    const expired = await query(
      "SELECT id FROM jobs WHERE kind='scout' AND error_code='FARM_SLOT_EXPIRED'",
    )
    expect(expired).toHaveLength(rest.length)
    expect(
      await query("SELECT id FROM jobs WHERE dedupe_key LIKE 'report:after-scouts:%'"),
    ).toHaveLength(1)
  })

  it('repeats an interrupted call of a free provider, never of a paid one', async () => {
    const reservation = await reserveBudget('free-retry', 'research')
    const call = (provider: string, invoke: () => Promise<any>) =>
      meteredCall({
        key: `free-retry:${provider}`,
        reservationId: reservation,
        role: 'Разведчик',
        maximum: 0,
        demo: false,
        activity: { provider, model: 'test', taskLabel: 'Проверка повтора' },
        invoke,
      })
    const fail = async () => {
      throw new Error('OPENROUTER_HTTP_429')
    }
    await expect(call('openrouter', fail)).rejects.toThrow('OPENROUTER_HTTP_429')
    expect(await call('openrouter', async () => ({ value: 'ok', cost: 0, microusd: 0 }))).toBe('ok')
    const rows = await query(
      "SELECT call_key,status FROM tool_calls WHERE call_key LIKE 'free-retry:openrouter%' ORDER BY created_at",
    )
    expect(rows.map((r) => r.status)).toEqual(['uncertain', 'done'])
    expect(rows[0]!.call_key).toMatch(/:retired:/)
    expect(await query("SELECT id FROM audit_events WHERE kind='tool_call_retried'")).toHaveLength(
      1,
    )
    // A provider with a price keeps the review: a repeat could charge twice.
    await expect(call('yandex', fail)).rejects.toThrow('OPENROUTER_HTTP_429')
    await expect(call('yandex', async () => ({ value: 'ok', cost: 0 }))).rejects.toThrow(
      'UNCERTAIN_CALL_REQUIRES_REVIEW',
    )
  })
})
