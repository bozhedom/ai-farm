import { EXECUTION_POLICY as P } from '../../policy'
import { cost, decimal, fee, min, units } from '../../trading/decimal'
import type { Market } from '../../trading/types'
import type { ExecutionAdapter, ExecutionIntent, ExecutionReceipt, Json } from '../types'

/** A persisted book snapshot makes a virtual IOC reproducible across process restarts. */
export function createPaperAdapter(
  getMarket: (intent: ExecutionIntent) => Promise<Market>,
  feeBps: number = P.maxFeeBps,
): ExecutionAdapter {
  return {
    async prepare(intent) {
      const { book, instrument } = await getMarket(intent)
      if (Date.now() - book.at > P.quoteMaxAgeMs || book.at > Date.now() + 2000)
        throw new Error('EXECUTION_STALE_QUOTE')
      const qty = units(intent.quantity),
        price = units(intent.limitPrice)
      if (qty <= 0n || price <= 0n || qty % instrument.lot || qty < instrument.minQty)
        throw new Error('EXECUTION_ORDER_SIZE')
      const buy = ['buy', 'cover'].includes(intent.action)
      let remaining = qty,
        gross = 0n
      for (const [p, q] of buy ? book.asks : book.bids) {
        if (buy ? p > price : p < price) break
        const fill = min(remaining, q)
        gross += cost(fill, p)
        remaining -= fill
        if (remaining === 0n) break
      }
      const charged = fee(gross, feeBps)
      if (buy && gross + charged > units(intent.quoteBudget))
        throw new Error('EXECUTION_BUDGET_EXCEEDED')
      const receipt: ExecutionReceipt = {
        status: remaining ? 'cancelled' : 'filled',
        externalId: `paper:${intent.clientId}`,
        filledQuantity: decimal(qty - remaining),
        grossQuote: decimal(gross),
        quoteFee: decimal(charged),
        baseFee: '0',
      }
      return {
        intent,
        externalId: receipt.externalId,
        payload: { receipt: receipt as unknown as Json },
      }
    },
    async broadcast() {},
    async lookup(prepared) {
      return prepared.payload.receipt as unknown as ExecutionReceipt
    },
  }
}
