import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import { claimJob, enqueue, finishJob } from '../../core/queue'
import { runJob } from '../../core/jobs/run'
import { scheduleWork } from '../../core/autonomy'
import {
  evaluateWeek,
  evolutionStatus,
  requestEvolution,
  runEvolutionRound,
  simulateEvolution,
} from '../../core/evolution'
import { ensureStrategyParams } from '../../core/agents'
import { mutableParams, strategyParamsSchema } from '../../core/policy'
import { officeAgents } from '../../core/office'
import { activityFeed } from '../../core/activity-feed'
import { taxonomyTopics } from '../../core/taxonomy'
import { applyMigrations, resetDatabase } from './helpers/db'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await pool.end()
})

async function founders() {
  await ensureStrategyParams()
  return query("SELECT * FROM strategies WHERE status='active' ORDER BY created_at,id")
}

/** A stored idea with the given critic verdict. Ideas are data; selection reads only them. */
async function addIdea(
  strategyId: string,
  verdict: 'PASS' | 'REVISE' | 'BLOCKED',
  index: number,
  generation = 1,
  executable = false,
) {
  const job = await enqueue('scout', `scout-test:${randomUUID()}`, { strategyId })
  const topic = taxonomyTopics[index % taxonomyTopics.length]!
  await query(
    `INSERT INTO ideas(id,job_id,strategy_id,generation,topic_id,category,title,fingerprint,research,evidence,
       critique,farm_executable,suggested_template,rank_score,status,is_demo)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]',$10,$11,$12,50,'new',true)`,
    [
      randomUUID(),
      job.id,
      strategyId,
      generation,
      topic.id,
      topic.category,
      `Идея номер ${index} для проверки`,
      `идея${index} проверки${index}`,
      {
        demandSignals: [
          { claim: 'Демо', url: 'https://example.com/a' },
          { claim: 'Демо', url: 'https://example.org/b' },
        ],
      },
      { verdict, reason: 'Проверка отбора.' },
      executable,
      executable ? 'faq' : null,
    ],
  )
}

/** Агент А and Б pass everything, В and Г pass nothing: a clear gap. */
async function seedGap(perAgent = 2) {
  const agents = await founders()
  let n = 0
  for (const [i, agent] of agents.entries())
    for (let k = 0; k < perAgent; k++) await addIdea(agent.id, i < 2 ? 'PASS' : 'REVISE', n++)
  await query('UPDATE system_state SET evolution_min_ideas=$1', [perAgent])
  return agents
}

