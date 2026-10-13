import { EXECUTION_POLICY as P } from '../../policy'
import {
  BPS,
  ceilDiv,
  ceilStep,
  cost,
  decimal,
  fee,
  floorStep,
  min,
  proceeds,
  SCALE,
  units,
} from '../../trading/decimal'
import type { Market, TradingSymbol } from '../../trading/types'
import {
  BybitFundingAdapter,
  type BybitFundingOptions,
  type FundingMarket,
} from '../adapters/bybit-funding'
import { createPaperAdapter } from '../adapters/paper'
import type {
  ExecutionAdapter,
  ExecutionDecision,
  ExecutionDriver,
  ExecutionFlow,
  ExecutionIntent,
  ExecutionLeg,
  ExecutionMode,
  ExecutionOperation,
  ExecutionPortfolio,
} from '../types'

type FundingClient = Pick<
  BybitFundingAdapter,
  | 'market'
  | 'discover'
  | 'account'
  | 'positions'
  | 'pending'
  | 'fundingHistory'
  | 'fundingRates'
  | 'prepare'
  | 'broadcast'
  | 'lookup'
  | 'cancel'
>
type Dependencies = { venue?: FundingClient; now?: () => number }
const venueName = 'bybit-funding' as const
const week = 7 * 24 * 60 * 60_000

function limits(market: Market) {
  const slippage = BigInt(P.slippageBps)
  return {
    buy: ceilStep(ceilDiv(market.book.asks[0]![0] * (BPS + slippage), BPS), market.instrument.tick),
    sell: floorStep((market.book.bids[0]![0] * (BPS - slippage)) / BPS, market.instrument.tick),
  }
}

function tradable(qty: bigint, price: bigint, market: Market, reduceOnly = false) {
  return (
    qty > 0n &&
    qty >= market.instrument.minQty &&
    qty % market.instrument.lot === 0n &&
    (reduceOnly || cost(qty, price) >= (market.instrument.minNotional || units(P.minOrder)))
  )
}

function totals(legs: ExecutionLeg[]) {
  let spot = 0n,
    short = 0n,
    cash = 0n,
    fees = 0n
  for (const leg of legs) {
    const receipt = leg.receipt
    if (!receipt) continue
    const qty = units(receipt.filledQuantity),
      gross = units(receipt.grossQuote),
      quoteFee = units(receipt.quoteFee),
      baseFee = units(receipt.baseFee)
    const action = leg.prepared.intent.action
    if (
      !['buy', 'sell', 'short', 'cover'].includes(action) ||
      qty < 0n ||
      gross < 0n ||
      (qty === 0n && (gross || quoteFee || baseFee)) ||
      (['short', 'cover'].includes(action) && baseFee)
    )
      throw new Error('EXECUTION_RECEIPT_INVALID')
    if (action === 'buy') spot += qty - baseFee
    else if (action === 'sell') spot -= qty + baseFee
    else if (action === 'short') short += qty
    else short -= qty
    cash += (['buy', 'cover'].includes(action) ? -gross : gross) - quoteFee
    fees += quoteFee + (qty ? (baseFee * gross) / qty : 0n)
  }
  if (spot < 0n || short < 0n) throw new Error('EXECUTION_POSITION_MISMATCH')
  return { spot, short, cash, fees }
}

