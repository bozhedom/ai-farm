import { randomUUID } from 'node:crypto'
import { config } from './config'
import { audit, pool, query, transaction, type Connection } from './db'
import { POLICY, applyMutation, mutationIndex, type Mutation, type StrategyParams } from './policy'
import { lockResearchWindow } from './research-window'
import {
  agentLabels,
  agentMetrics,
  agentName,
  defaultParams,
  describeMutation,
  parseParams,
  renderApproach,
  type AgentMetrics,
  type StrategyRow,
} from './agents'
import { enqueue } from './queue'
import { plural } from './activity-feed'
import type { EvolutionStatus, ScoreComponent } from './contracts/office'

export type Score = {
  id: string
  visits: number
  delivered: number
  revenue: number
  refunds: number
  fees: number
  costs: number
  violations: number
}
export type Evaluation = {
  decision: 'HOLD' | 'ROTATE' | 'CLOSED'
  reason: string
  winners: string[]
  losers: string[]
}
export function assess(
  scores: Score[],
  ageDays: number,
  comparable: boolean,
  obligations = false,
): Evaluation {
  const hold = (reason: string): Evaluation => ({
    decision: ageDays >= POLICY.researchWindowDays ? 'CLOSED' : 'HOLD',
    reason,
    winners: [],
    losers: [],
  })
  if (scores.length !== 4 || new Set(scores.map((s) => s.id)).size !== 4 || !comparable)
    return hold('Недостаточно сопоставимых участников и условий.')
  if (obligations) return hold('Есть незавершённые обязательства.')
  if (ageDays < 14) return hold('Окно наблюдения и созревания ещё не завершено.')
  if (
    scores.some((s) =>
      Object.entries(s).some(([k, v]) => k !== 'id' && (!Number.isSafeInteger(v) || Number(v) < 0)),
    )
  )
    return hold('Некорректные метрики.')
  if (scores.some((s) => s.visits < 100 || s.delivered < 10 || s.violations > 0))
    return hold('Нужно 100 посещений и 10 выданных покупок на стратегию без нарушений.')
  const ranked = scores
    .map((s) => ({ ...s, contribution: s.revenue - s.refunds - s.fees - s.costs }))
    .sort((a, b) => b.contribution / b.visits - a.contribution / a.visits)
  const second = ranked[1]!,
    third = ranked[2]!
  if (ranked[0]!.contribution <= 0 || second.contribution <= 0)
    return hold('У двух лидеров должен быть положительный вклад.')
  if (
    second.contribution / second.visits - third.contribution / third.visits <
    0.2 * (second.contribution / second.visits)
  )
    return hold('Разрыв между вторым и третьим меньше 20%.')
  return {
    decision: 'ROTATE',
    reason: 'Пороги сопоставимого эксперимента выполнены.',
    winners: ranked.slice(0, 2).map((s) => s.id),
    losers: ranked.slice(2).map((s) => s.id),
  }
}

export async function evaluateWeek(key: string) {
  await transaction(async (db) => {
    const state = await lockResearchWindow(db)
    if (state.research_window_expired) return
    const decision = 'HOLD'
    const reason = 'Тестовые платежи исключены из выручки. Данных для денежного отбора нет.'
    const rows = await query(
      'INSERT INTO evaluations(id,evaluation_key,generation,decision,reason,details) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(evaluation_key) DO NOTHING RETURNING id',
      [randomUUID(), key, state!.generation, decision, reason, { realRevenueKopecks: 0 }],
      db,
    )
    if (rows.length)
      await audit('evaluation', reason, { generation: state!.generation, decision }, db)
  })
}

