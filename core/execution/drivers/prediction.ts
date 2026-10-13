import { createHash } from 'node:crypto'
import { z } from 'zod'
import { EXECUTION_POLICY as P } from '../../policy'
import { BPS, ceilDiv, decimal, floorStep, min, SCALE, units } from '../../trading/decimal'
import {
  KalshiExecutionAdapter,
  KalshiExecutionVenue,
  type KalshiSettings,
} from '../adapters/kalshi'
import {
  ExecutionRejected,
  type ExecutionAdapter,
  type ExecutionDecision,
  type ExecutionDriver,
  type ExecutionIntent,
  type ExecutionLeg,
  type ExecutionMode,
  type ExecutionOperation,
  type ExecutionPortfolio,
  type ExecutionReceipt,
  type Json,
} from '../types'

type Market = Awaited<ReturnType<KalshiExecutionVenue['market']>>
type Book = Awaited<ReturnType<KalshiExecutionVenue['orderbook']>>
type Quote = { price: bigint; quantity: bigint }
const lot = SCALE / 100n
const tickerPattern = /^[A-Z0-9][A-Z0-9_.:-]{0,199}$/

function ensureFresh(book: Book, now: number) {
  if (book.at > now || now - book.at > P.prediction.maxQuoteAgeMs)
    throw new Error('EXECUTION_PREDICTION_STALE_QUOTE')
}
function prices(book: Book, outcome: 'yes' | 'no', action: 'buy' | 'sell'): Quote[] {
  const same = outcome === 'yes' ? book.yesBids : book.noBids
  const opposite = outcome === 'yes' ? book.noBids : book.yesBids
  return (action === 'buy' ? opposite : same)
    .map((row) => ({
      price: action === 'buy' ? SCALE - units(row.price) : units(row.price),
      quantity: units(row.quantity),
    }))
    .filter((row) => row.price > 0n && row.price < SCALE && row.quantity > 0n)
    .sort((a, b) =>
      a.price === b.price ? 0 : (action === 'buy' ? a.price < b.price : a.price > b.price) ? -1 : 1,
    )
}
function fairPrice(p: ExecutionPortfolio) {
  const probability = p.settings.probabilityBps
  if (!Number.isInteger(probability) || probability < 0 || probability > 10000)
    throw new Error('EXECUTION_PREDICTION_PROBABILITY_INVALID')
  return (BigInt(p.settings.outcome === 'yes' ? probability : 10000 - probability) * SCALE) / BPS
}
function validPrice(market: Market, outcome: 'yes' | 'no', price: bigint) {
  const yes = outcome === 'yes' ? price : SCALE - price
  return market.price_ranges.some(
    (band) =>
      yes >= units(band.start) &&
      yes <= units(band.end) &&
      (yes - units(band.start)) % units(band.step) === 0n,
  )
}
function reservedFee(quantity: bigint) {
  return ceilDiv(quantity * BigInt(P.prediction.feeReserveBps), BPS)
}
/** Conservative Paper fee assumption; live uses the actual per-fill fee_cost. */
function paperFee(quantity: bigint, price: bigint) {
  const microscopic = ceilDiv(
    quantity * price * (SCALE - price) * BigInt(P.predictionFeeBps),
    SCALE * SCALE * BPS,
  )
  // A Direct account aligns balances to 0.0001 USD. Keep any rounding surcharge.
  const alignment = SCALE / 10000n
  return ceilDiv(microscopic, alignment) * alignment
}
function receiptSummary(legs: ExecutionLeg[], op: ExecutionOperation) {
  let bought = 0n,
    sold = 0n,
    spent = 0n,
    received = 0n,
    fees = 0n
  for (const leg of legs) {
    if (!leg.receipt || leg.state !== 'terminal')
      throw new Error('EXECUTION_PREDICTION_UNRESOLVED_LEG')
    const i = leg.prepared.intent,
      r = leg.receipt
    if (
      i.venue !== 'kalshi' ||
      i.symbol !== op.plan.symbol ||
      i.outcome !== op.plan.outcome ||
      !['buy', 'sell'].includes(i.action) ||
      !['filled', 'cancelled', 'rejected'].includes(r.status) ||
      units(r.baseFee) !== 0n
    )
      throw new Error('EXECUTION_PREDICTION_LEG_MISMATCH')
    const quantity = units(r.filledQuantity),
      gross = units(r.grossQuote),
      fee = units(r.quoteFee)
    if (quantity < 0n || gross < 0n || fee < 0n || quantity > units(i.quantity))
      throw new Error('EXECUTION_PREDICTION_LEG_MISMATCH')
    if (i.action === 'buy') {
      bought += quantity
      spent += gross
    } else {
      sold += quantity
      received += gross
    }
    fees += fee
  }
  if (sold > bought) throw new Error('EXECUTION_PREDICTION_POSITION_MISMATCH')
  return {
    bought,
    sold,
    spent,
    received,
    fees,
    owned: bought - sold,
    realized: received - spent - fees,
  }
}

