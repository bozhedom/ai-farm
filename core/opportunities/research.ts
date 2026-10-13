import { z } from 'zod'
import { abs, decimal, units } from '../trading/decimal'
import { RESEARCH_POLICY } from '../policy'
import type {
  FundingObservation,
  OpportunityFeed,
  OpportunityFeedId,
  OpportunityKind,
  OpportunityObservation,
  OpportunityResearch,
  PredictionObservation,
  YieldObservation,
} from './types'

export { RESEARCH_POLICY } from '../policy'

const endpoints = {
  bybit_funding: 'https://api.bybit.com/v5/market/tickers?category=linear',
  okx_funding: 'https://www.okx.com/api/v5/public/funding-rate?instId=ANY',
  polymarket:
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false',
  kalshi:
    'https://external-api.kalshi.com/trade-api/v2/markets?status=open&limit=200&mve_filter=exclude',
  defi: 'https://yields.llama.fi/pools',
} as const

const descriptions: Record<OpportunityFeedId, { title: string; kind: OpportunityKind }> = {
  bybit_funding: { title: 'Фандинг Bybit', kind: 'funding' },
  okx_funding: { title: 'Фандинг OKX', kind: 'funding' },
  polymarket: { title: 'Polymarket', kind: 'prediction' },
  kalshi: { title: 'Kalshi', kind: 'prediction' },
  defi: { title: 'Стейкинг и DeFi', kind: 'yield' },
}

const text = z.string().trim().min(1).max(500)
const numeric = z.string().regex(/^-?\d{1,24}(?:\.\d{1,36})?$/)
const timestamp = z.string().regex(/^\d{10,16}$/)
const rows = z.array(z.unknown()).max(RESEARCH_POLICY.maxInputRows)
const iso = (value: number) => new Date(value).toISOString()
const positive = (value: string) => {
  const parsed = units(value)
  if (parsed < 0n) throw new Error('RESEARCH_RESPONSE_INVALID')
  return parsed
}
const amount = (value: string) => decimal(positive(value))

/** JSON number tokens stay decimal strings, including values above Number.MAX_SAFE_INTEGER. */
function exactToken(source: string) {
  if (!/[eE]/.test(source)) return source
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d{1,2})$/.exec(source)
  if (!match) throw new Error('RESEARCH_RESPONSE_INVALID')
  const digits = match[2]! + (match[3] || '')
  const point = match[2]!.length + Number(match[4])
  if (Math.abs(point) > 36) throw new Error('RESEARCH_RESPONSE_INVALID')
  return (
    match[1] +
    (point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point))
  )
}

async function publicJson(id: OpportunityFeedId, transport: typeof fetch) {
  const limit = id === 'defi' ? RESEARCH_POLICY.defiResponseBytes : RESEARCH_POLICY.responseBytes
  let response: Response
  try {
    response = await transport(endpoints[id], {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(RESEARCH_POLICY.timeoutMs),
      headers: { Accept: 'application/json' },
    })
  } catch {
    throw new Error('RESEARCH_NETWORK_UNAVAILABLE')
  }
  if (response.status === 403 || response.status === 451)
    throw new Error('RESEARCH_REGION_UNAVAILABLE')
  if (response.status === 429) throw new Error('RESEARCH_RATE_LIMIT')
  if (!response.ok) throw new Error('RESEARCH_SOURCE_UNAVAILABLE')
  if (!response.body) throw new Error('RESEARCH_RESPONSE_INVALID')
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > limit) {
    await response.body.cancel()
    throw new Error('RESEARCH_RESPONSE_TOO_LARGE')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new Error('RESEARCH_RESPONSE_TOO_LARGE')
      chunks.push(chunk.value)
    }
    return JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
      (_key, value, context?: { source?: string }) => {
        if (typeof value !== 'number') return value
        if (!context?.source) throw new Error('RESEARCH_RESPONSE_INVALID')
        return exactToken(context.source)
      },
    ) as unknown
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof Error && error.message === 'RESEARCH_RESPONSE_TOO_LARGE') throw error
    throw new Error('RESEARCH_RESPONSE_INVALID')
  } finally {
    reader.releaseLock()
  }
}

function sourceDate(raw: string | undefined, now: number, maxAgeMs: number) {
  if (!raw) return null
  const at = /^\d{10,16}$/.test(raw) ? Number(raw) : Date.parse(raw)
  if (
    !Number.isSafeInteger(at) ||
    at > now + RESEARCH_POLICY.sourceClockAheadMs ||
    at < now - maxAgeMs
  )
    throw new Error('RESEARCH_SOURCE_STALE')
  return iso(at)
}