export async function simulateEvolution(expectedGeneration: number) {
  return transaction(async (db) => {
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [old] = await query(
      'SELECT * FROM evaluations WHERE evaluation_key=$1',
      [`simulation:${expectedGeneration}`],
      db,
    )
    if (old) return old
    if (state?.mode !== 'running') throw new Error('SIMULATION_PAUSED')
    if (state.generation !== expectedGeneration) throw new Error('GENERATION_CHANGED')
    if (
      (
        await query(
          "SELECT id FROM orders WHERE status IN ('paid','running','manual_review') LIMIT 1",
          [],
          db,
        )
      ).length
    )
      throw new Error('OPEN_OBLIGATIONS')
    const strategies = await query(
      "SELECT * FROM strategies WHERE status='active' ORDER BY created_at,id",
      [],
      db,
    )
    if (strategies.length !== 4) throw new Error('INVALID_POPULATION')
    const scores: Score[] = strategies.map((s, i) => ({
      id: s.id,
      visits: 400,
      delivered: 20,
      revenue: [1000000, 900000, 700000, 800000][i]!,
      refunds: [50000, 0, 100000, 150000][i]!,
      fees: 0,
      costs: [165000, 141500, 144500, 208000][i]!,
      violations: 0,
    }))
    const result = assess(scores, 14, true)
    if (result.decision !== 'ROTATE') throw new Error('SIMULATION_INVALID')
    await query(
      "UPDATE strategies SET status='archived',archived_at=now() WHERE id=ANY($1::uuid[])",
      [result.losers],
      db,
    )
    const children = []
    for (const id of result.winners) {
      const parent = strategies.find((s) => s.id === id)!
      const child = {
        id: randomUUID(),
        parentId: id,
        name: `${parent.name.split(' · ')[0]} · ${state.generation + 1}`,
      }
      await query(
        'INSERT INTO strategies(id,name,approach,parent_id,generation) VALUES($1,$2,$3,$4,$5)',
        [child.id, child.name, parent.approach, id, state.generation + 1],
        db,
      )
      children.push(child)
    }
    await query(
      'UPDATE system_state SET generation=generation+1,generation_started_at=now(),research_enabled=true WHERE id=true',
      [],
      db,
    )
    const details = { ...result, scores, children, simulation: true }
    const [record] = await query(
      "INSERT INTO evaluations(id,evaluation_key,generation,decision,reason,details) VALUES($1,$2,$3,'SIMULATION',$4,$5) RETURNING *",
      [
        randomUUID(),
        `simulation:${expectedGeneration}`,
        expectedGeneration,
        'Демонстрационная замена 2 из 4. Тестовые цифры не внесены в финансовый журнал.',
        details,
      ],
      db,
    )
    await audit(
      'simulation',
      'Симуляция: две стратегии архивированы, созданы две копии лидеров.',
      { generation: expectedGeneration, children },
      db,
    )
    return record
  })
}

// ---------------------------------------------------------------------------------------------
// Internal quality selection (policy v3). Measured on server data only: no model takes part in
// the score. Money-based selection above stays HOLD until real comparable sales exist.

export const scoreWeights: Readonly<Record<ScoreComponent, number>> = Object.freeze({
  P: 40,
  E: 20,
  U: 10,
  B: 15,
  C: 5,
  D: 10,
})
export type ScoredAgent = {
  strategyId: string
  createdAt: string
  total: number
  components: Record<ScoreComponent, number | null>
  samples: number
  metrics: AgentMetrics
}

/** Integer components 0..1000 and a weighted total over the components that apply. */
export function scoreStrategies(rows: AgentMetrics[]): ScoredAgent[] {
  const scored = rows.map((m) => {
    const n = m.ideas
    const components: Record<ScoreComponent, number | null> = {
      P: n ? Math.round((1000 * m.passed) / n) : 0,
      E: n ? Math.round(m.sourceMilli / n) : 0,
      U: n ? Math.round((1000 * (n - m.duplicates)) / n) : 0,
      B: m.executablePassed
        ? Math.min(1000, Math.round((1000 * m.builtPassed) / m.executablePassed))
        : null,
      C:
        m.reserveKopecks > 0
          ? 1000 -
            Math.min(1000, Math.round((1000 * m.costKopecks) / (Math.max(1, n) * m.reserveKopecks)))
          : null,
      D:
        m.delivered + m.review >= 3
          ? Math.round((1000 * m.delivered) / (m.delivered + m.review))
          : null,
    }
    let weighted = 0
    let weights = 0
    for (const key of Object.keys(scoreWeights) as ScoreComponent[]) {
      const value = components[key]
      if (value === null) continue
      weighted += scoreWeights[key] * value
      weights += scoreWeights[key]
    }
    return {
      strategyId: m.strategyId,
      createdAt: m.createdAt,
      total: weights ? Math.round(weighted / weights) : 0,
      components,
      samples: n,
      metrics: m,
    }
  })
  // Ties keep the older agent ahead: a copy never displaces its working parent on a draw.
  return scored.sort(
    (a, b) =>
      b.total - a.total ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.strategyId.localeCompare(b.strategyId),
  )
}

type SelectionState = {
  mode: string
  research_enabled: boolean
  evolution_enabled: boolean
  evolution_min_ideas: number
  generation: number
}
export type Readiness = {
  ready: boolean
  reason: string
  missing: { agentId: string; need: number }[]
}

