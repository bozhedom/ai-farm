import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit, query, transaction } from './db'
import { lockResearchWindow } from './research-window'
import { enqueue } from './queue'
import { config } from './config'
import { POLICY } from './policy'
import { decideStatus } from './ideas'

export const ideaActionSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'revise', 'build']),
    brief: z.string().trim().max(2000).default(''),
  })
  .strict()

/** Owner decisions never replace the critic, recipe checks, daily quota or budget admission. */
export async function decideIdea(id: string, value: unknown) {
  z.uuid().parse(id)
  const input = ideaActionSchema.parse(value)
  return transaction(async (db) => {
    const state = await lockResearchWindow(db)
    const [idea] = await query('SELECT * FROM ideas WHERE id=$1 FOR UPDATE', [id], db)
    if (!idea) throw new Error('IDEA_NOT_FOUND')
    const [pending] = await query(
      `SELECT id,status FROM jobs WHERE payload->>'ideaId'=$1
      AND kind='research' AND status IN ('queued','running') LIMIT 1`,
      [id],
      db,
    )
    if (pending) {
      if (input.action === 'build') return { jobId: pending.id, reused: true }
      throw new Error('IDEA_BUILD_IN_PROGRESS')
    }
    if (input.action === 'reject') {
      if (!['new', 'accepted', 'needs_human'].includes(idea.status) || idea.owner_status)
        throw new Error('IDEA_STATUS_CHANGE_FORBIDDEN')
      await query("UPDATE ideas SET status='rejected',ranked_at=now() WHERE id=$1", [id], db)
    } else if (input.action === 'revise') {
      if (input.brief.length < 10) throw new Error('IDEA_REVISION_REQUIRED')
      if (state.mode !== 'running' || !state.research_enabled) throw new Error('RESEARCH_PAUSED')
      const [existing] = await query(
        `SELECT id FROM jobs WHERE kind='scout' AND payload->>'ownerIdeaId'=$1
        AND status IN ('queued','running') LIMIT 1`,
        [id],
        db,
      )
      if (existing) return { jobId: existing.id, reused: true }
      const [count] = await query(
        `SELECT count(*)::int AS n FROM jobs WHERE kind='scout'
        AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [],
        db,
      )
      const [settings] = await query(
        'SELECT idea_daily_limit FROM system_state WHERE id=true',
        [],
        db,
      )
      if (count!.n >= Math.min(settings!.idea_daily_limit, POLICY.maxIdeasPerDay))
        throw new Error('IDEAS_DAILY_LIMIT')
      const [agent] = await query(
        "SELECT id FROM strategies WHERE status='active' ORDER BY (id=$1) DESC,created_at,id LIMIT 1",
        [idea.strategy_id],
        db,
      )
      if (!agent) throw new Error('INVALID_POPULATION')
      const job = await enqueue(
        'scout',
        `scout-manual:revision:${randomUUID()}`,
        {
          strategyId: agent.id,
          topicId: idea.topic_id,
          generation: String(state.generation),
          ownerIdeaId: id,
          ownerBrief: input.brief,
        },
        db,
      )
      await query(
        "UPDATE ideas SET owner_note=$2,status=CASE WHEN status IN ('new','accepted') THEN 'needs_human' ELSE status END WHERE id=$1",
        [id, input.brief.slice(0, 1000)],
        db,
      )
      await audit(
        'idea_revision_requested',
        'Владелец отправил правки на повторную разведку и независимую проверку.',
        { ideaId: id, jobId: job.id },
        db,
      )
      return { jobId: job.id, reused: false }
    } else {
      if (
        idea.critique?.verdict !== 'PASS' ||
        idea.duplicate_of ||
        !['new', 'accepted'].includes(idea.status)
      )
        throw new Error('IDEA_REVIEW_REQUIRED')
      const next = decideStatus('PASS', idea.farm_executable)
      await query('UPDATE ideas SET status=$2,ranked_at=now() WHERE id=$1', [id, next], db)
      if (input.action === 'build') {
        if (state.mode !== 'running' || !state.research_enabled) throw new Error('RESEARCH_PAUSED')
        if (!idea.farm_executable || !idea.suggested_template)
          throw new Error('IDEA_NOT_EXECUTABLE')
        if (idea.is_demo && config().MODEL_PROVIDER !== 'demo') throw new Error('DEMO_IDEA_ONLY')
        const [old] = await query(
          'SELECT id FROM jobs WHERE dedupe_key=$1',
          [`idea-research:${id}`],
          db,
        )
        if (old) throw new Error('IDEA_REVISION_REQUIRED')
        const [daily] = await query(
          `SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE 'idea-research:%'
          AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          [],
          db,
        )
        const [settings] = await query(
          'SELECT idea_products_per_day FROM system_state WHERE id=true',
          [],
          db,
        )
        if (
          daily!.n >=
          Math.min(
            settings!.idea_products_per_day ?? config().IDEA_PRODUCTS_PER_DAY,
            config().IDEA_PRODUCTS_PER_DAY,
          )
        )
          throw new Error('IDEA_PRODUCTS_DAILY_LIMIT')
        const job = await enqueue(
          'research',
          `idea-research:${id}`,
          {
            ideaId: id,
            strategyId: idea.strategy_id,
            templates: JSON.stringify([idea.suggested_template]),
          },
          db,
        )
        await audit(
          'idea_research_scheduled',
          'Владелец отправил идею на сборку продукта.',
          { ideaId: id, jobId: job.id },
          db,
        )
        return { jobId: job.id, reused: false }
      }
    }
    await audit(
      'idea_owner_decision',
      'Владелец принял решение по идее.',
      { ideaId: id, action: input.action },
      db,
    )
    return { ok: true }
  })
}
