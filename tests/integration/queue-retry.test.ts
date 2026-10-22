import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import { meteredCall, reserveBudget } from '../../core/budget'
import {
  claimJob,
  expectedCosts,
  expireResearchSlots,
  finishJob,
  pacingNumbers,
} from '../../core/queue'
import * as settings from '../../core/config'
import { randomUUID } from 'node:crypto'
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

describe('pacing by realistic cost', () => {
  it('uses the p90 of finished tasks and counts open envelopes at that cost', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({
      ...settings.config(),
      MODEL_PROVIDER: 'openai',
      LEAD_RESERVE_KOPECKS: 15000,
      SCOUT_RESERVE_KOPECKS: 20000,
    })
    const task = async (category: string, charged: number, status = 'closed', demo = false) => {
      const id = randomUUID()
      await query(
        `INSERT INTO budget_reservations(id,dedupe_key,category,limit_kopecks,spent_kopecks,status)
         VALUES($1,$2,$3,15000,$4,$5)`,
        [id, `pace:${id}`, category, charged, status],
      )
      if (charged)
        await query(
          `INSERT INTO tool_calls(id,call_key,reservation_id,role,status,reserved_kopecks,charged_kopecks,is_demo)
           VALUES($1,$2,$3,'test','done',$4,$4,$5)`,
          [randomUUID(), `pace:${id}`, id, charged, demo],
        )
      return id
    }
    for (const charged of [2000, 2200, 2400, 2500, 2600, 2500]) await task('lead', charged)
    // Demo calls and too little scout history do not count.
    for (let i = 0; i < 10; i++) await task('scout', 100, 'closed', true)
    const expected = await expectedCosts()
    expect(expected.lead).toBe(2550)
    expect(expected.scout).toBe(20000)
    // One open lead envelope of 150 ₽ counts as its expected 25.5 ₽ this hour.
    await task('lead', 0, 'open')
    const numbers = await pacingNumbers()
    expect(numbers.usedThisHour - (await thisHourCharged())).toBe(2550)
  })
})

async function thisHourCharged() {
  const [row] = await query(
    `SELECT COALESCE(sum(charged_kopecks),0)::int AS n FROM tool_calls
     WHERE created_at >= date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  )
  return row!.n as number
}