function futureDate(raw: string, now: number, maxFutureMs: number) {
  const at = Number(raw)
  if (
    !Number.isSafeInteger(at) ||
    at < now - RESEARCH_POLICY.fundingTimeGraceMs ||
    at > now + maxFutureMs
  )
    throw new Error('RESEARCH_SOURCE_STALE')
  return iso(at)
}

function eventDate(raw: string | null | undefined) {
  if (!raw) return null
  const at = Date.parse(raw)
  if (!Number.isSafeInteger(at)) throw new Error('RESEARCH_RESPONSE_INVALID')
  return iso(at)
}

const bybitRow = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{1,36}$/),
  fundingRate: z.string().max(50),
  nextFundingTime: z.string().max(16),
  fundingIntervalHour: z.string().max(3).optional(),
  turnover24h: numeric,
  deliveryTime: z.string().max(16).optional(),
})

function bybit(value: unknown, now: number) {
  const result = z
    .object({
      retCode: z.literal('0'),
      time: timestamp,
      result: z.object({ category: z.literal('linear'), list: rows }),
    })
    .parse(value)
  const observedAt = sourceDate(result.time, now, RESEARCH_POLICY.refreshMs)
  return select(result.result.list, (raw): FundingObservation | null => {
    const symbol = z.object({ symbol: z.string().max(80) }).parse(raw).symbol
    if (!/^[A-Z0-9]{1,32}USDT$/.test(symbol)) return null
    const row = bybitRow.parse(raw)
    if (
      !row.symbol.endsWith('USDT') ||
      !row.fundingRate ||
      !row.nextFundingTime ||
      (row.deliveryTime && row.deliveryTime !== '0') ||
      positive(row.turnover24h) < units(RESEARCH_POLICY.minFundingTurnoverUsd)
    )
      return null
    const rate = units(row.fundingRate)
    if (abs(rate) > units(RESEARCH_POLICY.maxAbsFundingRate)) return null
    const interval = Number(row.fundingIntervalHour)
    return {
      kind: 'funding',
      id: row.symbol,
      title: row.symbol,
      symbol: row.symbol,
      url: `https://www.bybit.com/trade/usdt/${row.symbol}`,
      observedAt,
      ratePercent: decimal(rate * 100n),
      intervalHours: Number.isInteger(interval) && interval > 0 && interval <= 24 ? interval : null,
      nextFundingAt: futureDate(row.nextFundingTime, now, RESEARCH_POLICY.fundingMaxFutureMs),
      turnoverUsd: amount(row.turnover24h),
    }
  })
}

const okxRow = z.object({
  instId: z.string().regex(/^[A-Z0-9-]{1,70}$/),
  instType: z.string().optional(),
  fundingRate: numeric,
  fundingTime: timestamp,
  prevFundingTime: z.string().max(16).optional(),
  ts: timestamp,
})

function okx(value: unknown, now: number) {
  const result = z.object({ code: z.literal('0'), data: rows }).parse(value)
  return select(result.data, (raw): FundingObservation | null => {
    const instrument = z
      .object({ instId: z.string().max(80), instType: z.string().optional() })
      .parse(raw)
    if (
      !/^[A-Z0-9]{1,32}-USDT-SWAP$/.test(instrument.instId) ||
      (instrument.instType && instrument.instType !== 'SWAP')
    )
      return null
    const row = okxRow.parse(raw)
    const rate = units(row.fundingRate)
    if (abs(rate) > units(RESEARCH_POLICY.maxAbsFundingRate)) return null
    const interval = (Number(row.fundingTime) - Number(row.prevFundingTime)) / 3_600_000
    return {
      kind: 'funding',
      id: row.instId,
      title: row.instId,
      symbol: row.instId,
      url: `https://www.okx.com/trade-swap/${row.instId.toLowerCase()}`,
      observedAt: sourceDate(row.ts, now, RESEARCH_POLICY.refreshMs),
      ratePercent: decimal(rate * 100n),
      intervalHours: Number.isInteger(interval) && interval > 0 && interval <= 24 ? interval : null,
      // fundingTime is the upcoming settlement for fundingRate; nextFundingTime is the following one.
      nextFundingAt: futureDate(row.fundingTime, now, RESEARCH_POLICY.fundingMaxFutureMs),
      turnoverUsd: null,
    }
  })
}

