import { describe, expect, it } from 'vitest'
import { WALLET_POLICY } from '../../core/policy'
import { syncWindows } from '../../core/wallet/sync'

describe('wallet sync windows', () => {
  const day = 24 * 60 * 60_000
  const end = Date.UTC(2026, 9, 25)

  it('covers the latest Bybit window on the first run', () => {
    const windows = syncWindows(end, null)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toEqual({
      start: end - WALLET_POLICY.windowMs + WALLET_POLICY.overlapMs,
      end,
    })
  })

  it('walks forward from an old cursor in overlapping windows', () => {
    const cursor = end - 80 * day
    const windows = syncWindows(end, cursor)
    expect(windows.length).toBe(WALLET_POLICY.maxWindowsPerTick)
    expect(windows[0]!.start).toBe(cursor - WALLET_POLICY.overlapMs)
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBe(windows[i - 1]!.end)
    expect(windows.at(-1)!.end - windows[0]!.start).toBeLessThanOrEqual(
      WALLET_POLICY.maxWindowsPerTick * WALLET_POLICY.windowMs,
    )
    expect(windows.every((w) => w.end - w.start <= WALLET_POLICY.windowMs)).toBe(true)
  })

  it('returns nothing when coverage is already current', () => {
    expect(syncWindows(end, end)).toEqual([])
    expect(syncWindows(end, end + 1000)).toEqual([])
  })
})
