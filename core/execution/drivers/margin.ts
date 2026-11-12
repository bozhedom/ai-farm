import { EXECUTION_POLICY as P } from '../../policy'
import { BPS, ceilDiv, ceilStep, cost, decimal, fee, floorStep, min, proceeds, SCALE, units } from '../../trading/decimal'
import type { Market, TradingSymbol } from '../../trading/types'
import { estimatedLiquidation, syntheticBook } from '../adapters/paper-markets'
import { createPaperAdapter } from '../adapters/paper'
import { marginVenue } from '../venues'
import type {
  ExecutionAdapter,
  ExecutionDecision,
  ExecutionDriver,
  ExecutionExchange,
  ExecutionFlow,
  ExecutionMode,
  ExecutionOperation,
  ExecutionPortfolio,
  ExecutionLeg,
} from '../types'

export type MarginClient = {
  market(symbol: TradingSymbol): Promise<Market>
  discover(): Promise<TradingSymbol[]>
  account(symbol: TradingSymbol): Promise<{
    identity: string
    available: bigint
    debt: bigint
    positions: { symbol: TradingSymbol; qty: bigint; entry: bigint; mark: bigint; liquidation: bigint | null; leverage: number }[]
  }>
  pending(): Promise<{ clientId: string }[]>
} & ExecutionAdapter