/** The same rules decide the status screen, the scheduler and the round itself. */
export function selectionReadiness(
  state: SelectionState,
  scored: ScoredAgent[],
  rotated: boolean,
): Readiness {
  const minIdeas = state.evolution_min_ideas
  const missing = scored
    .filter((s) => s.samples < minIdeas)
    .map((s) => ({ agentId: s.strategyId, need: minIdeas - s.samples }))
  const hold = (reason: string): Readiness => ({ ready: false, reason, missing })
  if (!state.evolution_enabled) return hold('Отбор выключен в настройках.')
  if (state.mode !== 'running') return hold('Ферма на паузе или остановлена.')
  if (!state.research_enabled) return hold('Сезон закрыт. Откройте новый, чтобы продолжить отбор.')
  if (scored.length !== POLICY.maxStrategies)
    return hold('Для отбора нужны ровно четыре активных разведчика.')
  if (rotated) return hold('В этом поколении отбор уже был.')
  if (missing.length)
    return hold(
      `Ждём данных: нужно не меньше ${minIdeas} ${minIdeas === 1 ? 'идеи' : 'идей'} у каждого разведчика.`,
    )
  const gap = scored[1]!.total - scored[2]!.total
  if (gap < POLICY.evolution.minGapMilli) {
    const points = Math.floor(gap / 10)
    return hold(
      `Разрыв между вторым и третьим ${points} ${plural(points, 'пункт', 'пункта', 'пунктов')}, нужно не меньше ${POLICY.evolution.minGapMilli / 10}.`,
    )
  }
  return { ready: true, reason: 'Данных достаточно, можно проводить отбор.', missing: [] }
}

async function selectionState(db: Connection) {
  const [state] = await query<SelectionState & { evolution_rounds_per_day: number }>(
    `SELECT mode,research_enabled,evolution_enabled,evolution_min_ideas,evolution_rounds_per_day,generation
     FROM system_state WHERE id=true`,
    [],
    db,
  )
  if (!state) throw new Error('SYSTEM_STATE_UNAVAILABLE')
  return state
}

async function scoreGeneration(generation: number, db: Connection) {
  const active = await query<StrategyRow & { params: unknown; mutation: Mutation | null }>(
    "SELECT * FROM strategies WHERE status='active' ORDER BY created_at,id",
    [],
    db,
  )
  const metrics = await agentMetrics(
    generation,
    active.map((s) => s.id),
    db,
  )
  return { active, scored: scoreStrategies(metrics) }
}

const todayStart = "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"

export async function evolutionStatus(db: Connection = pool): Promise<EvolutionStatus> {
  const state = await selectionState(db)
  const [{ scored }, rotated, today, financial] = await Promise.all([
    scoreGeneration(state.generation, db),
    query(
      "SELECT id FROM evolution_rounds WHERE generation=$1 AND decision='ROTATED' LIMIT 1",
      [state.generation],
      db,
    ),
    query(
      `SELECT count(*)::int AS n FROM evolution_rounds WHERE created_at >= ${todayStart}`,
      [],
      db,
    ),
    query(
      "SELECT decision,reason,created_at FROM evaluations WHERE decision IN ('HOLD','CLOSED') ORDER BY created_at DESC LIMIT 1",
      [],
      db,
    ),
  ])
  const readiness = selectionReadiness(state, scored, rotated.length > 0)
  return {
    enabled: state.evolution_enabled,
    minIdeas: state.evolution_min_ideas,
    roundsPerDay: state.evolution_rounds_per_day,
    roundsToday: today[0]!.n as number,
    ready: readiness.ready,
    reason: readiness.reason,
    missing: readiness.missing,
    financial: financial[0]
      ? {
          decision: financial[0].decision as 'HOLD' | 'CLOSED',
          reason: financial[0].reason as string,
          at: new Date(financial[0].created_at).toISOString(),
        }
      : null,
  }
}

/** Current scores of active agents, for the agents screen. */
export async function currentScores(db: Connection = pool) {
  const state = await selectionState(db)
  return (await scoreGeneration(state.generation, db)).scored
}

export type EvolutionTrigger = 'threshold' | 'schedule' | 'owner'

/**
 * One selection round in one transaction. ROTATED archives the two weakest agents and copies
 * the two strongest with one allowed mutation each, then starts the next generation. The
 * 28-day season (generation_started_at) is not extended. Repeating a call for the same
 * generation returns the stored round; a partial unique index blocks a second rotation even
 * if two workers race.
 */