function createPredictionPaperAdapter(
  venue: KalshiExecutionVenue,
  now: () => number,
): ExecutionAdapter {
  const payloadSchema = z.object({
    fingerprint: z.string(),
    expiresAt: z.number().int(),
    receipt: z.object({
      status: z.enum(['filled', 'cancelled']),
      externalId: z.string(),
      filledQuantity: z.string(),
      grossQuote: z.string(),
      quoteFee: z.string(),
      baseFee: z.literal('0'),
    }),
  })
  const fingerprint = (intent: ExecutionIntent) =>
    createHash('sha256').update(JSON.stringify(intent)).digest('hex')
  return {
    async prepare(intent) {
      if (
        intent.venue !== 'kalshi' ||
        !intent.outcome ||
        !['buy', 'sell'].includes(intent.action) ||
        !tickerPattern.test(intent.symbol)
      )
        throw new Error('EXECUTION_PREDICTION_INTENT_INVALID')
      const quantity = units(intent.quantity),
        limit = units(intent.limitPrice)
      if (
        quantity <= 0n ||
        quantity % lot ||
        limit <= 0n ||
        limit >= SCALE ||
        intent.expiresAt <= now()
      )
        throw new Error('EXECUTION_PREDICTION_INTENT_INVALID')
      if (intent.action === 'sell' && quantity > units(intent.positionQuantity))
        throw new Error('EXECUTION_PREDICTION_POSITION_MISMATCH')
      const [market, book] = await Promise.all([
        venue.market(intent.symbol),
        venue.orderbook(intent.symbol),
      ])
      ensureFresh(book, now())
      if (
        market.status !== 'active' ||
        Date.parse(market.open_time) > now() ||
        Date.parse(market.close_time) <= now() + P.prediction.maxQuoteAgeMs
      )
        throw new Error('EXECUTION_PREDICTION_MARKET_CLOSED')
      if (!validPrice(market, intent.outcome, limit))
        throw new Error('EXECUTION_PREDICTION_OFF_GRID_PRICE')
      let remaining = quantity,
        gross = 0n,
        fees = 0n
      for (const row of prices(book, intent.outcome, intent.action as 'buy' | 'sell')) {
        if (intent.action === 'buy' ? row.price > limit : row.price < limit) break
        const matched = min(remaining, row.quantity)
        gross += (matched * row.price) / SCALE
        fees += paperFee(matched, row.price)
        remaining -= matched
        if (!remaining) break
      }
      if ((intent.action === 'buy' ? gross : 0n) + fees > units(intent.quoteBudget))
        throw new Error('EXECUTION_PREDICTION_BUDGET_EXCEEDED')
      const receipt: ExecutionReceipt = {
        status: remaining ? 'cancelled' : 'filled',
        externalId: `paper:${intent.clientId}`,
        filledQuantity: decimal(quantity - remaining),
        grossQuote: decimal(gross),
        quoteFee: decimal(fees),
        baseFee: '0',
      }
      return {
        intent: { ...intent },
        externalId: receipt.externalId,
        payload: {
          fingerprint: fingerprint(intent),
          expiresAt: Math.min(intent.expiresAt, book.at + P.prediction.maxQuoteAgeMs),
          receipt: receipt as unknown as Json,
        },
      }
    },
    async broadcast(prepared) {
      const payload = payloadSchema.parse(prepared.payload)
      if (payload.fingerprint !== fingerprint(prepared.intent))
        throw new ExecutionRejected('EXECUTION_PREDICTION_PREPARED_MISMATCH')
      if (payload.expiresAt <= now())
        throw new ExecutionRejected('EXECUTION_PREDICTION_STALE_QUOTE')
    },
    async lookup(prepared) {
      const payload = payloadSchema.parse(prepared.payload)
      if (payload.fingerprint !== fingerprint(prepared.intent))
        throw new Error('EXECUTION_PREDICTION_PREPARED_MISMATCH')
      return payload.receipt
    },
  }
}

