import { describe, expect, it } from 'vitest'
import {
  compareQuotes,
  enrichWithDepth,
  fetchArbitrageResearch,
  walkAsks,
  walkBids,
} from '../../core/earnings/arbitrage'
import { units } from '../../core/trading/decimal'
import { listing } from '../../core/trading/universe'
import type { Market, TradingExchange, TradingSymbol } from '../../core/trading/types'

const now = Date.now()
function quote(bid = '100', ask = '100.01', at = now, turnover = '2000000') {
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
      turnover,
    },
  )
}
function market(
  symbol: TradingSymbol,
  asks: [string, string][],
  bids: [string, string][],
  at = now,
): Market {
  return {
    instrument: { symbol, lot: units('0.001'), minQty: units('0.001'), tick: units('0.01') },
    book: {
      symbol,
      at,
      asks: asks.map(([p, q]) => [units(p), units(q)]),
      bids: bids.map(([p, q]) => [units(p), units(q)]),
    },
    candles: [],
  }
}

describe('public cross-exchange comparison', () => {
  it('compares buy ask to sell bid and includes two-sided fee assumptions', () => {
    const report = compareQuotes({ okx: quote(), bybit: quote('100.5', '100.51') }, now)
    expect(report.pairsCompared).toBe(1)
    expect(report.items[0]).toMatchObject({
      buyExchange: 'okx',
      sellExchange: 'bybit',
      identityVerified: false,
      depthChecked: false,
    })
    expect(report.items[0]!.grossBps).toBeGreaterThan(0)
    expect(report.items[0]!.estimatedNetBps).toBeLessThan(0)
    expect(report.items[0]!.scoreBps).toBeLessThanOrEqual(report.items[0]!.estimatedNetBps)
    expect(report.sampleNotional).toBe('50')
  })

  it('ranks higher-turnover venues above equal-score thin books', () => {
    const report = compareQuotes(
      {
        okx: [
          ...listing(
            'AAA',
            'USDT',
            'AAAUSDT',
            { active: true },
            {
              at: now,
              bid: '10',
              ask: '10.01',
              last: '10',
              open: '10',
              high: '11',
              low: '9',
              turnover: '100000',
            },
          ),
          ...listing(
            'BBB',
            'USDT',
            'BBBUSDT',
            { active: true },
            {
              at: now,
              bid: '10',
              ask: '10.01',
              last: '10',
              open: '10',
              high: '11',
              low: '9',
              turnover: '5000000',
            },
          ),
        ],
        bybit: [
          ...listing(
            'AAA',
            'USDT',
            'AAAUSDT',
            { active: true },
            {
              at: now,
              bid: '10.2',
              ask: '10.21',
              last: '10.2',
              open: '10',
              high: '11',
              low: '9',
              turnover: '100000',
            },
          ),
          ...listing(
            'BBB',
            'USDT',
            'BBBUSDT',
            { active: true },
            {
              at: now,
              bid: '10.2',
              ask: '10.21',
              last: '10.2',
              open: '10',
              high: '11',
              low: '9',
              turnover: '5000000',
            },
          ),
        ],
      },
      now,
    )
    expect(report.items[0]!.symbol).toBe('BBB-USDT')
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

describe('order-book depth probe', () => {
  it('walks asks and bids in integer units without float', () => {
    const book = market(
      'SOL-USDT',
      [
        ['100', '1'],
        ['101', '2'],
      ],
      [
        ['99', '1'],
        ['98', '2'],
      ],
    ).book
    const bought = walkAsks(book, units('150'), 5)
    expect(bought.spent).toBe(units('150'))
    expect(bought.remaining).toBe(0n)
    const sold = walkBids(book, bought.qty, 5)
    expect(sold.earned).toBeGreaterThan(0n)
  })

  it('replaces ticker net with depth-adjusted net for probed pairs', async () => {
    const tickers = compareQuotes({ okx: quote(), bybit: quote('101', '101.01') }, now)
    expect(tickers.items).toHaveLength(1)
    const report = await enrichWithDepth(tickers, async (exchange) => {
      if (exchange === 'okx') return market('SOL-USDT', [['100.01', '10']], [['99.9', '10']])
      return market('SOL-USDT', [['101.01', '10']], [['101', '10']])
    })
    expect(report.items[0]).toMatchObject({
      depthChecked: true,
      buyExchange: 'okx',
      sellExchange: 'bybit',
    })
    expect(report.items[0]!.fillableNotional).not.toBeNull()
    expect(units(report.items[0]!.fillableNotional!)).toBeGreaterThan(0n)
  })
})
