import { createHash } from 'node:crypto'
import { pool, query, type Connection } from '../db'
import { z } from 'zod'
import { EXECUTION_POLICY as P } from '../policy'
import { units } from '../trading/decimal'
import {
  executionTracks,
  type ExecutionMode,
  type ExecutionPortfolio,
  type ExecutionTrack,
  type ExecutionSettings,
} from './types'

export const executionScopeSchema = z
  .object({ track: z.enum(executionTracks), mode: z.enum(['paper', 'demo', 'live']) })
  .strict()
export const executionSettingsSchema = z
  .object({
    buyExchange: z.enum(['okx', 'bybit', 'binance', 'bitget']).default('okx'),
    sellExchange: z.enum(['okx', 'bybit', 'binance', 'bitget']).default('bybit'),
    symbols: z
      .array(
        z
          .string()
          .regex(/^[A-Z0-9]{1,32}-USDT$/)
          .refine((s) => s !== 'USDT-USDT'),
      )
      .max(P.maxSymbols)
      .default([]),
    minEdgeBps: z.number().int().min(10).max(1000).default(20),
    minFundingBps: z.number().int().min(1).max(100).default(2),
    maxHoldHours: z.number().int().min(1).max(168).default(24),
    predictionTicker: z
      .string()
      .regex(/^[A-Z0-9_.:-]{0,200}$/)
      .default(''),
    probabilityBps: z.number().int().min(1).max(9999).default(5000),
    outcome: z.enum(['yes', 'no']).default('yes'),
  })
  .strict()
export const allocationSchema = executionScopeSchema
  .extend({
    capital: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)
      .refine((s) => units(s) >= units(P.minCapital)),
    settings: executionSettingsSchema,
  })
  .strict()
  .refine((value) => value.track !== 'prediction' || value.settings.predictionTicker.length > 0, {
    message: 'EXECUTION_PREDICTION_MARKET_REQUIRED',
    path: ['settings', 'predictionTicker'],
  })
export const defaultExecutionSettings: ExecutionSettings = executionSettingsSchema.parse({})

/** A versioned snapshot shared by Demo and Live, independent of JSON object key order. */
export function executionConfiguration(settings: ExecutionSettings) {
  const normalized = executionSettingsSchema.parse(settings)
  const canonical = Object.fromEntries(
    Object.entries(normalized).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  return createHash('sha256')
    .update('execution-settings:v1:')
    .update(JSON.stringify(canonical))
    .digest('hex')
}

export function executionRiskStopped(p: Pick<ExecutionPortfolio, 'status' | 'reason'>) {
  return (
    p.status === 'stopped' ||
    /^EXECUTION_(DRAWDOWN_STOP|DAILY_LOSS_STOP|INVENTORY_LOSS_STOP|FILL_BUDGET_EXCEEDED)$/.test(
      p.reason,
    )
  )
}

export async function ensureExecution(db: Connection = pool) {
  for (const track of executionTracks)
    for (const mode of ['paper', 'demo', 'live'])
      await query(
        'INSERT INTO execution_portfolios(track,mode,settings) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [track, mode, defaultExecutionSettings],
        db,
      )
}
export async function portfolio(track: ExecutionTrack, mode: ExecutionMode, db: Connection = pool) {
  const [row] = await query<ExecutionPortfolio>(
    'SELECT * FROM execution_portfolios WHERE track=$1 AND mode=$2',
    [track, mode],
    db,
  )
  if (!row) throw new Error('EXECUTION_NOT_FOUND')
  return row
}
/** Shared account/wallet lane across local workers and owner controls. No network work in a SQL transaction. */
export async function executionLock<T>(fn: () => Promise<T>) {
  const db = await pool.connect()
  let locked = false
  try {
    const result = await db.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(735098) AS locked',
    )
    locked = !!result.rows[0]?.locked
    if (!locked) throw new Error('EXECUTION_BUSY')
    return await fn()
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock(735098)')
    db.release()
  }
}
export async function executionEvent(
  p: Pick<ExecutionPortfolio, 'track' | 'mode'>,
  code: string,
  db: Connection = pool,
) {
  await query(
    'INSERT INTO execution_events(track,mode,code) VALUES($1,$2,$3)',
    [p.track, p.mode, code],
    db,
  )
}
export function safeExecutionError(e: unknown) {
  return e instanceof Error && /^(?:EXECUTION|TRADING)_[A-Z0-9_]{1,65}$/.test(e.message)
    ? e.message
    : 'EXECUTION_CONNECTION_FAILED'
}