/** Owner probabilities are assumptions, not facts or values inferred by a language model. */
export function createPredictionDriver(
  mode: ExecutionMode,
  settings: KalshiSettings | null,
  dependencies: { transport?: typeof fetch; now?: () => number } = {},
): ExecutionDriver {
  const now = dependencies.now || Date.now
  if (mode !== 'paper' && (!settings || settings.mode !== mode))
    throw new Error('EXECUTION_KALSHI_CREDENTIALS_REQUIRED')
  const publicSettings: KalshiSettings = settings || {
    mode: 'live',
    keyId: '',
    privateKey: '',
    accountId: '',
    liveEnabled: false,
    eligibilityConfirmed: false,
    subaccount: 0,
    maxQuoteAgeMs: P.prediction.maxQuoteAgeMs,
    requestTimeoutMs: P.prediction.requestTimeoutMs,
    maxPages: P.prediction.maxPages,
  }
  const venue = new KalshiExecutionVenue(publicSettings, dependencies.transport, now)
  const adapter =
    mode === 'paper'
      ? createPredictionPaperAdapter(venue, now)
      : new KalshiExecutionAdapter(publicSettings, dependencies.transport, now)
  const makeIntent = (
    op: ExecutionOperation,
    action: 'buy' | 'sell',
    quantity: bigint,
    price: bigint,
  ): ExecutionIntent => ({
    clientId: '',
    venue: 'kalshi',
    action,
    symbol: op.plan.symbol,
    quantity: decimal(quantity),
    limitPrice: decimal(price),
    quoteBudget: action === 'buy' ? op.reserve : decimal(reservedFee(quantity)),
    positionQuantity: action === 'sell' ? decimal(quantity) : '0',
    outcome: op.plan.outcome,
    expiresAt: now() + P.prediction.maxQuoteAgeMs,
  })
  return {
    adapter(selected) {
      if (selected !== 'kalshi') throw new Error('EXECUTION_PREDICTION_VENUE_INVALID')
      return adapter
    },
    async accounts(p) {
      if (p.track !== 'prediction' || p.mode !== mode)
        throw new Error('EXECUTION_PREDICTION_SCOPE_MISMATCH')
      if (mode === 'paper') return [{ identity: 'kalshi:paper:virtual', venue: 'kalshi' }]
      const [account, positions, orders] = await Promise.all([
        venue.account(),
        venue.allPositions(),
        venue.restingOrders(),
      ])
      if (!p.started_at && units(account.balance) < units(p.capital))
        throw new Error('EXECUTION_KALSHI_INSUFFICIENT_BALANCE')
      if (
        (!p.started_at && positions.some((position) => units(position.signedQuantity))) ||
        positions.some(
          (position) =>
            units(position.signedQuantity) && position.ticker !== p.settings.predictionTicker,
        ) ||
        orders.length
      )
        throw new Error('EXECUTION_KALSHI_ACCOUNT_NOT_EMPTY')
      return [{ identity: account.identity, venue: 'kalshi' }]
    },
    async plan(p) {
      if (p.close_requested || !tickerPattern.test(p.settings.predictionTicker)) return null
      if (
        !Number.isInteger(p.settings.minEdgeBps) ||
        p.settings.minEdgeBps < 0 ||
        p.settings.minEdgeBps > 10000
      )
        throw new Error('EXECUTION_PREDICTION_EDGE_INVALID')
      const fair = fairPrice(p)
      const [market, book] = await Promise.all([
        venue.market(p.settings.predictionTicker),
        venue.orderbook(p.settings.predictionTicker),
      ])
      ensureFresh(book, now())
      if (
        market.status !== 'active' ||
        Date.parse(market.open_time) > now() ||
        Date.parse(market.close_time) <= now() + P.prediction.closeBeforeMs
      )
        return null
      const ask = prices(book, p.settings.outcome, 'buy')[0]
      if (!ask || !validPrice(market, p.settings.outcome, ask.price)) return null
      const feePerContract = reservedFee(SCALE)
      if (fair - ask.price - feePerContract < (BigInt(p.settings.minEdgeBps) * SCALE) / BPS)
        return null
      const budget = min(
        units(p.cash),
        (units(p.capital) * BigInt(P.prediction.maxAllocationBps)) / BPS,
      )
      const quantity = floorStep(
        min((budget * SCALE) / (ask.price + feePerContract), ask.quantity),
        lot,
      )
      const reserve = (quantity * ask.price) / SCALE + reservedFee(quantity)
      if (quantity <= 0n || reserve < units(P.prediction.minOrder)) return null
      return {
        plan: {
          symbol: p.settings.predictionTicker,
          quantity: decimal(quantity),
          entryPrice: decimal(ask.price),
          hedgePrice: '0',
          buyVenue: 'kalshi',
          sellVenue: 'kalshi',
          outcome: p.settings.outcome,
          rate: decimal(fair),
          nextPaymentAt: Date.parse(market.close_time),
          intervalMs: 0,
        },
        reserve: decimal(reserve),
      }
    },
    async decide(p, op, legs): Promise<ExecutionDecision> {
      if (
        op.track !== 'prediction' ||
        op.mode !== mode ||
        p.mode !== mode ||
        op.plan.buyVenue !== 'kalshi'
      )
        return { type: 'attention', reason: 'EXECUTION_PREDICTION_SCOPE_MISMATCH' }
      if (!legs.length) {
        if (p.close_requested) return { type: 'close', pnl: '0', fees: '0' }
        return {
          type: 'leg',
          role: 'prediction-open',
          intent: makeIntent(op, 'buy', units(op.plan.quantity), units(op.plan.entryPrice)),
        }
      }
      const summary = receiptSummary(legs, op)
      const fees = decimal(summary.fees)
      if (summary.owned === 0n) return { type: 'close', pnl: decimal(summary.realized), fees }
      const market = await venue.market(op.plan.symbol)
      if (market.status !== 'active') {
        if (
          mode === 'paper' &&
          market.status === 'finalized' &&
          market.settlement_value_dollars != null
        ) {
          const yes = units(market.settlement_value_dollars)
          if (yes < 0n || yes > SCALE)
            return { type: 'attention', reason: 'EXECUTION_KALSHI_SETTLEMENT_MISMATCH' }
          const payout = (summary.owned * (op.plan.outcome === 'yes' ? yes : SCALE - yes)) / SCALE
          return {
            type: 'close',
            pnl: decimal(summary.realized + payout),
            fees,
            flows: [
              {
                externalId: `paper:kalshi:${op.id}:settlement`,
                kind: 'settlement',
                amount: decimal(payout),
                at: now(),
              },
            ],
          }
        }
        if (mode !== 'paper') {
          const settlement = await venue.settledPosition({
            ticker: op.plan.symbol,
            outcome: op.plan.outcome,
            quantity: decimal(summary.owned),
            openedAt: op.created_at.getTime(),
          })
          if (settlement)
            return {
              type: 'close',
              pnl: decimal(summary.realized + units(settlement.revenue)),
              fees,
              flows: [
                {
                  externalId: settlement.id,
                  kind: 'settlement',
                  amount: settlement.revenue,
                  at: Date.parse(settlement.settledAt),
                },
              ],
            }
        }
        // Closed/disputed contracts have no executable quote. Keep the remaining
        // holding at its entry cost until an actual settlement record arrives.
        const remainingCost = (summary.spent * summary.owned) / summary.bought
        return { type: 'hold', pnl: decimal(summary.realized + remainingCost), fees }
      }
      if (mode !== 'paper') {
        const positions = await venue.positions(op.plan.symbol)
        const signed = positions.reduce((sum, position) => sum + units(position.signedQuantity), 0n)
        if (signed !== (op.plan.outcome === 'yes' ? summary.owned : -summary.owned))
          return { type: 'attention', reason: 'EXECUTION_PREDICTION_POSITION_MISMATCH' }
      }
      const book = await venue.orderbook(op.plan.symbol)
      ensureFresh(book, now())
      const bids = prices(book, op.plan.outcome, 'sell')
      const bid = bids[0]
      const mark = bid ? (summary.owned * bid.price) / SCALE : 0n
      const pnl = summary.realized + mark
      const entryCost = (summary.spent * summary.owned) / summary.bought
      const stop = mark * BPS <= entryCost * (BPS - BigInt(P.prediction.maxLossBps))
      const maxHold =
        !Number.isFinite(p.settings.maxHoldHours) || p.settings.maxHoldHours <= 0
          ? 24
          : p.settings.maxHoldHours
      const expired = now() - op.created_at.getTime() >= maxHold * 60 * 60_000
      const fair = units(op.plan.rate)
      const shouldSell =
        p.close_requested ||
        stop ||
        expired ||
        Date.parse(market.close_time) - now() <= P.prediction.closeBeforeMs ||
        (bid && bid.price >= fair)
      if (shouldSell && bid) {
        const quantity = floorStep(min(summary.owned, bid.quantity), lot)
        if (quantity > 0n)
          return {
            type: 'leg',
            role: 'prediction-close',
            intent: makeIntent(op, 'sell', quantity, bid.price),
          }
      }
      return { type: 'hold', pnl: decimal(pnl), fees }
    },
  }
}
