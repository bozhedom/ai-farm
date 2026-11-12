import { EXECUTION_POLICY as P } from '../../policy'
import { BPS, ceilDiv, cost, decimal, fee, min, units } from '../../trading/decimal'
import type { Market, TradingSymbol } from '../../trading/types'
import { syntheticBook } from '../adapters/paper-markets'
import type {
  ExecutionAdapter,
  ExecutionDecision,
  ExecutionDriver,
  ExecutionIntent,
  ExecutionLeg,
  ExecutionMode,
  ExecutionPortfolio,
  ExecutionReceipt,
  Json,
} from '../types'

export type SwapQuote = { amountIn: bigint; amountOut: bigint; midOut: bigint; feeBps: number; at: number }
export type SwapClient = {
  identity?(): string
  quote(symbol: TradingSymbol, amountIn: bigint): Promise<SwapQuote>
  prepareSwap?(intent: ExecutionIntent, quote: SwapQuote): Promise<{ payload: Record<string, string | number>; externalId: string | null }>
  broadcast?(prepared: import('../types').PreparedExecution): Promise<void>
  market?(symbol: TradingSymbol): Promise<Market>
}

export function createSwapDriver(
  mode: ExecutionMode,
  client?: SwapClient,
  now: () => number = Date.now,
): ExecutionDriver {
  const venue = 'uniswap' as const
  const paperQuote: SwapClient = {
    async quote(symbol, amountIn) {
      const market = syntheticBook(symbol, '1')
      const mid = market.book.bids[0]![0]
      const out = (amountIn * mid) / units('1')
      const slipped = (out * (BPS - BigInt(P.swap.defaultSlippageBps))) / BPS
      return { amountIn, amountOut: slipped, midOut: out, feeBps: P.swap.maxFeeBps, at: now() }
    },
  }
  const source = client || paperQuote
  const paper: ExecutionAdapter = {
    async prepare(intent) {
      const quote = await source.quote(intent.symbol as TradingSymbol, units(intent.quantity))
      if (now() - quote.at > P.quoteMaxAgeMs) throw new Error('EXECUTION_STALE_QUOTE')
      const minOut = (quote.midOut * (BPS - BigInt(P.swap.maxSlippageBps))) / BPS
      if (quote.amountOut < minOut) throw new Error('EXECUTION_SLIPPAGE_EXCEEDED')
      const receipt: ExecutionReceipt = {
        status: 'filled',
        externalId: `paper:${intent.clientId}`,
        filledQuantity: decimal(quote.amountOut),
        grossQuote: decimal(quote.amountIn),
        quoteFee: decimal(fee(quote.amountIn, quote.feeBps)),
        baseFee: '0',
      }
      return { intent, externalId: receipt.externalId, payload: { receipt: receipt as unknown as Json, minOut: decimal(minOut) } }
    },
    async broadcast() {},
    async lookup(prepared) {
      return prepared.payload.receipt as unknown as ExecutionReceipt
    },
  }
  const live: ExecutionAdapter = {
    async prepare(intent) {
      if (!client) throw new Error('EXECUTION_WALLET_REQUIRED')
      const quote = await client.quote(intent.symbol as TradingSymbol, units(intent.quantity))
      if (now() - quote.at > P.quoteMaxAgeMs) throw new Error('EXECUTION_STALE_QUOTE')
      const minOut = (quote.midOut * (BPS - BigInt(P.swap.maxSlippageBps))) / BPS
      if (quote.amountOut < minOut) throw new Error('EXECUTION_SLIPPAGE_EXCEEDED')
      if (!client.prepareSwap) throw new Error('EXECUTION_WALLET_REQUIRED')
      const prepared = await client.prepareSwap(intent, quote)
      return { intent, externalId: prepared.externalId, payload: { ...prepared.payload, minOut: decimal(minOut) } }
    },
    async broadcast(prepared) {
      if (!client?.broadcast) throw new Error(mode === 'live' ? 'EXECUTION_LIVE_DISABLED' : 'EXECUTION_WALLET_REQUIRED')
      await client.broadcast(prepared)
    },
    async lookup() {
      return null
    },
  }
  const execution = mode === 'paper' ? paper : live

  return {
    adapter(selected) {
      if (selected !== venue) throw new Error('EXECUTION_VENUE_MISMATCH')
      return execution
    },
    async accounts(p) {
      if (mode === 'paper') return [{ identity: 'uniswap:paper:virtual', venue }]
      if (!client) throw new Error('EXECUTION_WALLET_REQUIRED')
      return [{ identity: client.identity?.() || 'uniswap', venue }]
    },
    async plan(p) {
      const budget = min(units(p.cash), (units(p.capital) * BigInt(P.maxOrderShareBps)) / BPS)
      if (budget < units(P.minOrder)) return null
      const symbol = (p.settings.symbols[0] || 'USDC-USDT') as TradingSymbol
      const quote = await source.quote(symbol, budget)
      const minOut = (quote.midOut * (BPS - BigInt((p.settings.slippageBps ?? P.swap.defaultSlippageBps)))) / BPS
      if (quote.amountOut < minOut) return null
      return {
        reserve: decimal(budget + fee(budget, quote.feeBps)),
        plan: {
          symbol,
          quantity: decimal(budget),
          entryPrice: '1',
          hedgePrice: decimal(minOut),
          buyVenue: venue,
          sellVenue: venue,
          outcome: 'yes',
          rate: decimal(quote.amountOut),
          nextPaymentAt: 0,
          intervalMs: 0,
        },
      }
    },
    async decide(_p: ExecutionPortfolio, op, legs: ExecutionLeg[]): Promise<ExecutionDecision> {
      if (legs.some((item) => item.state !== 'terminal' || !item.receipt || ['unknown', 'pending'].includes(item.receipt.status)))
        return { type: 'attention', reason: 'EXECUTION_ORDER_UNKNOWN' }
      if (!legs.length) {
        const notional = units(op.plan.quantity)
        return {
          type: 'leg',
          role: 'swap',
          intent: {
            clientId: '',
            venue,
            action: 'swap',
            symbol: op.plan.symbol,
            quantity: op.plan.quantity,
            limitPrice: op.plan.hedgePrice,
            quoteBudget: decimal(notional + fee(notional, P.swap.maxFeeBps)),
            positionQuantity: '0',
            expiresAt: now() + P.intentLifetimeMs,
          },
        }
      }
      const filled = legs.reduce((total, item) => total + units(item.receipt?.filledQuantity || '0'), 0n)
      const spent = legs.reduce((total, item) => total + units(item.receipt?.grossQuote || '0'), 0n)
      const fees = legs.reduce((total, item) => total + units(item.receipt?.quoteFee || '0'), 0n)
      const minOut = units(op.plan.hedgePrice)
      if (filled < minOut) return { type: 'attention', reason: 'EXECUTION_SLIPPAGE_EXCEEDED' }
      return { type: 'close', pnl: decimal(filled - spent), fees: decimal(fees) }
    },
  }
}

/** Kept so slippage math is tested without a hidden default. */
export function minimumOut(midOut: bigint, slippageBps: number) {
  if (slippageBps > P.swap.maxSlippageBps) throw new Error('EXECUTION_SLIPPAGE_FORBIDDEN')
  return (midOut * (BPS - BigInt(slippageBps))) / BPS
}

export function notionalCost(qty: bigint, price: bigint) {
  return cost(qty, price) + fee(cost(qty, price), P.swap.maxFeeBps)
}

export const swapCeilDiv = ceilDiv