const polymarketRow = z.object({
  id: z.string().regex(/^\d{1,30}$/),
  question: text,
  slug: z.string().regex(/^[a-z0-9-]{1,240}$/),
  active: z.boolean(),
  closed: z.boolean(),
  archived: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  outcomes: z.string().max(3000),
  outcomePrices: z.string().max(3000),
  liquidity: numeric,
  volume24hr: numeric.optional(),
  updatedAt: z.string().max(40).optional(),
  endDate: z.string().max(40).optional(),
})

function polymarket(value: unknown, now: number) {
  return select(rows.parse(value), (raw): PredictionObservation | null => {
    const row = polymarketRow.parse(raw)
    if (
      !row.active ||
      row.closed ||
      row.archived ||
      row.acceptingOrders !== true ||
      positive(row.liquidity) < units(RESEARCH_POLICY.minPredictionLiquidityUsd)
    )
      return null
    const names = z.array(z.string().min(1).max(180)).min(2).max(10).parse(JSON.parse(row.outcomes))
    const prices = z.array(numeric).min(2).max(10).parse(JSON.parse(row.outcomePrices))
    if (names.length !== prices.length) throw new Error('RESEARCH_RESPONSE_INVALID')
    const outcomes = names.map((name, i) => {
      const price = positive(prices[i]!)
      if (price > units('1')) throw new Error('RESEARCH_RESPONSE_INVALID')
      return { name, price: decimal(price) }
    })
    return {
      kind: 'prediction',
      id: row.id,
      title: row.question,
      url: `https://polymarket.com/market/${row.slug}`,
      observedAt: sourceDate(row.updatedAt, now, RESEARCH_POLICY.predictionMaxAgeMs),
      outcomes,
      priceKind: 'indicative',
      volume24hUsd: row.volume24hr === undefined ? null : amount(row.volume24hr),
      volume24hContracts: null,
      liquidityUsd: amount(row.liquidity),
      closesAt: eventDate(row.endDate),
    }
  })
}

const kalshiRow = z.object({
  ticker: z.string().regex(/^[A-Z0-9_.-]{1,160}$/),
  event_ticker: z.string().regex(/^[A-Z0-9_.-]{1,160}$/),
  title: text,
  status: z.string().max(30),
  market_type: z.string().max(30),
  yes_ask_dollars: numeric,
  no_ask_dollars: numeric,
  yes_bid_dollars: numeric,
  no_bid_dollars: numeric,
  volume_24h_fp: numeric,
  notional_value_dollars: numeric,
  updated_time: z.string().max(40).optional(),
  close_time: z.string().max(40),
})

function kalshi(value: unknown, now: number) {
  const result = z.object({ markets: rows }).parse(value)
  return select(result.markets, (raw): PredictionObservation | null => {
    const row = kalshiRow.parse(raw)
    if (
      !['open', 'active'].includes(row.status) ||
      row.market_type !== 'binary' ||
      positive(row.volume_24h_fp) === 0n ||
      units(row.notional_value_dollars) !== units('1')
    )
      return null
    const close = eventDate(row.close_time)
    if (!close || Date.parse(close) <= now) return null
    const yes = positive(row.yes_ask_dollars)
    const no = positive(row.no_ask_dollars)
    if (
      yes <= 0n ||
      no <= 0n ||
      yes >= units('1') ||
      no >= units('1') ||
      positive(row.yes_bid_dollars) > yes ||
      positive(row.no_bid_dollars) > no
    )
      return null
    return {
      kind: 'prediction',
      id: row.ticker,
      title: row.title,
      url: `https://kalshi.com/markets/${row.event_ticker.split('-')[0]!.toLowerCase()}`,
      observedAt: sourceDate(row.updated_time, now, RESEARCH_POLICY.predictionMaxAgeMs),
      outcomes: [
        { name: 'Да', price: decimal(yes) },
        { name: 'Нет', price: decimal(no) },
      ],
      priceKind: 'ask',
      volume24hUsd: null,
      volume24hContracts: amount(row.volume_24h_fp),
      liquidityUsd: null,
      closesAt: close,
    }
  })
}

const defiRow = z.object({
  pool: z.string().uuid(),
  chain: z.string().min(1).max(80),
  project: z.string().min(1).max(100),
  symbol: z.string().min(1).max(100),
  tvlUsd: numeric,
  apy: numeric.nullable(),
  apyReward: numeric.nullable().optional(),
  stablecoin: z.boolean(),
  ilRisk: z.string().max(30),
  exposure: z.string().max(30),
  outlier: z.boolean(),
})

