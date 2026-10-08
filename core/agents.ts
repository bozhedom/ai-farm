import { config } from './config'
import { audit, pool, query, type Connection } from './db'
import {
  categoryLabels,
  ideaSourceDomains,
  strategyParamsSchema,
  type IdeaResearch,
  type StrategyParams,
} from './policy'
import { categoryById, taxonomyCategoryIds } from './taxonomy'

/**
 * Agents are rows of `strategies`. Their parameters are server data: the model never writes
 * instructions, and the owner changes only numeric settings. Names are computed, not stored.
 */
export type StrategyRow = {
  id: string
  name: string
  parent_id: string | null
  generation: number
  created_at: Date | string
  status?: string
  params?: unknown
}

const letters = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К', 'Л', 'М', 'Н', 'П', 'Р', 'С']
const legacy: Record<string, string> = { Альфа: 'А', Бета: 'Б', Гамма: 'В', Дельта: 'Г' }
const time = (value: Date | string) => new Date(value).getTime()
const byAge = (a: StrategyRow, b: StrategyRow) =>
  time(a.created_at) - time(b.created_at) || a.id.localeCompare(b.id)

/**
 * Deterministic short labels: founders are А, Б, В, Г; a copy is its founder's letter plus
 * the generation it was born in ("А2"). Two copies of one line in the same generation get
 * "А3" and "А3.2".
 */
export function agentLabels(rows: StrategyRow[]): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const isRoot = (row: StrategyRow) => !row.parent_id || !byId.has(row.parent_id)
  const roots = rows.filter(isRoot).sort(byAge)
  const labels = new Map<string, string>()
  const used = new Set<string>()
  for (const root of roots) {
    const known = legacy[root.name.split(/[\s·]/)[0] ?? '']
    if (known && !used.has(known)) {
      labels.set(root.id, known)
      used.add(known)
    }
  }
  let next = 0
  for (const root of roots) {
    if (labels.has(root.id)) continue
    while (next < letters.length && used.has(letters[next]!)) next++
    const letter = letters[next] ?? `Р${next + 1}`
    next++
    labels.set(root.id, letter)
    used.add(letter)
  }
  const rootLetter = (row: StrategyRow): string => {
    const seen = new Set<string>()
    let current = row
    while (!isRoot(current) && !seen.has(current.id)) {
      seen.add(current.id)
      current = byId.get(current.parent_id!)!
    }
    return labels.get(current.id)!
  }
  const children = rows
    .filter((row) => !isRoot(row))
    .sort((a, b) => a.generation - b.generation || byAge(a, b))
  for (const child of children) {
    const base = `${rootLetter(child)}${child.generation}`
    let label = base
    for (let n = 2; used.has(label); n++) label = `${base}.${n}`
    labels.set(child.id, label)
    used.add(label)
  }
  return labels
}
export const agentName = (label: string) => `Разведчик ${label}`
/** Founder position by letter (А 0, Б 1, ...): stable even when rows share a timestamp. */
export const founderIndex = (label: string) => Math.max(0, letters.indexOf(label))

export async function agentNames(db: Connection = pool) {
  const rows = await query<StrategyRow>(
    'SELECT id,name,parent_id,generation,created_at FROM strategies',
    [],
    db,
  )
  const labels = agentLabels(rows)
  return {
    label: (id: string) => labels.get(id) ?? '?',
    name: (id: string) => agentName(labels.get(id) ?? '?'),
  }
}

const founderParams: StrategyParams[] = [
  {
    focusCategories: ['marketplaces', 'b2b', 'handmade'],
    evidenceMinimum: 3,
    tone: 'plain',
    ideaScope: 'narrow',
    riskAppetite: 'low',
  },
  {
    focusCategories: ['food', 'beauty', 'travel'],
    evidenceMinimum: 3,
    tone: 'friendly',
    ideaScope: 'broad',
    riskAppetite: 'low',
  },
  {
    focusCategories: ['tutoring', 'courses', 'creators'],
    evidenceMinimum: 2,
    tone: 'expert',
    ideaScope: 'narrow',
    riskAppetite: 'medium',
  },
  {
    focusCategories: ['auto', 'repair', 'farming'],
    evidenceMinimum: 2,
    tone: 'plain',
    ideaScope: 'broad',
    riskAppetite: 'medium',
  },
]
/** Founder parameters by position; later founders cover the remaining industries. */
export function defaultParams(index: number): StrategyParams {
  if (index < founderParams.length) return founderParams[index]!
  const rest = taxonomyCategoryIds.filter(
    (id) => !founderParams.some((p) => p.focusCategories.includes(id)),
  )
  const start = ((index - founderParams.length) * 3) % rest.length
  return {
    focusCategories: [0, 1, 2].map((i) => rest[(start + i) % rest.length]!),
    evidenceMinimum: index % 2 ? 2 : 3,
    tone: 'plain',
    ideaScope: index % 2 ? 'broad' : 'narrow',
    riskAppetite: 'low',
  }
}

