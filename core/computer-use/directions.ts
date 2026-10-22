import { randomUUID } from 'node:crypto'
import { audit, query, transaction, type Connection } from '../db'
import { builtInDirections } from './goals'
import { forbiddenTextReason, validateGoal } from './policy'

/**
 * Search directions: the themes the worker rotates through when no owner goal is queued. The
 * owner steers them in the office (enable, disable, priority, own directions); the server seeds
 * the built-in set, validates every goal text like an owner goal and picks the next one with a
 * deterministic weighted round robin that favours directions with better yield but never starves
 * an enabled one. Platform goals for logged-in platforms keep their place ahead of directions.
 */
export const DIRECTION_LIMITS = Object.freeze({
  maxDirections: 60,
  minWeight: 1,
  maxWeight: 5,
  defaultWeight: 3,
  titleMin: 3,
  titleMax: 80,
  /** Yield multiplier in tenths: a direction weighs between 1.0x and 3.0x its priority. */
  baseTenths: 10,
  maxYieldTenths: 20,
  /** Directions with fewer completed tasks than this get the optimistic prior (exploration). */
  exploreTasks: 2,
  priorYieldTenths: 10,
})

export interface DirectionRow {
  id: string
  key: string | null
  title: string
  goal: string
  enabled: boolean
  weight: number
  built_in: boolean
  position: number
  credit: number
  created_at: Date
  updated_at: Date
  last_run_at: Date | null
  tasks: number
  found: number
  take_count: number
  human_count: number
  skip_count: number
}

/** What the scheduler needs to know about a direction. */
export interface DirectionYield {
  id: string
  weight: number
  credit: number
  tasks: number
  take: number
  human: number
  lastRunAt: Date | null
}

// ---------------------------------------------------------------------------------------------
// Pure scheduling. Integers only: tenths instead of floats, so the result is the same everywhere.

/**
 * Observed yield in tenths, 0..20: two points per finding the model takes itself, one per finding
 * that needs the owner, per task run. Directions with too few runs get the optimistic prior so
 * that new and rarely tried directions are explored before low-yield ones are written off.
 */
export function yieldTenths(direction: Pick<DirectionYield, 'tasks' | 'take' | 'human'>) {
  const L = DIRECTION_LIMITS
  if (direction.tasks < L.exploreTasks) return L.priorYieldTenths
  const points = 2 * Math.max(0, direction.take) + Math.max(0, direction.human)
  return Math.min(L.maxYieldTenths, Math.floor((10 * points) / direction.tasks))
}

/** Priority times the bounded yield multiplier: `weight * 10` .. `weight * 30`. */
export function effectiveWeight(
  direction: Pick<DirectionYield, 'weight' | 'tasks' | 'take' | 'human'>,
) {
  const L = DIRECTION_LIMITS
  const weight = Math.min(L.maxWeight, Math.max(L.minWeight, Math.round(direction.weight)))
  return weight * (L.baseTenths + yieldTenths(direction))
}

/**
 * Smooth weighted round robin (as in nginx): every direction earns its effective weight, the
 * richest one runs and pays the total. Over any window of `total` picks each direction runs about
 * `effective / total` of the time, and the gap between two runs of one direction never exceeds
 * `total / effective` picks, so a direction with priority 1 next to priority 5 and triple yield
 * still runs at least once every 15 runs of that neighbour. Ties go to the direction that has
 * waited longest, then by id, so the result is deterministic for a given state.
 */
export function nextDirection<T extends DirectionYield>(
  directions: readonly T[],
): { picked: T; credits: { id: string; credit: number }[] } | null {
  if (!directions.length) return null
  const effective = new Map(directions.map((d) => [d.id, effectiveWeight(d)]))
  const total = [...effective.values()].reduce((sum, value) => sum + value, 0)
  const credits = directions.map((d) => ({
    id: d.id,
    credit: d.credit + effective.get(d.id)!,
    lastRunAt: d.lastRunAt,
  }))
  const best = credits.reduce((a, b) => {
    if (b.credit !== a.credit) return b.credit > a.credit ? b : a
    const aTime = a.lastRunAt ? a.lastRunAt.getTime() : -Infinity
    const bTime = b.lastRunAt ? b.lastRunAt.getTime() : -Infinity
    if (aTime !== bTime) return bTime < aTime ? b : a
    return b.id < a.id ? b : a
  })
  best.credit -= total
  const picked = directions.find((d) => d.id === best.id)!
  return { picked, credits: credits.map(({ id, credit }) => ({ id, credit })) }
}

