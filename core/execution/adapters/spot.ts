import { createHash } from 'node:crypto'
import { OkxVenue } from '../../trading/okx'
import { BybitVenue } from '../../trading/bybit'
import { BinanceVenue } from '../../trading/binance'
import { BitgetVenue } from '../../trading/bitget'
import { OrderRejected } from '../../trading/wire'
import { assertSymbol, baseAsset } from '../../trading/universe'
import { cost, decimal, fee, units } from '../../trading/decimal'
import type { TradingExchange, OrderRequest, TradingVenue } from '../../trading/types'
import { executionSecret, executionWritesAllowed, spotAccess } from '../config'
import {
  ExecutionRejected,
  type ExecutionAdapter,
  type ExecutionMode,
  type PreparedExecution,
} from '../types'
import { EXECUTION_POLICY as P } from '../../policy'

export function executionSpotVenue(exchange: TradingExchange, mode: ExecutionMode): TradingVenue {
  const access = mode === 'paper' ? undefined : spotAccess(exchange, mode)
  switch (exchange) {
    case 'okx':
      return new OkxVenue(mode, fetch, access)
    case 'bybit':
      return new BybitVenue(mode, fetch, access)
    case 'binance':
      return new BinanceVenue(mode, fetch, access)
    case 'bitget':
      return new BitgetVenue(mode, fetch, access)
  }
}
function request(p: PreparedExecution): OrderRequest {
  const i = p.intent
  assertSymbol(i.symbol)
  if (!['buy', 'sell'].includes(i.action)) throw new Error('EXECUTION_ACTION_FORBIDDEN')
  return {
    clientId: i.clientId,
    symbol: i.symbol,
    side: i.action as 'buy' | 'sell',
    qty: units(i.quantity),
    price: units(i.limitPrice),
  }
}
export function createSpotAdapter(
  venue: TradingVenue,
  exchange: TradingExchange,
  mode: ExecutionMode,
): ExecutionAdapter {
  const scope = createHash('sha256')
    .update(
      `${exchange}:${mode}:${executionSecret(`ARBITRAGE_${exchange.toUpperCase()}_${mode.toUpperCase()}_API_KEY`)}`,
    )
    .digest('hex')
  const verified = new Set<string>()
  async function binding(prepared: PreparedExecution) {
    if (
      prepared.intent.venue !== exchange ||
      prepared.payload.mode !== mode ||
      prepared.payload.exchange !== exchange ||
      prepared.payload.scope !== scope ||
      typeof prepared.payload.accountIdentity !== 'string'
    )
      throw new Error('EXECUTION_ACCOUNT_CHANGED')
    if (!verified.has(prepared.intent.clientId)) {
      const account = await venue.account([request(prepared).symbol])
      if (account.identity !== prepared.payload.accountIdentity)
        throw new Error('EXECUTION_ACCOUNT_CHANGED')
      verified.add(prepared.intent.clientId)
    }
  }
  return {
    async prepare(intent) {
      executionWritesAllowed(mode, 'arbitrage')
      if (intent.venue !== exchange || Date.now() >= intent.expiresAt)
        throw new Error('EXECUTION_INTENT_EXPIRED')
      const prepared: PreparedExecution = {
        intent,
        payload: { mode, exchange, scope },
        externalId: null,
      }
      const order = request(prepared)
      const [market, account, pending] = await Promise.all([
        venue.market(order.symbol),
        venue.account([order.symbol]),
        venue.pending(),
      ])
      const ins = market.instrument,
        q = order.qty,
        spend = cost(q, order.price),
        rate = account.feeBps[order.symbol]
      if (pending.length) throw new Error('EXECUTION_FOREIGN_ORDER')
      if (Date.now() - market.book.at > P.quoteMaxAgeMs || market.book.at > Date.now() + 2000)
        throw new Error('EXECUTION_STALE_QUOTE')
      if (
        q <= 0n ||
        order.price <= 0n ||
        q % ins.lot ||
        order.price % ins.tick ||
        q < ins.minQty ||
        spend < (ins.minNotional || units(P.minOrder))
      )
        throw new Error('EXECUTION_ORDER_SIZE')
      if (rate === undefined || !Number.isSafeInteger(rate) || rate < 0 || rate > P.maxFeeBps)
        throw new Error('EXECUTION_FEE_UNKNOWN')
      if (
        order.side === 'buy' &&
        (spend + fee(spend, rate) > units(intent.quoteBudget) ||
          spend + fee(spend, rate) > account.balances.USDT.available)
      )
        throw new Error('EXECUTION_BUDGET_EXCEEDED')
      if (
        order.side === 'sell' &&
        (q > units(intent.positionQuantity) ||
          q > (account.balances[baseAsset(order.symbol)]?.available || 0n))
      )
        throw new Error('EXECUTION_INVENTORY_REQUIRED')
      if (Date.now() >= intent.expiresAt) throw new Error('EXECUTION_INTENT_EXPIRED')
      prepared.payload.accountIdentity = account.identity
      verified.add(intent.clientId)
      return prepared
    },
    async broadcast(prepared) {
      try {
        executionWritesAllowed(mode, 'arbitrage')
      } catch {
        throw new ExecutionRejected('EXECUTION_WRITE_DISABLED')
      }
      if (
        prepared.payload.mode !== mode ||
        prepared.payload.exchange !== exchange ||
        Date.now() >= prepared.intent.expiresAt
      )
        throw new ExecutionRejected('EXECUTION_INTENT_EXPIRED')
      await binding(prepared)
      if (Date.now() >= prepared.intent.expiresAt)
        throw new ExecutionRejected('EXECUTION_INTENT_EXPIRED')
      try {
        await venue.place(request(prepared))
      } catch (e) {
        if (e instanceof OrderRejected) throw new ExecutionRejected('EXECUTION_ORDER_REJECTED')
        throw e
      }
    },
    async lookup(prepared) {
      await binding(prepared)
      const r = await venue.order(request(prepared))
      const terminal = r && ['filled', 'canceled'].includes(r.state)
      return r
        ? {
            status:
              r.state === 'filled' ? 'filled' : r.state === 'canceled' ? 'cancelled' : 'pending',
            externalId: r.exchangeId,
            filledQuantity: terminal ? decimal(r.filledQty) : '0',
            grossQuote: terminal ? decimal(r.quote) : '0',
            baseFee: terminal ? decimal(-r.baseFee) : '0',
            quoteFee: terminal ? decimal(-r.quoteFee) : '0',
          }
        : null
    },
    async cancel(prepared) {
      executionWritesAllowed(mode, 'arbitrage')
      await binding(prepared)
      await venue.cancel(request(prepared))
    },
  }
}