/** Pure decisions create durable legs; exchange mutations belong to the shared execution engine. */
export function createFundingDriver(
  mode: ExecutionMode,
  options: Omit<BybitFundingOptions, 'mode'> = { credentials: { key: '', secret: '' } },
  dependencies: Dependencies = {},
): ExecutionDriver {
  const now = dependencies.now || Date.now
  const venue =
    dependencies.venue ||
    new BybitFundingAdapter({ ...options, mode: mode === 'paper' ? 'demo' : mode }, fetch, now)
  const execution: ExecutionAdapter =
    mode === 'paper'
      ? createPaperAdapter(async (intent) => {
          const market = await venue.market(intent.symbol as TradingSymbol)
          return ['buy', 'sell'].includes(intent.action) ? market.spot : market.perp
        })
      : venue

  const symbols = async (p: ExecutionPortfolio) =>
    p.settings.symbols.length
      ? (p.settings.symbols.slice(0, P.maxSymbols) as TradingSymbol[])
      : await venue.discover()

  async function flows(op: ExecutionOperation, legs: ExecutionLeg[]): Promise<ExecutionFlow[]> {
    const firstShort = legs.find(
      (leg) =>
        leg.prepared.intent.action === 'short' &&
        leg.receipt &&
        units(leg.receipt.filledQuantity) > 0n,
    )
    if (!firstShort) return []
    const start = firstShort.created_at.getTime()
    const end = now()
    if (!Number.isSafeInteger(start) || end < start || end - start > 12 * week)
      throw new Error('EXECUTION_HISTORY_RANGE')
    const result = new Map<string, ExecutionFlow>()
    for (let cursor = start; cursor <= end; cursor += week) {
      const last = Math.min(end, cursor + week - 1)
      if (mode !== 'paper') {
        for (const event of await venue.fundingHistory(
          op.plan.symbol as TradingSymbol,
          cursor,
          last,
        )) {
          if (result.has(event.id)) throw new Error('EXECUTION_HISTORY_INVALID')
          result.set(event.id, {
            externalId: event.id,
            kind: 'funding',
            amount: decimal(event.amount),
            at: event.at,
          })
        }
      } else {
        for (const event of await venue.fundingRates(
          op.plan.symbol as TradingSymbol,
          cursor,
          last,
        )) {
          const position = totals(legs.filter((leg) => leg.created_at.getTime() <= event.at)).short
          if (!position) continue
          // Paper uses its own entry notional; only private settlement records are real cash.
          const amount = (proceeds(position, units(op.plan.hedgePrice)) * event.rate) / SCALE
          const externalId = `paper:${op.plan.symbol}:${event.at}`
          if (result.has(externalId)) throw new Error('EXECUTION_HISTORY_INVALID')
          result.set(externalId, {
            externalId,
            kind: 'funding',
            amount: decimal(amount),
            at: event.at,
          })
        }
      }
    }
    return [...result.values()].sort(
      (a, b) => a.at - b.at || a.externalId.localeCompare(b.externalId),
    )
  }

  function leg(
    op: ExecutionOperation,
    market: FundingMarket,
    role: string,
    action: 'buy' | 'sell' | 'short' | 'cover',
    qty: bigint,
    owned: bigint,
  ): ExecutionDecision {
    const selected = ['buy', 'sell'].includes(action) ? market.spot : market.perp
    const price = limits(selected)[['buy', 'cover'].includes(action) ? 'buy' : 'sell']
    if (!tradable(qty, price, selected, action === 'cover'))
      return { type: 'attention', reason: 'EXECUTION_RESIDUAL_DUST' }
    const notional = cost(qty, price)
    return {
      type: 'leg',
      role,
      intent: {
        clientId: '',
        venue: venueName,
        action,
        symbol: op.plan.symbol,
        quantity: decimal(qty),
        limitPrice: decimal(price),
        quoteBudget: decimal(
          notional + fee(notional, P.maxFeeBps) * (action === 'short' ? 3n : 1n),
        ),
        positionQuantity: decimal(owned),
        expiresAt: now() + P.intentLifetimeMs,
      },
    }
  }

  return {
    adapter(selectedVenue) {
      if (selectedVenue !== venueName) throw new Error('EXECUTION_VENUE_MISMATCH')
      return execution
    },
    async accounts(p) {
      if (mode === 'paper') return [{ identity: 'bybit-funding:paper:virtual', venue: venueName }]
      const candidates = await symbols(p)
      const account = await venue.account(candidates[0] || 'BTC-USDT')
      if (!p.started_at && account.availableMargin < units(p.capital))
        throw new Error('EXECUTION_INSUFFICIENT_BALANCE')
      if (
        !p.started_at &&
        (account.positions.length ||
          Object.entries(account.balances).some(
            ([coin, balance]) => coin !== 'USDT' && balance.total > 0n,
          ) ||
          (await venue.pending()).length)
      )
        throw new Error('EXECUTION_ACCOUNT_NOT_EMPTY')
      return [{ identity: account.identity, venue: venueName }]
    },
    async plan(p) {
      const budget = min(units(p.cash), (units(p.capital) * BigInt(P.maxOrderShareBps)) / BPS)
      if (budget < units(P.minOrder) * 2n) return null
      for (const symbol of await symbols(p)) {
        let market: FundingMarket
        try {
          market = await venue.market(symbol)
        } catch {
          continue
        }
        if (
          market.fundingRate <= 0n ||
          market.fundingRate * BPS < BigInt(p.settings.minFundingBps) * SCALE
        )
          continue
        const fees =
          mode === 'paper'
            ? { spot: P.maxFeeBps, perp: P.maxFeeBps }
            : (await venue.account(symbol)).feeBps || { spot: P.maxFeeBps, perp: P.maxFeeBps }
        const buy = limits(market.spot).buy,
          sell = limits(market.perp).sell
        let hedge = floorStep(
          (budget * SCALE * BPS) /
            ((buy + sell) * (BPS + 4n * BigInt(Math.max(fees.spot, fees.perp)))),
          market.perp.instrument.lot,
        )
        hedge = min(hedge, market.perpMaxQty)
        const qty = ceilStep(
          ceilDiv(hedge * BPS, BPS - BigInt(fees.spot)),
          market.spot.instrument.lot,
        )
        if (
          qty > market.spotMaxQty ||
          !tradable(hedge, sell, market.perp) ||
          !tradable(qty, buy, market.spot)
        )
          continue
        const spotCost = cost(qty, buy),
          margin = cost(hedge, sell)
        const roundTripFees = fee(spotCost, fees.spot) * 2n + fee(margin, fees.perp) * 2n
        // At 1x leverage the estimated short closing fee uses the 2x bankruptcy price.
        const reserve = spotCost + margin + roundTripFees + fee(margin, fees.perp)
        if (reserve > budget) continue
        const payments = Math.max(
          0,
          Math.floor(
            (now() + p.settings.maxHoldHours * 60 * 60_000 - market.nextFundingAt) /
              (market.fundingIntervalMinutes * 60_000),
          ) + 1,
        )
        const estimatedFunding = (margin * market.fundingRate * BigInt(payments)) / SCALE
        const crossingCost =
          cost(qty, buy) -
          proceeds(qty, limits(market.spot).sell) +
          cost(hedge, limits(market.perp).buy) -
          proceeds(hedge, sell)
        if (estimatedFunding <= roundTripFees + crossingCost + fee(reserve, p.settings.minEdgeBps))
          continue
        return {
          reserve: decimal(reserve),
          plan: {
            symbol,
            quantity: decimal(qty),
            entryPrice: decimal(buy),
            hedgePrice: decimal(sell),
            buyVenue: venueName,
            sellVenue: venueName,
            outcome: 'yes',
            rate: decimal(market.fundingRate),
            nextPaymentAt: market.nextFundingAt,
            intervalMs: market.fundingIntervalMinutes * 60_000,
          },
        }
      }
      return null
    },
    async decide(p, op, legs) {
      if (
        legs.some(
          (item) =>
            item.state !== 'terminal' ||
            !item.receipt ||
            ['unknown', 'pending'].includes(item.receipt.status),
        )
      )
        return { type: 'attention', reason: 'EXECUTION_ORDER_UNKNOWN' }
      const position = totals(legs)
      const market = await venue.market(op.plan.symbol as TradingSymbol)
      let liquidationClose = false
      if (mode !== 'paper') {
        const account = await venue.account(op.plan.symbol as TradingSymbol)
        const spot = account.balances[op.plan.symbol.slice(0, -5)]?.total || 0n
        if (
          account.positions.some((item) => item.symbol !== op.plan.symbol) ||
          account.positions.reduce((total, item) => total + item.qty, 0n) !== position.short ||
          spot !== position.spot
        )
          return { type: 'attention', reason: 'EXECUTION_POSITION_MISMATCH' }
        liquidationClose = account.positions.some(
          (item) =>
            item.liquidationPrice !== null &&
            item.markPrice * BPS >=
              item.liquidationPrice * (BPS - BigInt(P.fundingLiquidationBufferBps)),
        )
      }
      const spotPrice = limits(market.spot).sell,
        coverPrice = limits(market.perp).buy
      const mark =
        position.cash + proceeds(position.spot, spotPrice) - cost(position.short, coverPrice)
      const loss = mark < 0n && -mark * BPS >= units(op.reserve) * BigInt(P.positionLossBps)
      const age = now() - op.created_at.getTime()
      const closing =
        op.status === 'closing' ||
        p.close_requested ||
        liquidationClose ||
        loss ||
        market.fundingRate <= 0n ||
        age >= p.settings.maxHoldHours * 60 * 60_000 ||
        legs.some((item) => item.role.startsWith('close-'))
      if (!legs.length) {
        if (closing) return { type: 'close', pnl: '0', fees: '0' }
        return leg(op, market, 'open-spot', 'buy', units(op.plan.quantity), 0n)
      }
      if (!position.spot && !position.short) {
        const history = await flows(op, legs)
        return {
          type: 'close',
          pnl: decimal(
            position.cash + history.reduce((total, item) => total + units(item.amount), 0n),
          ),
          fees: decimal(position.fees),
          flows: history,
        }
      }
      const repairs = legs.filter((item) => item.role.startsWith('repair-')).length
      if (closing) {
        if (
          legs.filter((item) => item.role === 'close-short').length > P.maxRepairLegs ||
          legs.filter((item) => item.role === 'close-spot').length > P.maxRepairLegs
        )
          return { type: 'attention', reason: 'EXECUTION_REPAIR_LIMIT' }
        const surplus =
          position.spot > position.short
            ? floorStep(position.spot - position.short, market.spot.instrument.lot)
            : 0n
        if (
          surplus &&
          (position.short === 0n || legs.some((item) => item.prepared.intent.action === 'cover')) &&
          tradable(surplus, spotPrice, market.spot)
        )
          return leg(op, market, 'close-spot', 'sell', surplus, position.spot)
        if (position.short > 0n)
          return leg(op, market, 'close-short', 'cover', position.short, position.short)
        return { type: 'attention', reason: 'EXECUTION_RESIDUAL_DUST' }
      }
      if (!position.short && !legs.some((item) => item.prepared.intent.action === 'short')) {
        const hedge = floorStep(position.spot, market.perp.instrument.lot)
        if (tradable(hedge, limits(market.perp).sell, market.perp))
          return leg(op, market, 'open-short', 'short', hedge, position.spot)
        return leg(
          op,
          market,
          'close-spot',
          'sell',
          floorStep(position.spot, market.spot.instrument.lot),
          position.spot,
        )
      }
      if (position.short > position.spot) {
        if (repairs >= P.maxRepairLegs)
          return { type: 'attention', reason: 'EXECUTION_REPAIR_LIMIT' }
        const uncovered = min(
          position.short,
          ceilStep(position.short - position.spot, market.perp.instrument.lot),
        )
        return leg(op, market, 'repair-short', 'cover', uncovered, position.short)
      }
      const unmatched = floorStep(position.spot - position.short, market.spot.instrument.lot)
      if (tradable(unmatched, spotPrice, market.spot)) {
        if (repairs >= P.maxRepairLegs)
          return { type: 'attention', reason: 'EXECUTION_REPAIR_LIMIT' }
        return leg(op, market, 'repair-spot', 'sell', unmatched, position.spot)
      }
      // A sub-lot spot remainder remains in exposure/P&L and is sold with the hedge at close.
      if (!position.short || position.spot - position.short >= market.perp.instrument.lot)
        return leg(op, market, 'close-short', 'cover', position.short, position.short)
      const history = await flows(op, legs)
      const income = history.reduce((total, item) => total + units(item.amount), 0n)
      return {
        type: 'hold',
        pnl: decimal(mark + income),
        fees: decimal(position.fees),
        flows: history,
      }
    },
  }
}
