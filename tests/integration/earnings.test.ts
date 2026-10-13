import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool, query } from '../../core/db'
import { controlEarnings, earningsTick, earningsView } from '../../core/earnings/monitor'
import { compareQuotes } from '../../core/earnings/arbitrage'
import type { OpportunityResearch } from '../../core/opportunities/types'
import { applyMigrations, resetDatabase } from './helpers/db'

const snapshot = (): OpportunityResearch => ({
  version: 'research-v1',
  fetchedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 900000).toISOString(),
  feeds: [
    {
      id: 'bybit_funding',
      title: 'Bybit',
      kind: 'funding',
      status: 'ok',
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      error: null,
      examined: 1,
      skipped: 0,
      items: [
        {
          kind: 'funding',
          id: 'SOLUSDT',
          title: 'SOLUSDT',
          url: 'https://www.bybit.com/',
          observedAt: null,
          symbol: 'SOLUSDT',
          ratePercent: '0.01',
          intervalHours: 8,
          nextFundingAt: new Date(Date.now() + 3600000).toISOString(),
          turnoverUsd: '1000000',
        },
      ],
    },
  ],
})
const dependencies = () => ({
  research: async () => snapshot(),
  arbitrage: async () => compareQuotes({}),
})
beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterAll(() => pool.end())

describe('durable public research monitor', () => {
  it('stays idle until requested, completes a one-off snapshot without allocating capital', async () => {
    expect(await earningsTick(dependencies())).toBe(false)
    await controlEarnings('refresh')
    expect((await earningsView()).monitor.pending).toBe(true)
    expect(await earningsTick(dependencies())).toBe(true)
    expect((await earningsView()).monitor).toMatchObject({
      enabled: false,
      pending: false,
      running: false,
      error: '',
    })
    expect(await query('SELECT * FROM trading_orders')).toEqual([])
    expect(await query('SELECT * FROM tool_calls')).toEqual([])
    expect(await earningsTick(dependencies())).toBe(false)
    await expect(controlEarnings('refresh')).rejects.toThrow('EARNINGS_REFRESH_COOLDOWN')
  })
  it('claims only one worker and does not re-enable a paused schedule on completion', async () => {
    await controlEarnings('enable')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const claimed = new Promise<void>((resolve) => {
      started = resolve
    })
    const first = earningsTick({
      research: async () => {
        started()
        await gate
        return snapshot()
      },
      arbitrage: dependencies().arbitrage,
    })
    await claimed
    expect(await earningsTick(dependencies())).toBe(false)
    await controlEarnings('pause')
    release()
    expect(await first).toBe(true)
    expect((await earningsView()).monitor.enabled).toBe(false)
    expect(await earningsTick(dependencies())).toBe(false)
  })
  it('preserves unavailable observations and their original time without exposing provider errors', async () => {
    await controlEarnings('refresh')
    await earningsTick(dependencies())
    const old = (await earningsView()).report!.feeds[0]!
    await query("UPDATE earnings_monitor SET attempted_at=now()-interval '2 minutes'")
    await controlEarnings('refresh')
    const unavailable = snapshot()
    unavailable.feeds[0]!.status = 'unavailable'
    unavailable.feeds[0]!.error = 'RESEARCH_RATE_LIMIT'
    unavailable.feeds[0]!.items = []
    await earningsTick({
      research: async () => unavailable,
      arbitrage: async () => {
        throw Error('SECRET_DETAIL')
      },
    })
    const view = await earningsView()
    expect(view.report!.feeds[0]).toMatchObject({
      status: 'unavailable',
      items: old.items,
      fetchedAt: old.fetchedAt,
      expiresAt: old.expiresAt,
    })
    expect(view.monitor.error).toBe('EARNINGS_SOURCE_FAILED')
    expect(JSON.stringify(view)).not.toContain('SECRET_DETAIL')
  })
  it('does not accept a completed snapshot after the lease expired', async () => {
    await controlEarnings('refresh')
    expect(
      await earningsTick({
        research: async () => {
          await query("UPDATE earnings_monitor SET lease_until=now()-interval '1 second'")
          return snapshot()
        },
        arbitrage: dependencies().arbitrage,
      }),
    ).toBe(false)
    expect((await earningsView()).report).toBe(null)
    expect(await earningsTick(dependencies())).toBe(true)
  })
})