export async function runEvolutionRound(args: {
  trigger: EvolutionTrigger
  jobId?: string
  expectedGeneration?: number
}) {
  return transaction(async (db) => {
    const window = await lockResearchWindow(db)
    const state = await selectionState(db)
    const generation =
      args.expectedGeneration && Number.isSafeInteger(args.expectedGeneration)
        ? args.expectedGeneration
        : state.generation
    const [done] = await query(
      'SELECT * FROM evolution_rounds WHERE round_key=$1',
      [`evolution:${generation}`],
      db,
    )
    if (done) return done
    const holdKey = `evolution-check:${args.jobId ?? randomUUID()}`
    const [checked] = await query(
      'SELECT * FROM evolution_rounds WHERE round_key=$1',
      [holdKey],
      db,
    )
    if (checked) return checked
    const [demo] = await query(
      'SELECT COALESCE(bool_or(is_demo),false) AS demo FROM ideas WHERE generation=$1',
      [state.generation],
      db,
    )
    const isDemo = config().MODEL_PROVIDER === 'demo' || !!demo?.demo
    const { active, scored } = await scoreGeneration(state.generation, db)
    const rows = await query<StrategyRow>(
      'SELECT id,name,parent_id,generation,created_at FROM strategies',
      [],
      db,
    )
    const labels = agentLabels(rows)
    const scores = scored.map((s) => ({
      strategyId: s.strategyId,
      score: s.total,
      components: s.components,
      samples: s.samples,
    }))
    const hold = async (reason: string) => {
      const [round] = await query(
        `INSERT INTO evolution_rounds(id,round_key,generation,decision,reason,scores,trigger,is_demo)
         VALUES($1,$2,$3,'HOLD',$4,$5,$6,$7) RETURNING *`,
        [randomUUID(), holdKey, generation, reason, JSON.stringify(scores), args.trigger, isDemo],
        db,
      )
      await audit(
        'evolution_hold',
        `Отбор пропущен: ${reason}`,
        { roundId: round!.id, generation, reason, trigger: args.trigger },
        db,
      )
      return round!
    }
    if (state.generation !== generation) return hold('Поколение уже сменилось.')
    const readiness = selectionReadiness(
      { ...state, research_enabled: window.research_enabled },
      scored,
      false,
    )
    if (!readiness.ready) return hold(readiness.reason)

    const keep = Math.round(scored.length * (1 - POLICY.evolution.archiveShare))
    const winners = scored.slice(0, keep)
    const losers = scored.slice(keep)
    const scouting = await query(
      'SELECT category,sum(scout_count)::int AS n FROM topic_scouting GROUP BY category',
      [],
      db,
    )
    const categoryScouts = Object.fromEntries(scouting.map((row) => [row.category, row.n]))
    const roundId = randomUUID()
    const children = winners.map((winner) => {
      const parent = active.find((s) => s.id === winner.strategyId)!
      const params: StrategyParams =
        parseParams(parent.params) ??
        defaultParams(
          Math.max(
            0,
            active.findIndex((s) => s.id === parent.id),
          ),
        )
      const mutated = applyMutation(
        params,
        mutationIndex(parent.id, generation),
        { categoryScouts },
        parent.mutation?.param ?? null,
      )
      return {
        id: randomUUID(),
        parentId: parent.id,
        params: mutated.params,
        mutation: mutated.mutation,
        createdAt: new Date(),
      }
    })
    const childLabels = agentLabels([
      ...rows,
      ...children.map((child) => ({
        id: child.id,
        name: '',
        parent_id: child.parentId,
        generation: generation + 1,
        created_at: child.createdAt,
      })),
    ])
    const [round] = await query(
      `INSERT INTO evolution_rounds(id,round_key,generation,decision,reason,scores,archived,children,trigger,is_demo)
       VALUES($1,$2,$3,'ROTATED',$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        roundId,
        `evolution:${generation}`,
        generation,
        'Внутренний отбор по качеству: худшая половина уволена, лучшая скопирована.',
        JSON.stringify(scores),
        losers.map((l) => l.strategyId),
        JSON.stringify(children.map(({ id, parentId, mutation }) => ({ id, parentId, mutation }))),
        args.trigger,
        isDemo,
      ],
      db,
    )
    for (const loser of losers)
      await query(
        `UPDATE strategies SET status='archived',archived_at=now(),retired_reason=$2,retired_round_id=$3
         WHERE id=$1 AND status='active'`,
        [
          loser.strategyId,
          `Балл ${loser.total} из 1000: принято ${loser.metrics.passed} из ${loser.metrics.ideas} идей.`,
          roundId,
        ],
        db,
      )
    for (const child of children)
      await query(
        `INSERT INTO strategies(id,name,approach,parent_id,generation,params,mutation,born_round_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          child.id,
          childLabels.get(child.id),
          renderApproach(child.params),
          child.parentId,
          generation + 1,
          child.params,
          child.mutation,
          roundId,
          child.createdAt,
        ],
        db,
      )
    // The season is not extended: generation_started_at stays as the owner set it.
    await query('UPDATE system_state SET generation=generation+1 WHERE id=true', [], db)
    const fired = losers.map((l) => ({
      agentId: l.strategyId,
      label: labels.get(l.strategyId),
      score: l.total,
      passed: l.metrics.passed,
      ideas: l.metrics.ideas,
    }))
    const copies = children.map((child) => ({
      id: child.id,
      label: childLabels.get(child.id),
      parentId: child.parentId,
      parentLabel: labels.get(child.parentId),
      mutation: child.mutation,
    }))
    await audit(
      'evolution_rotated',
      `Отбор поколения ${generation}: ${fired
        .map((f) => `${agentName(f.label ?? '?')} уволен, принято ${f.passed} из ${f.ideas}`)
        .join('; ')}. ${copies
        .map(
          (c) =>
            `${agentName(c.parentLabel ?? '?')} скопирован, копия ${c.label} ${describeMutation(c.mutation)}`,
        )
        .join('; ')}.`,
      { roundId, generation, archived: fired, children: copies, trigger: args.trigger, isDemo },
      db,
    )
    return round!
  })
}

