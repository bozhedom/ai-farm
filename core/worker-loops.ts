import { pool, query, type Connection } from './db'
import { exchanges } from './trading/types'

/**
 * Worker loops and their heartbeats. Each loop records its own result in `worker_loops`, so a
 * failing or stuck loop is visible in readiness, the office and `npm run autopilot:check`
 * without stopping the others.
 */
export type LoopSpec = {
  label: string
  /** A healthy loop finishes at least this often. */
  expectedMs: number
  /** Running longer than this means the loop is stuck. */
  stuckMs: number
}

const minute = 60_000
const tradingLoops = Object.fromEntries(
  exchanges.map((exchange) => [
    `trading:${exchange}`,
    { label: `Торговля ${exchange}`, expectedMs: 5 * minute, stuckMs: 30 * minute },
  ]),
) as Record<string, LoopSpec>

export const loopSpecs: Record<string, LoopSpec> = {
  tick: { label: 'Основной цикл', expectedMs: 2 * minute, stuckMs: 15 * minute },
  recovery: { label: 'Возврат зависших заданий', expectedMs: 2 * minute, stuckMs: 15 * minute },
  payments: { label: 'Сверка платежей', expectedMs: 5 * minute, stuckMs: 30 * minute },
  ...tradingLoops,
  earnings: { label: 'Наблюдение за направлениями', expectedMs: 5 * minute, stuckMs: 30 * minute },
  execution: {
    label: 'Арбитраж, фандинг, DeFi, прогнозы',
    expectedMs: 5 * minute,
    stuckMs: 30 * minute,
  },
  schedule: { label: 'Расписание фермы', expectedMs: 2 * minute, stuckMs: 15 * minute },
  providers: { label: 'Проверка модели и поиска', expectedMs: 2 * minute, stuckMs: 15 * minute },
  orders: { label: 'Заказы', expectedMs: 2 * minute, stuckMs: 15 * minute },
  manager: { label: 'Торговый менеджер', expectedMs: 5 * minute, stuckMs: 40 * minute },
  computer: { label: 'Компьютер ИИ', expectedMs: 5 * minute, stuckMs: 40 * minute },
  farm: { label: 'Разведка, отчёты, отбор', expectedMs: 2 * minute, stuckMs: 15 * minute },
  autopilot: { label: 'Автопилот', expectedMs: 30 * minute, stuckMs: 15 * minute },
}

export type LoopRow = {
  name: string
  started_at: Date | null
  ok_at: Date | null
  error_at: Date | null
  error: string
  runs: string | number
  failures: string | number
  consecutive_failures: number
}

/** Error codes only: never provider URLs, request bodies or secrets. */
export function loopError(error: unknown) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
    ? error.message
    : 'LOOP_FAILED'
}

export async function loopStarted(name: string, db: Connection = pool) {
  await query(
    `INSERT INTO worker_loops(name,started_at) VALUES($1,now())
     ON CONFLICT(name) DO UPDATE SET started_at=now()`,
    [name],
    db,
  )
}

export async function loopFinished(name: string, error?: unknown, db: Connection = pool) {
  if (error === undefined)
    await query(
      `INSERT INTO worker_loops(name,ok_at,runs) VALUES($1,now(),1)
       ON CONFLICT(name) DO UPDATE SET ok_at=now(),runs=worker_loops.runs+1,consecutive_failures=0`,
      [name],
      db,
    )
  else
    await query(
      `INSERT INTO worker_loops(name,error_at,error,runs,failures,consecutive_failures) VALUES($1,now(),$2,1,1,1)
       ON CONFLICT(name) DO UPDATE SET error_at=now(),error=$2,runs=worker_loops.runs+1,
       failures=worker_loops.failures+1,consecutive_failures=worker_loops.consecutive_failures+1`,
      [name, loopError(error)],
      db,
    )
}

