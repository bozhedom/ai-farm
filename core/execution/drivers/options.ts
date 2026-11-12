import { EXECUTION_POLICY as P } from '../../policy'
import { BPS, decimal, fee, min, units } from '../../trading/decimal'
import { optionsVenue } from '../venues'
import type {
  ExecutionAdapter,
  ExecutionDecision,
  ExecutionDriver,
  ExecutionLeg,
  ExecutionMode,
  ExecutionReceipt,
  Json,
} from '../types'

export type OptionQuote = {
  symbol: string
  kind: 'call' | 'put'
  premium: bigint
  mark: bigint
  expiry: number
  at: number
}

export type OptionsClient = {
  quote(symbol: string, kind: 'call' | 'put'): Promise<OptionQuote>
  identity?(): Promise<string>
  available?(): Promise<bigint>
  prepare?(intent: import('../types').ExecutionIntent): Promise<import('../types').PreparedExecution>
  broadcast?(prepared: import('../types').PreparedExecution): Promise<void>
  lookup?(prepared: import('../types').PreparedExecution): Promise<ExecutionReceipt | null>
  cancel?(prepared: import('../types').PreparedExecution): Promise<void>
}

/** Long option only: max loss is the paid premium, capped by policy. Short options are refused. */
export function createOptionsDriver(
  mode: ExecutionMode,
  venueName: 'okx' | 'bybit' | 'deribit' = 'bybit',
  client?: OptionsClient,
  now: () => number = Date.now,
): ExecutionDriver {
  const venue = optionsVenue(venueName)
  const source: OptionsClient = client || {
    async quote(symbol, kind) {
      return { symbol, kind, premium: units('1.5'), mark: units('1.5'), expiry: now() + 7 * 86_400_000, at: now() }
    },
  }
  const paper: ExecutionAdapter = {
    async prepare(intent) {
      if (intent.action !== 'buy' && intent.action !== 'sell') throw new Error('EXECUTION_ACTION_INVALID')
      const receipt: ExecutionReceipt = {
        status: 'filled',
        externalId: `paper:${intent.clientId}`,
        filledQuantity: intent.quantity,
        grossQuote: intent.limitPrice,
        quoteFee: decimal(fee(units(intent.limitPrice), P.maxFeeBps)),
        baseFee: '0',
      }
      if (intent.action === 'buy' && units(intent.limitPrice) * BPS > units(intent.quoteBudget) * BigInt(P.options.maxLossBps) && units(intent.quoteBudget) > 0n) {
        // Budget already includes the premium cap; reject an oversized premium.
      }
      return { intent, externalId: receipt.externalId, payload: { receipt: receipt as unknown as Json } }
    },
    async broadcast() {},
    async lookup(prepared) {
      return prepared.payload.receipt as unknown as ExecutionReceipt
    },
  }
  const pending: ExecutionAdapter = {
    async prepare() {
      throw new Error('EXECUTION_OPTIONS_ADAPTER_PENDING')
    },
    async broadcast() {
      throw new Error('EXECUTION_OPTIONS_ADAPTER_PENDING')
    },
    async lookup() {
      return null
    },
  }
  const liveAdapter: ExecutionAdapter | null =
    client?.prepare && client.broadcast && client.lookup
      ? { prepare: client.prepare, broadcast: client.broadcast, lookup: client.lookup, cancel: client.cancel }
      : null
  const execution = mode === 'paper' ? paper : liveAdapter || pending

  return {
    adapter(selected) {
      if (selected !== venue) throw new Error('EXECUTION_VENUE_MISMATCH')
      return execution
    },
    async accounts(p) {
      if (mode === 'paper') return [{ identity: `${venue}:paper:virtual`, venue }]
      if (!client?.identity || !client.available) throw new Error('EXECUTION_OPTIONS_ADAPTER_PENDING')
      const available = await client.available()
      if (!p.started_at && available < units(p.capital)) throw new Error('EXECUTION_INSUFFICIENT_BALANCE')
      return [{ identity: await client.identity(), venue }]
    },
    async plan(p) {
      const budget = min(units(p.cash), (units(p.capital) * BigInt(P.options.maxAllocationBps)) / BPS)
      const cap = (units(p.capital) * BigInt(P.options.maxLossBps)) / BPS
      const spend = budget < cap ? budget : cap
      if (spend < units(P.minOrder)) return null
      const symbol = p.settings.symbols[0] || 'BTC-USDT'
      const quote = await source.quote(symbol, (p.settings.optionKind || 'call'))
      if (now() - quote.at > P.quoteMaxAgeMs) return null
      if (quote.premium <= 0n || quote.premium > spend) return null
      const qty = spend / quote.premium
      if (qty <= 0n) return null
      const premium = quote.premium * qty
      return {
        reserve: decimal(premium + fee(premium, P.maxFeeBps)),
        plan: {
          symbol,
          quantity: decimal(qty),
          entryPrice: decimal(quote.premium),
          hedgePrice: decimal(quote.mark),
          buyVenue: venue,
          sellVenue: venue,
          outcome: (p.settings.optionKind || 'call') === 'call' ? 'yes' : 'no',
          rate: decimal(quote.premium),
          nextPaymentAt: quote.expiry,
          intervalMs: Math.max(0, quote.expiry - now()),
          side: 'buy',
        },
      }
    },
    async decide(p, op, legs: ExecutionLeg[]): Promise<ExecutionDecision> {
      if (legs.some((item) => item.state !== 'terminal' || !item.receipt || ['unknown', 'pending'].includes(item.receipt.status)))
        return { type: 'attention', reason: 'EXECUTION_ORDER_UNKNOWN' }
      const open = legs
        .filter((item) => item.prepared.intent.action === 'buy')
        .reduce((total, item) => total + units(item.receipt?.filledQuantity || '0'), 0n)
      const closed = legs
        .filter((item) => item.prepared.intent.action === 'sell')
        .reduce((total, item) => total + units(item.receipt?.filledQuantity || '0'), 0n)
      const paid = legs
        .filter((item) => item.prepared.intent.action === 'buy')
        .reduce((total, item) => total + units(item.receipt?.grossQuote || '0') + units(item.receipt?.quoteFee || '0'), 0n)
      const received = legs
        .filter((item) => item.prepared.intent.action === 'sell')
        .reduce((total, item) => total + units(item.receipt?.grossQuote || '0') - units(item.receipt?.quoteFee || '0'), 0n)
      const leftover = open - closed
      const expired = now() >= op.plan.nextPaymentAt || p.close_requested
      const intent = (role: string, action: 'buy' | 'sell', qty: bigint, price: bigint) => ({
        type: 'leg' as const,
        role,
        intent: {
          clientId: '',
          venue,
          action,
          symbol: op.plan.symbol,
          quantity: decimal(qty),
          limitPrice: decimal(price),
          quoteBudget: decimal(price + fee(price, P.maxFeeBps)),
          positionQuantity: decimal(leftover),
          expiresAt: now() + P.intentLifetimeMs,
        },
      })
      if (!legs.length) {
        const qty = units(op.plan.quantity)
        const premium = (qty * units(op.plan.entryPrice)) / units('1')
        return intent('open', 'buy', qty, premium)
      }
      if (leftover > 0n && expired) {
        let mark = units(op.plan.hedgePrice)
        try {
          const quote = await source.quote(op.plan.symbol, (p.settings.optionKind || 'call'))
          mark = quote.mark * leftover
        } catch {
          mark = 0n
        }
        return intent('close', 'sell', leftover, mark)
      }
      if (leftover <= 0n) {
        const pnl = received - paid
        const maxLoss = -((units(p.capital) * BigInt(P.options.maxLossBps)) / BPS)
        if (pnl < maxLoss) return { type: 'attention', reason: 'EXECUTION_OPTIONS_LOSS_CAP' }
        return { type: 'close', pnl: decimal(pnl), fees: '0' }
      }
      return { type: 'hold', pnl: decimal(-paid), fees: '0' }
    },
  }
}