function defi(value: unknown) {
  const result = z.object({ status: z.literal('success'), data: rows }).parse(value)
  return select(result.data, (raw): YieldObservation | null => {
    const row = defiRow.parse(raw)
    if (
      row.apy === null ||
      row.outlier ||
      row.ilRisk !== 'no' ||
      row.exposure !== 'single' ||
      positive(row.tvlUsd) < units(RESEARCH_POLICY.minPoolTvlUsd)
    )
      return null
    const apy = units(row.apy)
    if (apy < 0n || apy > units(RESEARCH_POLICY.maxPoolApyPercent)) return null
    return {
      kind: 'yield',
      id: row.pool,
      title: `${row.symbol} · ${row.project}`,
      url: `https://defillama.com/yields/pool/${row.pool}`,
      observedAt: null,
      project: row.project,
      chain: row.chain,
      symbol: row.symbol,
      apyPercent: decimal(apy),
      rewardApyPercent: row.apyReward == null ? null : amount(row.apyReward),
      tvlUsd: amount(row.tvlUsd),
      stablecoin: row.stablecoin,
    }
  })
}

function select<T extends OpportunityObservation>(
  source: unknown[],
  map: (raw: unknown) => T | null,
) {
  const items: T[] = []
  const ids = new Set<string>()
  let invalid = 0
  let stale = 0
  for (const raw of source) {
    try {
      const item = map(raw)
      if (item && !ids.has(item.id)) {
        ids.add(item.id)
        items.push(item)
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'RESEARCH_SOURCE_STALE') stale++
      else invalid++
    }
  }
  const ranked = [...items].sort((a, b) => {
    const score = (item: OpportunityObservation) => {
      if (item.kind === 'funding') return abs(units(item.ratePercent))
      if (item.kind === 'yield') return units(item.tvlUsd)
      return units(item.volume24hUsd ?? item.volume24hContracts ?? '0')
    }
    const left = score(a)
    const right = score(b)
    return left === right ? a.id.localeCompare(b.id) : left > right ? -1 : 1
  })
  return {
    items: ranked.slice(0, RESEARCH_POLICY.maxItemsPerFeed),
    examined: source.length,
    skipped: source.length - items.length,
    error: invalid ? 'RESEARCH_PARTIAL_RESPONSE' : stale ? 'RESEARCH_SOURCE_STALE' : null,
  }
}

/** Five independent, fixed-host public requests; never reads credentials or places orders. */
export async function fetchOpportunityResearch(
  options: { transport?: typeof fetch; now?: number } = {},
): Promise<OpportunityResearch> {
  const transport = options.transport ?? fetch
  const now = () => options.now ?? Date.now()
  const started = now()
  const feeds = await Promise.all(
    (Object.keys(endpoints) as OpportunityFeedId[]).map(async (id): Promise<OpportunityFeed> => {
      const base = { id, ...descriptions[id] }
      try {
        const raw = await publicJson(id, transport)
        const fetched = now()
        const parsed =
          id === 'bybit_funding'
            ? bybit(raw, fetched)
            : id === 'okx_funding'
              ? okx(raw, fetched)
              : id === 'polymarket'
                ? polymarket(raw, fetched)
                : id === 'kalshi'
                  ? kalshi(raw, fetched)
                  : defi(raw)
        return {
          ...base,
          ...parsed,
          fetchedAt: iso(fetched),
          expiresAt: iso(fetched + RESEARCH_POLICY.refreshMs),
          status: parsed.error ? 'unavailable' : parsed.items.length ? 'ok' : 'empty',
        }
      } catch (error) {
        const fetched = now()
        return {
          ...base,
          status: 'unavailable',
          fetchedAt: iso(fetched),
          expiresAt: iso(fetched + RESEARCH_POLICY.refreshMs),
          error:
            error instanceof Error && /^RESEARCH_[A-Z_]+$/.test(error.message)
              ? error.message
              : 'RESEARCH_RESPONSE_INVALID',
          items: [],
          examined: 0,
          skipped: 0,
        }
      }
    }),
  )
  return {
    version: 'research-v1',
    fetchedAt: iso(started),
    expiresAt: iso(started + RESEARCH_POLICY.refreshMs),
    feeds,
  }
}