export type LoopHealth = {
  name: string
  label: string
  state: 'ok' | 'failing' | 'stale' | 'stuck' | 'never'
  lastOkAt: string | null
  lastErrorAt: string | null
  error: string
  consecutiveFailures: number
}

/** Pure: the state of each known loop at `now`. Unknown names are ignored. */
export function loopHealth(rows: LoopRow[], now = new Date()): LoopHealth[] {
  return Object.entries(loopSpecs).map(([name, spec]) => {
    const row = rows.find((r) => r.name === name)
    const t = (d: Date | null | undefined) => (d ? new Date(d).getTime() : 0)
    const last = Math.max(t(row?.ok_at), t(row?.error_at))
    const running = !!row?.started_at && t(row.started_at) > last
    const state: LoopHealth['state'] = !row
      ? 'never'
      : running && now.getTime() - t(row.started_at) > spec.stuckMs
        ? 'stuck'
        : row.consecutive_failures > 0 && t(row.error_at) >= t(row.ok_at)
          ? 'failing'
          : !running && now.getTime() - last > spec.expectedMs
            ? 'stale'
            : 'ok'
    return {
      name,
      label: spec.label,
      state,
      lastOkAt: row?.ok_at ? new Date(row.ok_at).toISOString() : null,
      lastErrorAt: row?.error_at ? new Date(row.error_at).toISOString() : null,
      error: row?.error ?? '',
      consecutiveFailures: row?.consecutive_failures ?? 0,
    }
  })
}

export async function workerLoops(now = new Date(), db: Connection = pool) {
  return loopHealth(await query<LoopRow>('SELECT * FROM worker_loops', [], db), now)
}

type RunnerDeps = {
  started: (name: string) => Promise<void>
  finished: (name: string, error?: unknown) => Promise<void>
  log: (line: string) => void
  now: () => number
}

/**
 * Runs the worker's loops so that one failure never stops another: awaited steps of the tick
 * and background loops each catch, log a code and record their own heartbeat. Successes are
 * written at most every 30 s; failures always.
 */
export function createLoopRunner(
  deps: RunnerDeps = {
    started: loopStarted,
    finished: loopFinished,
    log: (line) => console.error(line),
    now: Date.now,
  },
) {
  const busy = new Map<string, number>()
  const running = new Set<Promise<void>>()
  const lastOk = new Map<string, number>()
  async function record(name: string, error?: unknown) {
    try {
      if (error !== undefined) {
        // Never log provider URLs, request bodies or secrets: codes only.
        deps.log(`WORKER_LOOP_FAILED ${name} ${loopError(error)}`)
        lastOk.delete(name)
        await deps.finished(name, error)
      } else if (deps.now() - (lastOk.get(name) ?? -Infinity) >= 30_000) {
        await deps.finished(name)
        lastOk.set(name, deps.now())
      }
    } catch {
      deps.log('WORKER_LOOP_HEARTBEAT_FAILED')
    }
  }
  return {
    busy,
    running,
    /** An awaited step of the tick. Its failure is recorded and the tick goes on. */
    async step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
      try {
        const value = await fn()
        await record(name)
        return value
      } catch (error) {
        await record(name, error)
        return undefined
      }
    },
    /** A background loop: one run at a time, independent of the tick and every other loop. */
    background(name: string, fn: () => Promise<unknown>) {
      if (busy.has(name)) return false
      busy.set(name, deps.now())
      const task = (async () => {
        await deps.started(name).catch(() => {})
        lastOk.delete(name)
        try {
          await fn()
          await record(name)
        } catch (error) {
          await record(name, error)
        }
      })().finally(() => {
        busy.delete(name)
        running.delete(task)
      })
      running.add(task)
      return true
    },
    /** Background loops running longer than their spec allows. */
    stuck(now = deps.now()) {
      return [...busy.entries()]
        .filter(([name, started]) => now - started > (loopSpecs[name]?.stuckMs ?? 30 * 60_000))
        .map(([name]) => name)
    },
  }
}