/**
 * Where a rotation step lands: the goals of logged-in platforms come first in every cycle, then
 * one direction pick per platform (at least one). Without platforms every pick is a direction.
 */
export function rotationSlot(
  index: number,
  platformGoals: number,
): { kind: 'platform'; index: number } | { kind: 'direction' } {
  const safe = Math.max(0, Math.floor(index)) || 0
  if (platformGoals <= 0) return { kind: 'direction' }
  const directionSlots = Math.max(1, Math.ceil(platformGoals / 2))
  const position = safe % (platformGoals + directionSlots)
  return position < platformGoals ? { kind: 'platform', index: position } : { kind: 'direction' }
}

// ---------------------------------------------------------------------------------------------
// Validation. Titles and goals pass the same forbidden-scheme checks as owner goals.

export function validateDirectionTitle(title: string) {
  const text = title.trim().replace(/\s+/g, ' ')
  const L = DIRECTION_LIMITS
  if (text.length < L.titleMin || text.length > L.titleMax || /[<>]/.test(text))
    throw new Error('COMPUTER_USE_DIRECTION_TITLE')
  const reason = forbiddenTextReason(text)
  if (reason) throw new Error(reason)
  return text
}
export function validateWeight(weight: number) {
  const L = DIRECTION_LIMITS
  if (!Number.isInteger(weight) || weight < L.minWeight || weight > L.maxWeight)
    throw new Error('COMPUTER_USE_DIRECTION_WEIGHT')
  return weight
}

// ---------------------------------------------------------------------------------------------
// Database.

/** Seeds the built-in directions once; owner edits and switches are never overwritten. */
export async function ensureDirections(db?: Connection) {
  await query(
    `INSERT INTO computer_use_directions(id,key,title,goal,built_in,position)
     SELECT gen_random_uuid(),s.key,s.title,s.goal,true,s.position
     FROM unnest($1::text[],$2::text[],$3::text[]) WITH ORDINALITY AS s(key,title,goal,position)
     ON CONFLICT (key) DO NOTHING`,
    [
      builtInDirections.map((d) => d.key),
      builtInDirections.map((d) => d.title),
      builtInDirections.map((d) => d.goal),
    ],
    db,
  )
}

export async function listDirections(db?: Connection) {
  return query<DirectionRow>(
    'SELECT * FROM computer_use_directions ORDER BY built_in DESC, position, created_at, id',
    [],
    db,
  )
}

async function lockDirection(id: string, db: Connection) {
  const [row] = await query<DirectionRow>(
    'SELECT * FROM computer_use_directions WHERE id=$1 FOR UPDATE',
    [id],
    db,
  )
  if (!row) throw new Error('COMPUTER_USE_DIRECTION_NOT_FOUND')
  return row
}

export async function createDirection(input: { title: string; goal: string; weight?: number }) {
  const title = validateDirectionTitle(input.title)
  const goal = validateGoal(input.goal)
  const weight = validateWeight(input.weight ?? DIRECTION_LIMITS.defaultWeight)
  return transaction(async (db) => {
    // Concurrent creates serialise here, so the count below cannot be raced past the limit.
    // SHARE ROW EXCLUSIVE conflicts with itself and with inserts, not with plain reads.
    await query('LOCK TABLE computer_use_directions IN SHARE ROW EXCLUSIVE MODE', [], db)
    await ensureDirections(db)
    const [count] = await query('SELECT count(*)::int AS n FROM computer_use_directions', [], db)
    if (count!.n >= DIRECTION_LIMITS.maxDirections) throw new Error('COMPUTER_USE_DIRECTIONS_LIMIT')
    const id = randomUUID()
    await query(
      'INSERT INTO computer_use_directions(id,title,goal,weight) VALUES($1,$2,$3,$4)',
      [id, title, goal, weight],
      db,
    )
    await audit('computer_use_direction', 'Владелец добавил направление поиска.', { id, title }, db)
    return id
  })
}

