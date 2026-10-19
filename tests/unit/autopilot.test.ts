import { describe, expect, it } from 'vitest'
import { autopilotPlan, type AutopilotInput } from '../../core/autopilot'
import { loopHealth, loopSpecs } from '../../core/worker-loops'
import { exchanges } from '../../core/trading/types'
import { executionTracks } from '../../core/execution/types'

const modes = ['paper', 'demo', 'live'] as const
function input(overrides: Partial<AutopilotInput> = {}): AutopilotInput {
  return {
    systemMode: 'running',
    autonomyEnabled: true,
    workspaceMode: 'studio',
    scheduleEnabled: false,
    scheduleOwnerOff: false,
    manager: { enabled: false, ownerOff: false, blocker: '' },
    trading: exchanges.flatMap((exchange) =>
      modes.map((mode) => ({
        exchange,
        mode,
        status: 'idle',
        reason: '',
        hasKeys: mode === 'paper' || (mode === 'demo' && exchange === 'bybit'),
      })),
    ),
    execution: executionTracks.flatMap((track) =>
      modes.map((mode) => ({
        track,
        mode,
        status: 'idle',
        reason: '',
        started: false,
        capitalOk: false,
        ready:
          mode === 'paper'
            ? ''
            : mode === 'live'
              ? 'EXECUTION_LIVE_DISABLED'
              : 'EXECUTION_CREDENTIALS_REQUIRED',
      })),
    ),
    paperExecutionUsdt: 100,
    options: { demo: true, execution: true },
    ...overrides,
  }
}
const actions = (plan: ReturnType<typeof autopilotPlan>) =>
  plan.filter((d) => d.action !== 'none').map((d) => `${d.action} ${d.key}`)

