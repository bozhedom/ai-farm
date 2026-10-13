import { describe, expect, it, vi } from 'vitest'
import { fetchOpportunityResearch, RESEARCH_POLICY } from '../../core/opportunities/research'
import type { OpportunityFeedId } from '../../core/opportunities/types'

const now = Date.UTC(2026, 9, 13, 1)
const iso = (offset: number) => new Date(now + offset).toISOString()

const bybit = () => ({
  symbol: 'SOLUSDT',
  fundingRate: '-0.000123456789012345',
  nextFundingTime: String(now + 7 * 3_600_000),
  fundingIntervalHour: '8',
  turnover24h: '9007199254740993.000000000000000001',
  deliveryTime: '0',
})
const okx = () => ({
  instId: 'SOL-USDT-SWAP',
  instType: 'SWAP',
  fundingRate: '0.0001',
  fundingTime: String(now + 7 * 3_600_000),
  nextFundingTime: String(now + 15 * 3_600_000),
  prevFundingTime: String(now - 3_600_000),
  ts: String(now),
})
const polymarket = () => ({
  id: '12',
  question: 'Will the next launch succeed?',
  slug: 'will-the-next-launch-succeed',
  active: true,
  closed: false,
  acceptingOrders: true,
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.61","0.39"]',
  liquidity: '10000',
  volume24hr: 12345.67,
  updatedAt: iso(-30_000),
  endDate: iso(3_600_000),
})
const kalshi = () => ({
  ticker: 'KXTEST-26OCT13-T1',
  event_ticker: 'KXTEST-26OCT13',
  title: 'Will the next launch succeed?',
  market_type: 'binary',
  status: 'active',
  yes_ask_dollars: '0.6400',
  no_ask_dollars: '0.4200',
  yes_bid_dollars: '0.5800',
  no_bid_dollars: '0.3600',
  volume_24h_fp: '1728.25',
  notional_value_dollars: '1.0000',
  updated_time: iso(-30_000),
  close_time: iso(3_600_000),
})
const defi = () => ({
  pool: '747c1d2a-c668-4682-b9f9-296708a3dd90',
  chain: 'Ethereum',
  project: 'lido',
  symbol: 'STETH',
  tvlUsd: 10000001,
  apy: 2.218,
  apyReward: null,
  stablecoin: false,
  ilRisk: 'no',
  exposure: 'single',
  outlier: false,
})

function fixtures(): Record<OpportunityFeedId, unknown> {
  return {
    bybit_funding: { retCode: 0, time: now, result: { category: 'linear', list: [bybit()] } },
    okx_funding: { code: '0', data: [okx()] },
    polymarket: [polymarket()],
    kalshi: { markets: [kalshi()] },
    defi: { status: 'success', data: [defi()] },
  }
}

const hosts: Record<string, OpportunityFeedId> = {
  'api.bybit.com': 'bybit_funding',
  'www.okx.com': 'okx_funding',
  'gamma-api.polymarket.com': 'polymarket',
  'external-api.kalshi.com': 'kalshi',
  'yields.llama.fi': 'defi',
}
function transport(
  changes: Partial<Record<OpportunityFeedId, unknown>> = {},
  failures: Partial<Record<OpportunityFeedId, number>> = {},
) {
  const data = { ...fixtures(), ...changes }
  return vi.fn<typeof fetch>(async (input) => {
    const id = hosts[new URL(String(input)).hostname]!
    if (!id) throw new Error('Unexpected host')
    return Response.json(data[id], { status: failures[id] ?? 200 })
  })
}

