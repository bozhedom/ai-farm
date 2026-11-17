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
import { estimatedLiquidation, syntheticBook } from '../adapters/paper-markets'
import { createPaperAdapter } from '../adapters/paper'
import { futuresVenue } from '../venues'
import type {
  ExecutionAdapter,
  ExecutionDecision,
  ExecutionDriver,
  ExecutionExchange,
  ExecutionIntent,
  ExecutionLeg,
  ExecutionMode,
  ExecutionOperation,
  ExecutionPortfolio,
} from '../types'

export type FuturesPosition = {
  symbol: TradingSymbol
  side: 'buy' | 'sell'
  qty: bigint
  entry: bigint
  mark: bigint
  liquidation: bigint | null
  leverage: number
  margin: bigint
}

export type FuturesClient = {
  market(symbol: TradingSymbol): Promise<Market>
  discover(): Promise<TradingSymbol[]>
  account(symbol: TradingSymbol): Promise<{
    identity: string
    available: bigint
    positions: FuturesPosition[]
    feeBps: number
  }>
  pending(): Promise<{ clientId: string; symbol: TradingSymbol }[]>
} & ExecutionAdapter

function limits(market: Market) {
  const slip = BigInt(P.slippageBps)
  return {
    buy: ceilStep(ceilDiv(market.book.asks[0]![0] * (BPS + slip), BPS), market.instrument.tick),
    sell: floorStep((market.book.bids[0]![0] * (BPS - slip)) / BPS, market.instrument.tick),
  }
}

function sideFromTrend(market: Market): 'buy' | 'sell' | null {
  if (market.candles.length < 3 || !market.book.asks[0] || !market.book.bids[0]) return null
  const first = market.candles[0]!.close
  const last = market.candles[market.candles.length - 1]!.close
  if (last > first) return 'buy'
  if (last < first) return 'sell'
  return null
}

function totals(legs: ExecutionLeg[]) {
  let qty = 0n,
    cash = 0n,
    fees = 0n,
    side: 'buy' | 'sell' | null = null
  for (const leg of legs) {
    const receipt = leg.receipt
    if (!receipt) continue
    const filled = units(receipt.filledQuantity)
    const gross = units(receipt.grossQuote)
    const quoteFee = units(receipt.quoteFee)
    const action = leg.prepared.intent.action
    if (action === 'buy' || action === 'short') {
      if (side && side !== (action === 'buy' ? 'buy' : 'sell'))
        throw new Error('EXECUTION_POSITION_MISMATCH')
      side = action === 'buy' ? 'buy' : 'sell'
      qty += filled
      cash -= action === 'buy' ? gross + quoteFee : -gross + quoteFee
    } else if (action === 'sell' || action === 'cover') {
      qty -= filled
      cash += action === 'sell' ? gross - quoteFee : -(gross + quoteFee)
    }
    fees += quoteFee
  }
  if (qty < 0n) throw new Error('EXECUTION_POSITION_MISMATCH')
  return { qty, cash, fees, side }
}

