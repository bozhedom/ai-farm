import { TRADING_POLICY as P } from '../policy'
import { BPS, SCALE, abs, cost, fee, floorStep, max, min, proceeds } from './decimal'
import type { AgentRow, Book, OrderRequest, OrderResult } from './types'

/** Conservative paper execution: walk current depth, then add adverse slippage and a fee. */
export function paperFill(order: OrderRequest, book: Book, lot: bigint): OrderResult {
  let remaining = order.qty,
    quote = 0n
  for (const [rawPrice, available] of order.side === 'buy' ? book.asks : book.bids) {
    if (order.side === 'buy' ? rawPrice > order.price : rawPrice < order.price) break
    const price =
      order.side === 'buy'
        ? min(order.price, rawPrice + fee(rawPrice, P.slippageBps))
        : max(order.price, rawPrice - fee(rawPrice, P.slippageBps))
    const filled = floorStep(min(remaining, available), lot)
    quote += order.side === 'buy' ? cost(filled, price) : proceeds(filled, price)
    remaining -= filled
    if (!remaining) break
  }
  return {
    ...order,
    exchangeId: `paper-${order.clientId}`,
    state: remaining ? 'canceled' : 'filled',
    filledQty: order.qty - remaining,
    quote,
    baseFee: 0n,
    quoteFee: -fee(quote, P.paperFeeBps),
  }
}

/** Exchange fees are signed: negative is charged; positive is a rebate. */
export function applyFill(agent: AgentRow, result: OrderResult, minQty: bigint) {
  const { filledQty, quote, baseFee, quoteFee, side, qty, price } = result
  if (
    filledQty < 0n ||
    filledQty > qty ||
    quote < 0n ||
    (!filledQty && (quote || baseFee || quoteFee))
  )
    throw new Error('TRADING_FILL_INVALID')
  if (
    filledQty &&
    (quote === 0n ||
      (side === 'buy'
        ? quote > cost(filledQty, price) + 1n
        : quote + 1n < proceeds(filledQty, price)))
  )
    throw new Error('TRADING_FILL_OUTSIDE_LIMIT')
  // Unexpected fees are not silently dropped from P&L or borrowed from another agent.
  if (abs(baseFee) > fee(filledQty, P.maxFeeBps) || abs(quoteFee) > fee(quote, P.maxFeeBps))
    throw new Error('TRADING_FEE_TOO_HIGH')
  let cash = BigInt(agent.cash),
    base = BigInt(agent.base),
    basis = BigInt(agent.basis)
  let realized = BigInt(agent.realized),
    roundTrips = agent.round_trips
  const feeValue = -quoteFee - (filledQty ? (baseFee * quote) / filledQty : 0n)
  if (feeValue > fee(quote, P.maxFeeBps)) throw new Error('TRADING_FEE_TOO_HIGH')
  if (side === 'buy') {
    cash -= quote - quoteFee
    base += filledQty + baseFee
    basis += quote - quoteFee
  } else if (filledQty) {
    const removed = filledQty - baseFee
    if (removed > base) throw new Error('TRADING_BALANCE_NEGATIVE')
    const releasedBasis = removed === base ? basis : (basis * removed) / base
    cash += quote + quoteFee
    base -= removed
    basis -= releasedBasis
    realized += quote + quoteFee - releasedBasis
    if (BigInt(agent.base) >= minQty && base < minQty) roundTrips += 1
  }
  if (cash < 0n || base < 0n || basis < 0n) throw new Error('TRADING_BALANCE_NEGATIVE')
  return { cash, base, basis, realized, roundTrips, fees: BigInt(agent.fees) + feeValue }
}

export function riskReason(equity: bigint, peak: bigint, dayEquity: bigint) {
  if (equity * BPS <= peak * (BPS - BigInt(P.drawdownBps))) return 'DRAWDOWN_LIMIT'
  if (equity * BPS <= dayEquity * (BPS - BigInt(P.dailyLossBps))) return 'DAILY_LOSS_LIMIT'
  return ''
}

export function markAgent(agent: AgentRow, bid: bigint) {
  const value = proceeds(BigInt(agent.base), bid)
  // Reserve an exit commission in the marked equity, including still-held positions.
  const exposure = max(0n, value - fee(value, P.maxFeeBps))
  return { equity: BigInt(agent.cash) + exposure, exposure }
}
