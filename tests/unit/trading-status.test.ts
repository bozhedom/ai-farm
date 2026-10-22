import { describe, expect, it } from 'vitest'
import {
  tradingReasonWords,
  tradingStatus,
  tradingStatusText,
} from '../../core/income/trading-status'

const base = { keys: true, workerAlive: true, fresh: true }

describe('owner trading status', () => {
  it('names the daily loss pause and when training continues', () => {
    const paused = { ...base, mode: 'paper' as const, status: 'paused', reason: 'DAILY_LOSS_LIMIT' }
    expect(tradingStatusText(tradingStatus({ ...paused, autoResume: true }))).toBe(
      'На паузе: дневной лимит убытка, продолжит после 00:00 UTC',
    )
    // Without the autopilot nobody restarts it: the text must not promise that.
    expect(tradingStatusText(tradingStatus(paused))).toBe(
      'На паузе: дневной лимит убытка, запустить снова можно после 00:00 UTC',
    )
  })

  it('tells the owner apart from limits and never shows codes', () => {
    const stopped = tradingStatus({
      ...base,
      mode: 'live',
      status: 'stopped',
      reason: 'OWNER_STOP',
    })
    expect(stopped.label).toBe('Остановлено вами')
    expect(tradingStatus({ ...base, mode: 'paper', status: 'running', reason: '' }).label).toBe(
      'Работает',
    )
    const odd = tradingStatus({
      ...base,
      mode: 'demo',
      status: 'running',
      reason: 'TRADING_SOMETHING_NEW',
    })
    expect(tradingStatusText(odd)).not.toMatch(/[A-Z]{3,}_[A-Z]/)
    expect(tradingReasonWords('DRAWDOWN_LIMIT')).toBe('лимит просадки')
  })
})