export async function updateDirection(
  id: string,
  patch: { title?: string; goal?: string; weight?: number },
) {
  const title = patch.title === undefined ? undefined : validateDirectionTitle(patch.title)
  const goal = patch.goal === undefined ? undefined : validateGoal(patch.goal)
  const weight = patch.weight === undefined ? undefined : validateWeight(patch.weight)
  await transaction(async (db) => {
    const row = await lockDirection(id, db)
    await query(
      `UPDATE computer_use_directions SET title=$2,goal=$3,weight=$4,updated_at=now() WHERE id=$1`,
      [id, title ?? row.title, goal ?? row.goal, weight ?? row.weight],
      db,
    )
    await audit(
      'computer_use_direction',
      'Владелец изменил направление поиска.',
      {
        id,
        title: title ?? row.title,
        weight: weight ?? row.weight,
        goalChanged: goal !== undefined,
      },
      db,
    )
  })
}

export async function setDirectionEnabled(id: string, enabled: boolean) {
  await transaction(async (db) => {
    const row = await lockDirection(id, db)
    // A re-enabled direction starts level with the others instead of owing or holding old credit.
    await query(
      'UPDATE computer_use_directions SET enabled=$2,credit=0,updated_at=now() WHERE id=$1',
      [id, enabled],
      db,
    )
    await audit(
      'computer_use_direction',
      enabled ? 'Владелец включил направление поиска.' : 'Владелец выключил направление поиска.',
      { id, title: row.title, enabled },
      db,
    )
  })
}

/** Owner directions can be deleted; built-ins can only be disabled. */
export async function deleteDirection(id: string) {
  await transaction(async (db) => {
    const row = await lockDirection(id, db)
    if (row.built_in) throw new Error('COMPUTER_USE_DIRECTION_BUILT_IN')
    await query('DELETE FROM computer_use_directions WHERE id=$1', [id], db)
    await audit(
      'computer_use_direction',
      'Владелец удалил своё направление поиска.',
      { id, title: row.title },
      db,
    )
  })
}

/**
 * Picks the next enabled direction inside the caller's transaction, stores the new credits and
 * counts the run. Returns null when nothing is enabled.
 */
export async function pickDirection(db: Connection) {
  await ensureDirections(db)
  const rows = await query<DirectionRow>(
    'SELECT * FROM computer_use_directions WHERE enabled ORDER BY created_at, id FOR UPDATE',
    [],
    db,
  )
  const result = nextDirection(
    rows.map((row) => ({
      id: row.id,
      weight: row.weight,
      credit: row.credit,
      tasks: row.tasks,
      take: row.take_count,
      human: row.human_count,
      lastRunAt: row.last_run_at,
    })),
  )
  if (!result) return null
  await query(
    `UPDATE computer_use_directions d SET credit=c.credit
     FROM unnest($1::uuid[],$2::int[]) AS c(id,credit) WHERE d.id=c.id`,
    [result.credits.map((c) => c.id), result.credits.map((c) => c.credit)],
    db,
  )
  await query(
    'UPDATE computer_use_directions SET tasks=tasks+1,last_run_at=now() WHERE id=$1',
    [result.picked.id],
    db,
  )
  const picked = rows.find((row) => row.id === result.picked.id)!
  return { id: picked.id, goal: picked.goal, title: picked.title }
}

/** Counts a recorded finding for the direction of its task, if the task came from one. */
export async function recordDirectionFinding(
  taskId: string,
  decision: 'take' | 'human' | 'skip',
  db: Connection,
) {
  const column =
    decision === 'take' ? 'take_count' : decision === 'human' ? 'human_count' : 'skip_count'
  await query(
    `UPDATE computer_use_directions d SET found=d.found+1,${column}=d.${column}+1
     FROM computer_use_tasks t WHERE t.id=$1 AND d.id=t.direction_id`,
    [taskId],
    db,
  )
}
