import { describe, expect, it } from 'vitest'
import { compareQuotes, fetchArbitrageResearch } from '../../core/earnings/arbitrage'
import { listing } from '../../core/trading/universe'
import type { TradingExchange } from '../../core/trading/types'

const now = Date.now()
function quote(bid = '100', ask = '100.01', at = now) {
  return listing(
    'SOL',
    'USDT',
    'SOLUSDT',
    { active: true },
    {
      at,
      bid,
      ask,
      last: bid,
      open: bid,
      high: '102',
      low: '98',
      turnover: '2000000',
    },
  )
}
describe('public cross-exchange comparison', () => {
  it('compares buy ask to sell bid and includes two-sided fee assumptions', () => {
    const report = compareQuotes({ okx: quote(), bybit: quote('100.5', '100.51') }, now)
    expect(report.pairsCompared).toBe(1)
    expect(report.items[0]).toMatchObject({
      buyExchange: 'okx',
      sellExchange: 'bybit',
      identityVerified: false,
    })
    expect(report.items[0]!.grossBps).toBeGreaterThan(0)
    expect(report.items[0]!.estimatedNetBps).toBeLessThan(0)
  })
  it('never extends old quote validity or counts comparisons with incompatible times', () => {
    const report = compareQuotes(
      { okx: quote('100', '100.01', now - 59000), bybit: quote('101', '101.01', now - 59000) },
      now,
    )
    expect(Date.parse(report.expiresAt)).toBe(now + 1000)
    expect(
      compareQuotes({ okx: quote(), bybit: quote('101', '101.01', now - 30000) }, now)
        .pairsCompared,
    ).toBe(0)
    expect(
      compareQuotes({ okx: quote(), bybit: quote('101', '101.01', now - 61000) }, now).items,
    ).toEqual([])
  })
  it('reports individual source failures without inventing a second side', async () => {
    const report = await fetchArbitrageResearch(async (exchange: TradingExchange) => {
      if (exchange !== 'okx') throw Error('PRIVATE_PROVIDER_DETAIL')
      return quote()
    })
    expect(report.sources.filter((s) => s.status === 'unavailable')).toHaveLength(3)
    expect(report.items).toEqual([])
    expect(JSON.stringify(report)).not.toContain('PRIVATE_PROVIDER_DETAIL')
  })
  it('does not compare a token with itself on the same venue or use malformed quotes', () => {
    expect(compareQuotes({ okx: [...quote(), ...quote('110', '110.01')] }, now).items).toEqual([])
    expect(compareQuotes({ okx: quote(), bybit: quote('100', '99') }, now).items).toEqual([])
  })
})