export function createFuturesDriver(
  mode: ExecutionMode,
  exchange: ExecutionExchange,
  client?: FuturesClient,
  now: () => number = Date.now,
): ExecutionDriver {
  const venue = futuresVenue(exchange)
  const fallback: FuturesClient = {
    async market(symbol) {
      return syntheticBook(symbol, '100')
    },
    async discover() {
      return ['BTC-USDT']
    },
    async account() {
      return {
        identity: `${venue}:${mode}:paper`,
        available: units('100'),
        positions: [],
        feeBps: P.maxFeeBps,
      }
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
  const raw = client || fallback
  const execution: ExecutionAdapter =
    mode === 'paper'
      ? createPaperAdapter((intent) => raw.market(intent.symbol as TradingSymbol))
      : raw

  return {
    adapter(selected) {
      if (selected !== venue) throw new Error('EXECUTION_VENUE_MISMATCH')
      return execution
    },
    async accounts(p) {
      if (mode === 'paper') return [{ identity: `${venue}:paper:virtual`, venue }]
      if (!client) throw new Error('EXECUTION_FUTURES_ADAPTER_PENDING')
      const account = await raw.account((p.settings.symbols[0] || 'BTC-USDT') as TradingSymbol)
      if (!p.started_at && account.available < units(p.capital))
        throw new Error('EXECUTION_INSUFFICIENT_BALANCE')
      if (!p.started_at && (account.positions.length || (await raw.pending()).length))
        throw new Error('EXECUTION_ACCOUNT_NOT_EMPTY')
      if (account.positions.some((item) => item.leverage > P.futures.maxLeverage))
        throw new Error('EXECUTION_LEVERAGE_FORBIDDEN')
      return [{ identity: account.identity, venue }]
    },
    async plan(p) {
      if (mode !== 'paper' && !client) throw new Error('EXECUTION_FUTURES_ADAPTER_PENDING')
      const leverage = Math.min(
        Math.max(p.settings.leverage ?? P.futures.defaultLeverage, P.futures.minLeverage),
        P.futures.maxLeverage,
      )
      const budget = min(units(p.cash), (units(p.capital) * BigInt(P.maxOrderShareBps)) / BPS)
      if (budget < units(P.minOrder)) return null
      const symbols = (p.settings.symbols.slice(0, P.maxSymbols) as TradingSymbol[]) || []
      const list = symbols.length ? symbols : await raw.discover()
      for (const symbol of list) {
        let market: Market
        try {
          market = await raw.market(symbol)
        } catch {
          continue
        }
        const side = sideFromTrend(market)
        if (!side) continue
        const price = limits(market)[side]
        const feeBps =
          mode === 'paper' ? P.maxFeeBps : (await raw.account(symbol)).feeBps || P.maxFeeBps
        const bufferBps = BigInt(p.settings.liquidationBufferBps ?? P.futures.liquidationBufferBps)
        // budget is the isolated reserve: margin, round-trip fees and the liquidation buffer.
        const notional =
          (budget * BigInt(leverage) * BPS) /
          (BPS + bufferBps + 2n * BigInt(feeBps) * BigInt(leverage))
        const qty = floorStep((notional * SCALE) / price, market.instrument.lot)
        if (qty < market.instrument.minQty) continue
        const gross = cost(qty, price)
        const margin = ceilDiv(gross, BigInt(leverage))
        const reserve =
          margin +
          fee(gross, feeBps) * 2n +
          fee(margin, p.settings.liquidationBufferBps ?? P.futures.liquidationBufferBps)
        if (reserve > budget) continue
        const stop =
          side === 'buy'
            ? floorStep(
                (price * (BPS - BigInt(p.settings.stopLossBps ?? P.futures.defaultStopLossBps))) /
                  BPS,
                market.instrument.tick,
              )
            : ceilStep(
                ceilDiv(
                  price * (BPS + BigInt(p.settings.stopLossBps ?? P.futures.defaultStopLossBps)),
                  BPS,
                ),
                market.instrument.tick,
              )
        const take =
          side === 'buy'
            ? ceilStep(
                ceilDiv(
                  price *
                    (BPS + BigInt(p.settings.takeProfitBps ?? P.futures.defaultTakeProfitBps)),
                  BPS,
                ),
                market.instrument.tick,
              )
            : floorStep(
                (price *
                  (BPS - BigInt(p.settings.takeProfitBps ?? P.futures.defaultTakeProfitBps))) /
                  BPS,
                market.instrument.tick,
              )
        return {
          reserve: decimal(reserve),
          plan: {
            symbol,
            quantity: decimal(qty),
            entryPrice: decimal(price),
            hedgePrice: '0',
            buyVenue: venue,
            sellVenue: venue,
            outcome: 'yes',
            rate: '0',
            nextPaymentAt: 0,
            intervalMs: 0,
            side,
            leverage,
            stopPrice: decimal(stop),
            takePrice: decimal(take),
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
      const market = await raw.market(op.plan.symbol as TradingSymbol)
      const position = totals(legs)
      const side = (op.plan.side || position.side) as 'buy' | 'sell'
      const mark = side === 'buy' ? limits(market).sell : limits(market).buy
      let liquidationClose = false
      if (mode !== 'paper' && position.qty) {
        const account = await raw.account(op.plan.symbol as TradingSymbol)
        const held = account.positions.find((item) => item.symbol === op.plan.symbol)
        if (!held || held.qty !== position.qty || held.side !== side)
          return { type: 'attention', reason: 'EXECUTION_POSITION_MISMATCH' }
        if (held.leverage > P.futures.maxLeverage)
          return { type: 'attention', reason: 'EXECUTION_LEVERAGE_FORBIDDEN' }
        liquidationClose =
          held.liquidation !== null &&
          (side === 'buy'
            ? held.mark * BPS <=
              held.liquidation *
                (BPS + BigInt(p.settings.liquidationBufferBps ?? P.futures.liquidationBufferBps))
            : held.mark * BPS >=
              held.liquidation *
                (BPS - BigInt(p.settings.liquidationBufferBps ?? P.futures.liquidationBufferBps)))
      } else if (position.qty) {
        const liq = estimatedLiquidation(
          units(op.plan.entryPrice),
          op.plan.leverage || p.settings.leverage || P.futures.defaultLeverage,
          side,
        )
        liquidationClose =
          side === 'buy'
            ? mark * BPS <=
              liq *
                (BPS + BigInt(p.settings.liquidationBufferBps ?? P.futures.liquidationBufferBps))
            : mark * BPS >=
              liq *
                (BPS - BigInt(p.settings.liquidationBufferBps ?? P.futures.liquidationBufferBps))
      }
      const stopHit =
        !!op.plan.stopPrice &&
        (side === 'buy' ? mark <= units(op.plan.stopPrice) : mark >= units(op.plan.stopPrice))
      const takeHit =
        !!op.plan.takePrice &&
        (side === 'buy' ? mark >= units(op.plan.takePrice) : mark <= units(op.plan.takePrice))
      const age = now() - op.created_at.getTime()
      const closing =
        op.status === 'closing' ||
        p.close_requested ||
        liquidationClose ||
        stopHit ||
        takeHit ||
        age >= p.settings.maxHoldHours * 60 * 60_000
      const intent = (
        role: string,
        action: ExecutionIntent['action'],
        qty: bigint,
        owned: bigint,
      ): ExecutionDecision => {
        const price = limits(market)[action === 'buy' || action === 'cover' ? 'buy' : 'sell']
        const notional = cost(qty, price)
        return {
          type: 'leg',
          role,
          intent: {
            clientId: '',
            venue,
            action,
            symbol: op.plan.symbol,
            quantity: decimal(qty),
            limitPrice: decimal(price),
            quoteBudget: decimal(notional + fee(notional, P.maxFeeBps)),
            positionQuantity: decimal(owned),
            expiresAt: now() + P.intentLifetimeMs,
            stopPrice: op.plan.stopPrice,
            takePrice: op.plan.takePrice,
            leverage: op.plan.leverage,
          },
        }
      }
      if (!legs.length) {
        if (closing) return { type: 'close', pnl: '0', fees: '0' }
        return intent('open', side === 'buy' ? 'buy' : 'short', units(op.plan.quantity), 0n)
      }
      if (!position.qty) {
        const markPnl = position.cash + (side === 'buy' ? proceeds(0n, mark) : 0n)
        return { type: 'close', pnl: decimal(position.cash), fees: decimal(position.fees) }
      }
      if (closing) {
        return intent('close', side === 'buy' ? 'sell' : 'cover', position.qty, position.qty)
      }
      const openPnl =
        position.cash + (side === 'buy' ? proceeds(position.qty, mark) : -cost(position.qty, mark))
      const loss = openPnl < 0n && -openPnl * BPS >= units(op.reserve) * BigInt(P.positionLossBps)
      if (loss)
        return intent('close', side === 'buy' ? 'sell' : 'cover', position.qty, position.qty)
      return { type: 'hold', pnl: decimal(openPnl), fees: decimal(position.fees) }
    },
  }
}