export function parseParams(value: unknown): StrategyParams | null {
  const parsed = strategyParamsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const toneText: Record<StrategyParams['tone'], string> = {
  plain: 'Ясная структура, простые слова, только проверенные факты.',
  expert: 'Точные формулировки специалиста, только проверенные факты.',
  friendly: 'Дружелюбный тон, короткие фразы, только проверенные факты.',
}
/** Text style and search focus rebuilt from parameters. Never written by a model. */
export function renderApproach(params: StrategyParams) {
  const p = strategyParamsSchema.parse(params)
  return [
    toneText[p.tone],
    `Ищет идеи в отраслях: ${p.focusCategories.map((id) => categoryLabels[id]).join(', ')}.`,
    p.ideaScope === 'narrow'
      ? 'Узкая аудитория и одна конкретная задача.'
      : 'Широкая аудитория и несколько похожих задач.',
    `Не меньше ${p.evidenceMinimum} подтверждений спроса из разных источников.`,
    p.riskAppetite === 'low'
      ? 'Осторожен с расходами и рисками.'
      : 'Допускает умеренные стартовые расходы.',
  ].join(' ')
}

/** Human description of a mutation for the feed: "ищет в B2B вместо розницы". */
export function describeMutation(mutation: { param: string; from: unknown; to: unknown }) {
  const where = (ids: unknown) =>
    Array.isArray(ids) ? ids.map((id) => categoryById[String(id)]?.where ?? String(id)) : []
  if (mutation.param === 'focusCategories') {
    const from = where(mutation.from)
    const to = where(mutation.to)
    const added = to.filter((x) => !from.includes(x))
    const removed = from.filter((x) => !to.includes(x))
    return `ищет ${added.join(', ')}, а не ${removed.join(', ')}`
  }
  if (mutation.param === 'evidenceMinimum')
    return `просит ${mutation.to} подтверждения спроса вместо ${mutation.from}`
  if (mutation.param === 'tone')
    return `пишет ${{ plain: 'проще', expert: 'как специалист', friendly: 'дружелюбнее' }[String(mutation.to)] ?? 'иначе'}`
  if (mutation.param === 'ideaScope')
    return mutation.to === 'broad' ? 'берёт задачи шире' : 'берёт задачи уже'
  return mutation.to === 'low' ? 'осторожнее с расходами' : 'смелее с расходами'
}

/**
 * Fills missing parameters once: founders by position, copies from their parent. Existing
 * approach text is kept. Safe to call on every scheduler tick.
 */
export async function ensureStrategyParams(db: Connection = pool) {
  const rows = await query<StrategyRow>(
    'SELECT id,name,parent_id,generation,created_at,status,params FROM strategies ORDER BY created_at,id',
    [],
    db,
  )
  const missing = rows.filter((row) => !parseParams(row.params))
  if (!missing.length) return 0
  const labels = agentLabels(rows)
  const resolved = new Map(rows.map((row) => [row.id, parseParams(row.params)]))
  const paramsFor = (row: StrategyRow, depth = 0): StrategyParams => {
    const known = resolved.get(row.id)
    if (known) return known
    const parent = row.parent_id ? rows.find((r) => r.id === row.parent_id) : undefined
    const value =
      parent && depth < 50
        ? paramsFor(parent, depth + 1)
        : defaultParams(founderIndex(labels.get(row.id) ?? ''))
    resolved.set(row.id, value)
    return value
  }
  for (const row of missing)
    await query(
      `UPDATE strategies SET params=$2 WHERE id=$1 AND (params='{}'::jsonb OR params IS NULL)`,
      [row.id, paramsFor(row)],
      db,
    )
  await audit(
    'agent_params_assigned',
    'Разведчикам назначены отрасли для поиска идей.',
    {
      agents: missing.map((row) => ({
        agentId: row.id,
        label: labels.get(row.id),
        focus: paramsFor(row).focusCategories,
      })),
    },
    db,
  )
  return missing.length
}

export type AgentMetrics = {
  strategyId: string
  createdAt: string
  ideas: number
  passed: number
  duplicates: number
  /** Sum over ideas of min(1000, 1000 * domains / 3). */
  sourceMilli: number
  executablePassed: number
  builtPassed: number
  costKopecks: number
  reserveKopecks: number
  delivered: number
  review: number
}

/** Paid providers reserve money for a scout; free providers do not, so cost is not compared. */
export function scoutReserveKopecks() {
  const c = config()
  return ['yandex', 'openai'].includes(c.MODEL_PROVIDER) || c.SEARCH_PROVIDER === 'yandex'
    ? c.SCOUT_RESERVE_KOPECKS
    : 0
}

/** One connection runs one query at a time: a transaction client must not be shared. */
async function inOrder<T extends unknown[]>(tasks: { [K in keyof T]: () => Promise<T[K]> }) {
  const out: unknown[] = []
  for (const task of tasks) out.push(await task())
  return out as T
}

/** Internal quality metrics of each agent in one generation. Nothing here comes from a model. */
export async function agentMetrics(
  generation: number,
  strategyIds: string[],
  db: Connection = pool,
): Promise<AgentMetrics[]> {
  if (!strategyIds.length) return []
  const [strategies, ideas, built, costs, orders] = await inOrder([
    () => query(`SELECT id,created_at FROM strategies WHERE id=ANY($1::uuid[])`, [strategyIds], db),
    () =>
      query(
        `SELECT id,strategy_id,critique->>'verdict' AS verdict,duplicate_of,farm_executable,
        research->'demandSignals' AS signals
       FROM ideas WHERE generation=$1 AND strategy_id=ANY($2::uuid[])`,
        [generation, strategyIds],
        db,
      ),
    () =>
      query(
        `SELECT DISTINCT i.id,i.strategy_id FROM ideas i JOIN hypotheses h ON h.idea_id=i.id
       WHERE i.generation=$1 AND i.strategy_id=ANY($2::uuid[]) AND h.status IN ('accepted','backlog')
       AND i.farm_executable AND i.critique->>'verdict'='PASS'`,
        [generation, strategyIds],
        db,
      ),
    () =>
      query(
        `SELECT j.payload->>'strategyId' AS strategy_id,COALESCE(sum(t.charged_kopecks),0)::int AS cost
       FROM jobs j JOIN tool_calls t ON t.job_id=j.id
       WHERE j.kind='scout' AND j.payload->>'generation'=$1::text AND j.payload->>'strategyId'=ANY($2::text[])
       GROUP BY 1`,
        [generation, strategyIds],
        db,
      ),
    () =>
      query(
        `SELECT strategy_id,count(*) FILTER(WHERE status='delivered')::int AS delivered,
        count(*) FILTER(WHERE status='manual_review')::int AS review
       FROM orders WHERE generation=$1 AND strategy_id=ANY($2::uuid[]) GROUP BY strategy_id`,
        [generation, strategyIds],
        db,
      ),
  ])
  const reserve = scoutReserveKopecks()
  return strategies.map((s) => {
    const own = ideas.filter((i) => i.strategy_id === s.id)
    const sourceMilli = own.reduce((sum, idea) => {
      let domains = 0
      try {
        domains = ideaSourceDomains({
          demandSignals: (idea.signals ?? []) as IdeaResearch['demandSignals'],
        })
      } catch {
        domains = 0
      }
      return sum + Math.min(1000, Math.round((1000 * domains) / 3))
    }, 0)
    const order = orders.find((o) => o.strategy_id === s.id)
    return {
      strategyId: s.id as string,
      createdAt: new Date(s.created_at).toISOString(),
      ideas: own.length,
      passed: own.filter((i) => i.verdict === 'PASS').length,
      duplicates: own.filter((i) => i.duplicate_of).length,
      sourceMilli,
      executablePassed: own.filter((i) => i.verdict === 'PASS' && i.farm_executable).length,
      builtPassed: built.filter((b) => b.strategy_id === s.id).length,
      costKopecks: (costs.find((c) => c.strategy_id === s.id)?.cost as number | undefined) ?? 0,
      reserveKopecks: reserve,
      delivered: (order?.delivered as number | undefined) ?? 0,
      review: (order?.review as number | undefined) ?? 0,
    }
  })
}