describe('public opportunity research', () => {
  it('fetches five fixed public endpoints and returns exact, JSON-safe observations', async () => {
    const fetcher = transport()
    const report = await fetchOpportunityResearch({ transport: fetcher, now })
    expect(report.version).toBe('research-v1')
    expect(report.feeds.every((feed) => feed.status === 'ok')).toBe(true)
    expect(report.expiresAt).toBe(iso(RESEARCH_POLICY.refreshMs))
    expect(report.feeds[0]!.items[0]).toMatchObject({
      symbol: 'SOLUSDT',
      ratePercent: '-0.0123456789012345',
      turnoverUsd: '9007199254740993.000000000000000001',
      intervalHours: 8,
    })
    expect(report.feeds[1]!.items[0]).toMatchObject({
      ratePercent: '0.01',
      intervalHours: 8,
      nextFundingAt: iso(7 * 3_600_000),
    })
    expect(report.feeds[2]!.items[0]).toMatchObject({
      priceKind: 'indicative',
      volume24hUsd: '12345.67',
      outcomes: [
        { name: 'Yes', price: '0.61' },
        { name: 'No', price: '0.39' },
      ],
    })
    expect(report.feeds[3]!.items[0]).toMatchObject({
      priceKind: 'ask',
      volume24hUsd: null,
      volume24hContracts: '1728.25',
    })
    expect(report.feeds[4]!.items[0]).toMatchObject({
      apyPercent: '2.218',
      rewardApyPercent: null,
      observedAt: null,
    })
    expect(() => JSON.stringify(report)).not.toThrow()
    for (const [url, options] of fetcher.mock.calls) {
      expect(new URL(String(url)).protocol).toBe('https:')
      expect(options).toMatchObject({
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      })
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      expect(options?.body).toBeUndefined()
    }
  })

  it('keeps numeric JSON tokens exact before validation, including scientific notation', async () => {
    const ordinary = transport()
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('yields.llama.fi'))
        return new Response(
          JSON.stringify({ status: 'success', data: [defi()] })
            .replace('10000001', '9007199254740993')
            .replace('2.218', '2.218e-3'),
        )
      return ordinary(url, options)
    })
    const report = await fetchOpportunityResearch({ transport: fetcher, now })
    expect(report.feeds[4]!.items[0]).toMatchObject({
      tvlUsd: '9007199254740993',
      apyPercent: '0.002218',
    })
  })

  it('does not turn the timestamp of a new request into fresh upstream market data', async () => {
    const fetcher = transport({
      bybit_funding: {
        retCode: 0,
        time: now - RESEARCH_POLICY.refreshMs - 1,
        result: { category: 'linear', list: [bybit()] },
      },
      okx_funding: { code: '0', data: [{ ...okx(), ts: String(now + 121_000) }] },
      polymarket: [{ ...polymarket(), updatedAt: iso(-25 * 3_600_000) }],
    })
    const report = await fetchOpportunityResearch({ transport: fetcher, now })
    for (const feed of report.feeds.slice(0, 3)) {
      expect(feed.status).toBe('unavailable')
      expect(feed.error).toBe('RESEARCH_SOURCE_STALE')
      expect(feed.items).toEqual([])
    }
    expect(report.feeds[4]!.status).toBe('ok')
    expect(report.feeds[4]!.items[0]!.observedAt).toBeNull()
  })

  it('isolates region blocks, limits and bad responses without following alternate hosts', async () => {
    const fetcher = transport({ defi: { malformed: true } }, { bybit_funding: 451, kalshi: 429 })
    const report = await fetchOpportunityResearch({ transport: fetcher, now })
    expect(report.feeds[0]).toMatchObject({
      status: 'unavailable',
      error: 'RESEARCH_REGION_UNAVAILABLE',
    })
    expect(report.feeds[1]!.status).toBe('ok')
    expect(report.feeds[2]!.status).toBe('ok')
    expect(report.feeds[3]!.error).toBe('RESEARCH_RATE_LIMIT')
    expect(report.feeds[4]!.error).toBe('RESEARCH_RESPONSE_INVALID')
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('rejects malformed outcomes and untrusted URL fields while retaining other sources', async () => {
    const report = await fetchOpportunityResearch({
      now,
      transport: transport({
        polymarket: [
          { ...polymarket(), id: '1', slug: 'javascript:alert(1)' },
          { ...polymarket(), id: '2', outcomePrices: '["0.2"]' },
          { ...polymarket(), id: '3', outcomePrices: '["1.2","-0.2"]' },
          { ...polymarket(), id: '4', question: 'x'.repeat(501) },
          { ...polymarket(), id: '5', url: 'https://evil.example', image: 'javascript:alert(1)' },
        ],
      }),
    })
    const feed = report.feeds[2]!
    expect(feed).toMatchObject({ status: 'unavailable', error: 'RESEARCH_PARTIAL_RESPONSE' })
    expect(feed.items).toHaveLength(1)
    expect(feed.skipped).toBe(4)
    expect(feed.items[0]!.url).toBe('https://polymarket.com/market/will-the-next-launch-succeed')
    expect(JSON.stringify(report)).not.toContain('evil.example')
    expect(report.feeds[0]!.status).toBe('ok')
  })

  it('filters thin and closed markets, extreme yields and unrelated futures without claims of income', async () => {
    const report = await fetchOpportunityResearch({
      now,
      transport: transport({
        bybit_funding: {
          retCode: 0,
          time: now,
          result: {
            category: 'linear',
            list: [
              { ...bybit(), symbol: 'SOLUSDT-30DEC26' },
              { ...bybit(), symbol: 'SOLUSDC' },
              { ...bybit(), turnover24h: '999999' },
            ],
          },
        },
        okx_funding: {
          code: '0',
          data: [{ instId: 'BTC-USD-261230', instType: 'FUTURES', fundingRate: '' }],
        },
        polymarket: [{ ...polymarket(), closed: true }],
        kalshi: { markets: [{ ...kalshi(), volume_24h_fp: '0' }] },
        defi: {
          status: 'success',
          data: [
            { ...defi(), apy: 500 },
            { ...defi(), ilRisk: 'yes' },
          ],
        },
      }),
    })
    expect(
      report.feeds.map((feed) => ({ id: feed.id, status: feed.status, error: feed.error })),
    ).toEqual(
      ['bybit_funding', 'okx_funding', 'polymarket', 'kalshi', 'defi'].map((id) => ({
        id,
        status: 'empty',
        error: null,
      })),
    )
    expect(report.feeds.every((feed) => feed.items.length === 0)).toBe(true)
  })

  it('bounds published records and ranks DeFi by size instead of advertised high APY', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...defi(),
      pool: `747c1d2a-c668-4682-b9f9-${String(i).padStart(12, '0')}`,
      tvlUsd: 2_000_000 + i,
      apy: 40 - i,
    }))
    const report = await fetchOpportunityResearch({
      now,
      transport: transport({ defi: { status: 'success', data: [...many, many[0]] } }),
    })
    expect(report.feeds[4]!.items).toHaveLength(RESEARCH_POLICY.maxItemsPerFeed)
    expect(report.feeds[4]!.items[0]).toMatchObject({ apyPercent: '11', tvlUsd: '2000029' })
    expect(report.feeds[4]!.examined).toBe(31)
    expect(report.feeds[4]!.skipped).toBe(1)
  })

  it('bounds declared and streamed response sizes', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('yields.llama.fi'))
        return new Response('{}', { headers: { 'Content-Length': String(21 * 1024 * 1024) } })
      return new Response('x'.repeat(3 * 1024 * 1024 + 1))
    })
    const report = await fetchOpportunityResearch({ transport: fetcher, now })
    expect(report.feeds.every((feed) => feed.error === 'RESEARCH_RESPONSE_TOO_LARGE')).toBe(true)
  })
})