describe('autopilot decisions', () => {
  it('turns on everything that was never started, Demo only with keys', () => {
    expect(actions(autopilotPlan(input()))).toEqual([
      'enable_schedule schedule',
      'enable_manager manager',
      'start_trading trading:okx:paper',
      'start_trading trading:bybit:paper',
      'start_trading trading:bybit:demo',
      'start_trading trading:binance:paper',
      'start_trading trading:bitget:paper',
      'configure_execution execution:arbitrage:paper',
      'configure_execution execution:funding:paper',
      'configure_execution execution:defi:paper',
    ])
    const plan = autopilotPlan(input())
    expect(plan.find((d) => d.key === 'trading:okx:demo')).toMatchObject({
      status: 'blocked',
      code: 'TRADING_CREDENTIALS_REQUIRED',
    })
    expect(plan.find((d) => d.key === 'execution:prediction:paper')?.status).toBe('blocked')
    expect(plan.find((d) => d.key === 'live')?.status).toBe('blocked')
  })

  it('never acts on Live, whatever the state says', () => {
    const live = input({
      trading: input().trading.map((t) => ({ ...t, hasKeys: true })),
      execution: input().execution.map((e) => ({ ...e, ready: '', capitalOk: true })),
    })
    const plan = autopilotPlan(live)
    expect(plan.some((d) => d.action !== 'none' && d.key.endsWith(':live'))).toBe(false)
    expect(plan.some((d) => d.mode === ('live' as never))).toBe(false)
  })

  it('does nothing while the farm is paused or stopped', () => {
    for (const systemMode of ['paused', 'emergency_stop']) {
      const plan = autopilotPlan(input({ systemMode }))
      expect(actions(plan)).toEqual([])
      expect(plan).toHaveLength(1)
      expect(plan[0]!.status).toBe('blocked')
    }
  })

  it('keeps owner decisions: switched off, paused, stopped and risk-stopped stay as they are', () => {
    const plan = autopilotPlan(
      input({
        scheduleOwnerOff: true,
        manager: { enabled: false, ownerOff: true, blocker: '' },
        trading: input().trading.map((t) =>
          t.exchange === 'okx' && t.mode === 'paper'
            ? { ...t, status: 'paused', reason: 'OWNER_PAUSE' }
            : t.exchange === 'bybit' && t.mode === 'paper'
              ? { ...t, status: 'paused', reason: 'DAILY_LOSS_LIMIT' }
              : t.exchange === 'binance' && t.mode === 'paper'
                ? { ...t, status: 'stopped', reason: 'OWNER_STOP' }
                : t,
        ),
        execution: input().execution.map((e) =>
          e.track === 'arbitrage' && e.mode === 'paper'
            ? { ...e, status: 'paused', started: true, capitalOk: true }
            : e.track === 'funding' && e.mode === 'paper'
              ? { ...e, status: 'stopped', reason: 'EXECUTION_DRAWDOWN_STOP', started: true }
              : e,
        ),
      }),
    )
    expect(actions(plan)).toEqual([
      'start_trading trading:bybit:demo',
      'start_trading trading:bitget:paper',
      'configure_execution execution:defi:paper',
    ])
    for (const key of ['schedule', 'manager', 'trading:okx:paper', 'trading:bybit:paper'])
      expect(plan.find((d) => d.key === key)?.status).toBe('blocked')
    expect(plan.find((d) => d.key === 'trading:bybit:paper')?.text).toContain('лимит убытка')
  })

  it('respects server switches and leaves unconfigured money to the owner', () => {
    const plan = autopilotPlan(
      input({
        autonomyEnabled: false,
        workspaceMode: 'trading',
        paperExecutionUsdt: 0,
        execution: input().execution.map((e) =>
          e.mode === 'demo' && e.track === 'funding' ? { ...e, ready: '' } : e,
        ),
      }),
    )
    expect(plan.find((d) => d.key === 'schedule')).toMatchObject({
      status: 'blocked',
      code: 'AUTONOMY_ENABLED_FALSE',
    })
    expect(plan.find((d) => d.key === 'studio')?.code).toBe('WORKSPACE_MODE_TRADING')
    expect(actions(plan).filter((a) => a.includes('execution'))).toEqual([])
    expect(plan.find((d) => d.key === 'execution:funding:demo')?.text).toContain('сумму')
  })

  it('starts an owner-configured Demo execution book when its keys are present', () => {
    const plan = autopilotPlan(
      input({
        execution: input().execution.map((e) =>
          e.mode === 'demo' && e.track === 'funding' ? { ...e, ready: '', capitalOk: true } : e,
        ),
      }),
    )
    expect(actions(plan)).toContain('start_execution execution:funding:demo')
  })

  it('follows narrower options and reports running items without acting', () => {
    const running = input({
      scheduleEnabled: true,
      manager: { enabled: true, ownerOff: false, blocker: 'MANAGER_MODEL_TOO_EXPENSIVE' },
      trading: input().trading.map((t) => ({ ...t, status: 'running' })),
    })
    const plan = autopilotPlan({ ...running, options: { demo: false, execution: false } })
    expect(actions(plan)).toEqual([])
    expect(plan.some((d) => d.key.startsWith('execution:'))).toBe(false)
    expect(plan.some((d) => d.key.endsWith(':demo'))).toBe(false)
    expect(plan.find((d) => d.key === 'manager')).toMatchObject({
      status: 'running',
      code: 'MANAGER_MODEL_TOO_EXPENSIVE',
    })
  })

  it('writes owner lines without dashes, arrows or codes', () => {
    for (const d of autopilotPlan(input())) {
      expect(d.text).not.toMatch(/[—–→←·]/)
      expect(d.text).not.toMatch(/[A-Z]{3,}_[A-Z_]+/)
    }
  })
})

describe('worker loop heartbeats', () => {
  const now = new Date('2026-10-21T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const row = (name: string, fields: Record<string, unknown>) => ({
    name,
    started_at: null,
    ok_at: null,
    error_at: null,
    error: '',
    runs: 1,
    failures: 0,
    consecutive_failures: 0,
    ...fields,
  })
  it('tells ok, failing, stale, stuck and never-run loops apart', () => {
    const health = loopHealth(
      [
        row('payments', { ok_at: ago(10_000) }),
        row('earnings', {
          ok_at: ago(60 * 60_000),
          error_at: ago(5000),
          error: 'X_FAILED',
          consecutive_failures: 2,
        }),
        row('manager', { ok_at: ago(60 * 60_000) }),
        row('execution', { started_at: ago(31 * 60_000), ok_at: ago(40 * 60_000) }),
        row('schedule', { started_at: ago(60_000), ok_at: ago(2 * 60 * 60_000) }),
      ],
      now,
    )
    const state = (name: string) => health.find((h) => h.name === name)!.state
    expect(state('payments')).toBe('ok')
    expect(state('earnings')).toBe('failing')
    expect(health.find((h) => h.name === 'earnings')!.error).toBe('X_FAILED')
    expect(state('manager')).toBe('stale')
    expect(state('execution')).toBe('stuck')
    expect(state('schedule')).toBe('ok')
    expect(state('farm')).toBe('never')
    expect(health.map((h) => h.name)).toEqual(Object.keys(loopSpecs))
  })
})
