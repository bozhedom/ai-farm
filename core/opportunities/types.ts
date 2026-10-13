/** Public observations only. These records cannot authorize an order or a wallet action. */
export type OpportunityFeedId = 'bybit_funding' | 'okx_funding' | 'polymarket' | 'kalshi' | 'defi'

export type OpportunityKind = 'funding' | 'prediction' | 'yield'

interface ObservationBase {
  id: string
  title: string
  url: string
  /** Upstream observation time, when supplied. Never replaced with the request time. */
  observedAt: string | null
}

export interface FundingObservation extends ObservationBase {
  kind: 'funding'
  symbol: string
  /** Signed percentage for one funding interval, not annual return. */
  ratePercent: string
  intervalHours: number | null
  nextFundingAt: string
  turnoverUsd: string | null
}

export interface PredictionObservation extends ObservationBase {
  kind: 'prediction'
  outcomes: { name: string; price: string }[]
  priceKind: 'indicative' | 'ask'
  volume24hUsd: string | null
  /** Kalshi reports contract counts, which must not be labelled as USD volume. */
  volume24hContracts: string | null
  liquidityUsd: string | null
  /** Declared event/market end; upstream can keep accepting orders after this date. */
  closesAt: string | null
}

export interface YieldObservation extends ObservationBase {
  kind: 'yield'
  project: string
  chain: string
  symbol: string
  /** Provider's current annualized yield estimate; not a forecast or a promised return. */
  apyPercent: string
  rewardApyPercent: string | null
  tvlUsd: string
  stablecoin: boolean
}

export type OpportunityObservation = FundingObservation | PredictionObservation | YieldObservation

export interface OpportunityFeed {
  id: OpportunityFeedId
  title: string
  kind: OpportunityKind
  status: 'ok' | 'empty' | 'unavailable'
  fetchedAt: string
  expiresAt: string
  error: string | null
  items: OpportunityObservation[]
  examined: number
  skipped: number
}

export interface OpportunityResearch {
  version: 'research-v1'
  fetchedAt: string
  expiresAt: string
  feeds: OpportunityFeed[]
}