/**
 * Called by the scheduler and after each scout. Queues a threshold check when every active
 * agent has enough ideas, at most `evolution_rounds_per_day` times a day and never twice in a
 * generation that already rotated.
 */
export async function maybeScheduleEvolution(db: Connection, day: string) {
  const state = await selectionState(db)
  if (!state.evolution_enabled || state.mode !== 'running' || !state.research_enabled) return null
  // A scheduled check would never be claimed while the schedule is off.
  const [schedule] = await query('SELECT schedule_enabled FROM system_state WHERE id=true', [], db)
  if (!config().AUTONOMY_ENABLED || !schedule?.schedule_enabled) return null
  const [rotated] = await query(
    "SELECT id FROM evolution_rounds WHERE generation=$1 AND decision='ROTATED'",
    [state.generation],
    db,
  )
  if (rotated) return null
  const [busy] = await query(
    "SELECT id FROM jobs WHERE kind='evolve' AND status IN ('queued','running') LIMIT 1",
    [],
    db,
  )
  if (busy) return null
  const [counts] = await query(
    `SELECT count(*)::int AS n FROM jobs WHERE kind='evolve' AND dedupe_key LIKE $1`,
    [`evolve:${state.generation}:${day}:%`],
    db,
  )
  if (counts!.n >= state.evolution_rounds_per_day) return null
  const ready = await query(
    `SELECT s.id,count(i.id)::int AS n FROM strategies s
     LEFT JOIN ideas i ON i.strategy_id=s.id AND i.generation=$1 AND ($2 OR NOT i.is_demo)
     WHERE s.status='active' GROUP BY s.id`,
    [state.generation, config().MODEL_PROVIDER === 'demo'],
    db,
  )
  if (
    ready.length !== POLICY.maxStrategies ||
    ready.some((row) => row.n < state.evolution_min_ideas)
  )
    return null
  return enqueue(
    'evolve',
    `evolve:${state.generation}:${day}:${counts!.n + 1}`,
    { trigger: 'threshold', generation: String(state.generation), scheduled: 'true' },
    db,
  )
}

/** Owner button "Проверить отбор сейчас": one queued check at a time. */
export async function requestEvolution() {
  return transaction(async (db) => {
    const [state] = await query(
      'SELECT generation,mode FROM system_state WHERE id=true FOR UPDATE',
      [],
      db,
    )
    if (state?.mode === 'emergency_stop') throw new Error('STOPPED')
    const [busy] = await query(
      "SELECT id,status FROM jobs WHERE kind='evolve' AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
      [],
      db,
    )
    if (busy) return { id: busy.id as string, status: busy.status as string, reused: true }
    const job = await enqueue(
      'evolve',
      `evolve-owner:${randomUUID()}`,
      { trigger: 'owner', generation: String(state!.generation) },
      db,
    )
    await audit(
      'evolution_requested',
      'Владелец попросил проверить отбор.',
      { jobId: job.id, generation: state!.generation },
      db,
    )
    return { id: job.id as string, status: job.status as string, reused: false }
  })
}