export function createMarginDriver(
  mode: ExecutionMode,
  exchange: ExecutionExchange,
  client?: MarginClient,
  now: () => number = Date.now,
): ExecutionDriver {
  const venue = marginVenue(exchange)
  const raw: MarginClient = client || {
    async market(symbol) {
      return syntheticBook(symbol, '100')
    },
    async discover() {
      return ['BTC-USDT']
    },
    async account() {
      return { identity: `${venue}:${mode}:paper`, available: units('100'), debt: 0n, positions: [] }
    },
    async pending() {
      return []
    },
    async prepare() {
      throw new Error('EXECUTION_ADAPTER_REQUIRED')
    },
    async broadcast() {},
    async lookup() {
      return null
    },
  }
  const execution: ExecutionAdapter =
    mode === 'paper' ? createPaperAdapter((intent) => raw.market(intent.symbol as TradingSymbol)) : raw

  function interest(op: ExecutionOperation, borrowed: bigint): ExecutionFlow[] {
    if (borrowed <= 0n) return []
    const days = Math.max(1, Math.ceil((now() - op.created_at.getTime()) / 86_400_000))
    const amount = (borrowed * BigInt(P.margin.paperInterestBpsPerDay) * BigInt(days)) / BPS
    if (mode !== 'paper' || amount <= 0n) return []
    return [{ externalId: `paper-interest:${op.id}:${days}`, kind: 'interest', amount: decimal(amount), at: now() }]
  }

  return {
    adapter(selected) {
      if (selected !== venue) throw new Error('EXECUTION_VENUE_MISMATCH')
      return execution
    },
    async accounts(p) {
      if (mode === 'paper') return [{ identity: `${venue}:paper:virtual`, venue }]
      const account = await raw.account((p.settings.symbols[0] || 'BTC-USDT') as TradingSymbol)
      if (!p.started_at && (account.debt || account.positions.length || (await raw.pending()).length))
        throw new Error('EXECUTION_ACCOUNT_NOT_EMPTY')
      if (!p.started_at && account.available < units(p.capital))
        throw new Error('EXECUTION_INSUFFICIENT_BALANCE')
      if (account.positions.some((item) => item.leverage > P.margin.maxLeverage))
        throw new Error('EXECUTION_LEVERAGE_FORBIDDEN')
      return [{ identity: account.identity, venue }]
    },
    async plan(p) {
      const leverage = Math.min(Math.max(p.settings.leverage ?? P.margin.defaultLeverage, P.margin.minLeverage), P.margin.maxLeverage)
      const budget = min(units(p.cash), (units(p.capital) * BigInt(P.maxOrderShareBps)) / BPS)
      if (budget < units(P.minOrder)) return null
      const list = (p.settings.symbols.slice(0, P.maxSymbols) as TradingSymbol[]) || []
      const symbols = list.length ? list : await raw.discover()
      for (const symbol of symbols) {
        let market: Market
        try {
          market = await raw.market(symbol)
        } catch {
          continue
        }
        if (market.candles.length < 3 || market.candles.at(-1)!.close <= market.candles[0]!.close)
          continue
        const price = ceilStep(
          ceilDiv(market.book.asks[0]![0] * (BPS + BigInt(P.slippageBps)), BPS),
          market.instrument.tick,
        )
        const notional =
          (budget * BigInt(leverage) * BPS) / (BPS + 2n * BigInt(P.maxFeeBps) * BigInt(leverage))
        const qty = floorStep((notional * SCALE) / price, market.instrument.lot)
        if (qty < market.instrument.minQty) continue
        const gross = cost(qty, price)
        const margin = ceilDiv(gross, BigInt(leverage))
        const reserve = margin + fee(gross, P.maxFeeBps) * 2n
        if (reserve > budget) continue
        const stop = floorStep((price * (BPS - BigInt((p.settings.stopLossBps ?? P.margin.defaultStopLossBps)))) / BPS, market.instrument.tick)
        const take = ceilStep(ceilDiv(price * (BPS + BigInt((p.settings.takeProfitBps ?? P.margin.defaultTakeProfitBps))), BPS), market.instrument.tick)
        return {
          reserve: decimal(reserve),
          plan: {
            symbol,
            quantity: decimal(qty),
            entryPrice: decimal(price),
            hedgePrice: decimal(gross - margin),
            buyVenue: venue,
            sellVenue: venue,
            outcome: 'yes',
            rate: decimal((gross - margin) as bigint),
            nextPaymentAt: now() + 86_400_000,
            intervalMs: 86_400_000,
            side: 'buy',
            leverage,
            stopPrice: decimal(stop),
            takePrice: decimal(take),
          },
        }
      }
      return null
    },
    async decide(p, op, legs: ExecutionLeg[]): Promise<ExecutionDecision> {
      if (legs.some((item) => item.state !== 'terminal' || !item.receipt || ['unknown', 'pending'].includes(item.receipt.status)))
        return { type: 'attention', reason: 'EXECUTION_ORDER_UNKNOWN' }
      const market = await raw.market(op.plan.symbol as TradingSymbol)
      const sell = floorStep((market.book.bids[0]![0] * (BPS - BigInt(P.slippageBps))) / BPS, market.instrument.tick)
      const buy = ceilStep(ceilDiv(market.book.asks[0]![0] * (BPS + BigInt(P.slippageBps)), BPS), market.instrument.tick)
      let qty = 0n,
        spent = 0n,
        fees = 0n
      for (const leg of legs) {
        const r = leg.receipt!
        const filled = units(r.filledQuantity)
        const gross = units(r.grossQuote)
        const quoteFee = units(r.quoteFee)
        if (leg.prepared.intent.action === 'buy' || leg.prepared.intent.action === 'borrow') {
          qty += filled
          spent += gross + quoteFee
        } else {
          qty -= filled
          spent -= gross - quoteFee
        }
        fees += quoteFee
      }
      const borrowed = units(op.plan.hedgePrice)
      const flows = interest(op, borrowed)
      const interestPaid = flows.reduce((total, item) => total + units(item.amount), 0n)
      const mark = sell
      let liquidationClose = false
      if (mode !== 'paper' && qty) {
        const account = await raw.account(op.plan.symbol as TradingSymbol)
        if (account.positions.some((item) => item.leverage > P.margin.maxLeverage))
          return { type: 'attention', reason: 'EXECUTION_LEVERAGE_FORBIDDEN' }
        liquidationClose = account.positions.some(
          (item) =>
            item.liquidation !== null &&
            item.mark * BPS <= item.liquidation * (BPS + BigInt((p.settings.liquidationBufferBps ?? P.margin.liquidationBufferBps))),
        )
      } else if (qty) {
        const liq = estimatedLiquidation(units(op.plan.entryPrice), op.plan.leverage || p.settings.leverage || P.margin.defaultLeverage, 'buy')
        liquidationClose = mark * BPS <= liq * (BPS + BigInt((p.settings.liquidationBufferBps ?? P.margin.liquidationBufferBps)))
      }
      const stopHit = !!op.plan.stopPrice && mark <= units(op.plan.stopPrice)
      const takeHit = !!op.plan.takePrice && mark >= units(op.plan.takePrice)
      const closing =
        op.status === 'closing' ||
        p.close_requested ||
        liquidationClose ||
        stopHit ||
        takeHit ||
        now() - op.created_at.getTime() >= p.settings.maxHoldHours * 60 * 60_000
      const leg = (role: string, action: 'buy' | 'sell' | 'borrow' | 'repay', size: bigint): ExecutionDecision => {
        const price = action === 'buy' || action === 'borrow' ? buy : sell
        const notional = cost(size, price)
        return {
          type: 'leg',
          role,
          intent: {
            clientId: '',
            venue,
            action,
            symbol: op.plan.symbol,
            quantity: decimal(size),
            limitPrice: decimal(price),
            quoteBudget: decimal(notional + fee(notional, P.maxFeeBps)),
            positionQuantity: decimal(qty),
            expiresAt: now() + P.intentLifetimeMs,
          },
        }
      }
      if (!legs.length) {
        if (closing) return { type: 'close', pnl: '0', fees: '0' }
        return leg('open', 'buy', units(op.plan.quantity))
      }
      if (!qty) {
        return {
          type: 'close',
          pnl: decimal(-spent - interestPaid),
          fees: decimal(fees + interestPaid),
          flows,
        }
      }
      if (closing) return leg('close', 'sell', qty)
      const equity = proceeds(qty, mark) - borrowed - interestPaid - (spent - borrowed)
      if (equity < 0n && -equity * BPS >= units(op.reserve) * BigInt(P.positionLossBps))
        return leg('close', 'sell', qty)
      return { type: 'hold', pnl: decimal(equity), fees: decimal(fees + interestPaid), flows }
    },
  }
}