describe('quality selection of agents', () => {
  it('rotates for real after scheduled scouting at K=2 and keeps all history', async () => {
    vi.spyOn(settings, 'config').mockReturnValue({ ...settings.config(), AUTONOMY_ENABLED: true })
    await query('UPDATE system_state SET evolution_min_ideas=2,scouts_per_strategy_per_day=2')
    const [before] = await query('SELECT generation_started_at FROM system_state')
    await scheduleWork()
    expect(await query("SELECT id FROM jobs WHERE kind='scout'")).toHaveLength(8)
    for (let i = 0; i < 20; i++) {
      const job = await claimJob(['scout', 'evolve'])
      if (!job) break
      await runJob(job)
      await finishJob(job)
    }
    const [round] = await query("SELECT * FROM evolution_rounds WHERE decision='ROTATED'")
    expect(round).toMatchObject({ generation: 1, trigger: 'threshold', is_demo: true })
    expect(round!.archived).toHaveLength(2)
    expect(round!.children).toHaveLength(2)
    const [state] = await query('SELECT generation,generation_started_at FROM system_state')
    expect(state!.generation).toBe(2)
    expect(state!.generation_started_at.getTime()).toBe(before!.generation_started_at.getTime())
    const active = await query("SELECT * FROM strategies WHERE status='active'")
    const archived = await query("SELECT * FROM strategies WHERE status='archived'")
    expect(active).toHaveLength(4)
    expect(archived).toHaveLength(2)
    for (const s of archived) {
      expect(s.retired_round_id).toBe(round!.id)
      expect(s.retired_reason).toMatch(/^Балл \d+ из 1000/)
      expect(s.archived_at).toBeTruthy()
    }
    const children = active.filter((s) => s.parent_id)
    expect(children).toHaveLength(2)
    for (const child of children) {
      expect(child.generation).toBe(2)
      expect(child.born_round_id).toBe(round!.id)
      expect(mutableParams).toContain(child.mutation.param)
      expect(strategyParamsSchema.safeParse(child.params).success).toBe(true)
      expect(child.mutation.from).not.toEqual(child.mutation.to)
      expect(round!.archived).not.toContain(child.parent_id)
    }
    // History stays: all eight ideas still point at their authors, archived ones included.
    expect(await query('SELECT id FROM ideas')).toHaveLength(8)
    expect(
      await query('SELECT id FROM ideas WHERE strategy_id=ANY($1::uuid[])', [round!.archived]),
    ).toHaveLength(4)
    // Names: founders keep letters, copies are letter plus generation.
    const office = await officeAgents()
    const names = office.agents.map((a) => a.name)
    expect(names).toEqual(expect.arrayContaining(['Разведчик А', 'Разведчик Б']))
    expect(office.agents.filter((a) => a.parentId).map((a) => a.label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[АБВГ]2$/)]),
    )
    expect(office.rounds[0]!.decision).toBe('ROTATED')
    const feed = (await activityFeed(50)).map((item) => item.text)
    expect(feed.some((text) => /^Отбор поколения 1: Разведчик [АБВГ] уволен/.test(text))).toBe(true)
    expect(feed.some((text) => /скопирован\. Копия [АБВГ]2 /.test(text))).toBe(true)
    for (const text of feed) expect(text).not.toMatch(/[—→]/)
  })

  it('is idempotent per generation, safe under a race and never rotates twice', async () => {
    await seedGap()
    const [before] = await query('SELECT generation_started_at FROM system_state')
    const results = await Promise.all([
      runEvolutionRound({ trigger: 'owner', expectedGeneration: 1 }),
      runEvolutionRound({ trigger: 'owner', expectedGeneration: 1 }),
    ])
    expect(results[0]!.id).toBe(results[1]!.id)
    expect(results[0]!.decision).toBe('ROTATED')
    expect(await query("SELECT id FROM evolution_rounds WHERE decision='ROTATED'")).toHaveLength(1)
    const again = await runEvolutionRound({ trigger: 'owner', expectedGeneration: 1 })
    expect(again.id).toBe(results[0]!.id)
    expect(await query("SELECT id FROM strategies WHERE status='archived'")).toHaveLength(2)
    expect(await query('SELECT id FROM strategies')).toHaveLength(6)
    const [state] = await query('SELECT generation,generation_started_at FROM system_state')
    expect(state!.generation).toBe(2)
    expect(state!.generation_started_at.getTime()).toBe(before!.generation_started_at.getTime())
    // The new generation starts from zero: everyone needs new ideas again.
    const next = await runEvolutionRound({ trigger: 'owner' })
    expect(next.decision).toBe('HOLD')
    expect(next.reason).toMatch(/^Ждём данных/)
    // The partial unique index is the last guard against a second rotation of generation 1.
    await expect(
      query(
        `INSERT INTO evolution_rounds(id,round_key,generation,decision,reason,scores,trigger,is_demo)
         VALUES($1,'manual-second',1,'ROTATED','x','[]','owner',true)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/evolution_rotated_once_per_generation/)
  })

  it('holds with a reason when the gap is small, data is missing or the farm is paused', async () => {
    const agents = await founders()
    await query('UPDATE system_state SET evolution_min_ideas=2')
    expect((await runEvolutionRound({ trigger: 'owner' })).reason).toMatch(/^Ждём данных/)
    let n = 0
    for (const agent of agents) for (let k = 0; k < 2; k++) await addIdea(agent.id, 'PASS', n++)
    const hold = await runEvolutionRound({ trigger: 'owner', jobId: randomUUID() })
    expect(hold.decision).toBe('HOLD')
    expect(hold.reason).toMatch(/^Разрыв между вторым и третьим 0 пунктов/)
    expect(await query("SELECT id FROM strategies WHERE status='archived'")).toHaveLength(0)
    expect((await query('SELECT generation FROM system_state'))[0]!.generation).toBe(1)
    const status = await evolutionStatus()
    expect(status).toMatchObject({ ready: false, minIdeas: 2, enabled: true })
    expect(status.roundsToday).toBe(2)
    await query("UPDATE system_state SET mode='paused'")
    expect((await runEvolutionRound({ trigger: 'owner' })).reason).toBe(
      'Ферма на паузе или остановлена.',
    )
    await query("UPDATE system_state SET mode='running',evolution_enabled=false")
    expect((await runEvolutionRound({ trigger: 'owner' })).reason).toBe(
      'Отбор выключен в настройках.',
    )
    expect(await query("SELECT id FROM evolution_rounds WHERE decision='ROTATED'")).toHaveLength(0)
  })

  it('holds a queued check after the generation changed and retries a job idempotently', async () => {
    await seedGap()
    const job = await enqueue('evolve', 'evolve-owner:stale', { trigger: 'owner', generation: '1' })
    await runEvolutionRound({ trigger: 'owner', expectedGeneration: 1 })
    const claimed = (await claimJob(['evolve']))!
    expect(claimed.id).toBe(job.id)
    await runJob(claimed)
    await finishJob(claimed)
    expect(await query("SELECT id FROM evolution_rounds WHERE decision='ROTATED'")).toHaveLength(1)
    const stale = await enqueue('evolve', 'evolve-owner:stale-2', {
      trigger: 'owner',
      generation: '1',
    })
    const second = (await claimJob(['evolve']))!
    expect(second.id).toBe(stale.id)
    const first = await runEvolutionRound({
      trigger: 'owner',
      jobId: second.id,
      expectedGeneration: 2,
    })
    const repeat = await runEvolutionRound({
      trigger: 'owner',
      jobId: second.id,
      expectedGeneration: 2,
    })
    expect(repeat.id).toBe(first.id)
    await finishJob(second)
  })

  it('runs evolve during a pause but not after an emergency stop; owner checks are reused', async () => {
    await founders()
    const first = await requestEvolution()
    expect((await requestEvolution()).id).toBe(first.id)
    await query("UPDATE system_state SET mode='emergency_stop'")
    expect(await claimJob(['evolve'])).toBeUndefined()
    await expect(requestEvolution()).rejects.toThrow('STOPPED')
    await query("UPDATE system_state SET mode='paused'")
    expect((await claimJob(['evolve']))?.id).toBe(first.id)
  })

  it('keeps the money selection on HOLD and the simulation separate', async () => {
    await seedGap()
    await runEvolutionRound({ trigger: 'owner', expectedGeneration: 1 })
    await evaluateWeek('weekly-after-rotation')
    expect(await query("SELECT decision FROM evaluations WHERE decision='HOLD'")).toHaveLength(1)
    const simulated = await simulateEvolution(2)
    expect(simulated.decision).toBe('SIMULATION')
    expect(await query("SELECT id FROM evolution_rounds WHERE decision='ROTATED'")).toHaveLength(1)
    const [revenue] = await query('SELECT COALESCE(sum(revenue_kopecks),0)::int AS r FROM orders')
    expect(revenue!.r).toBe(0)
  })
})
