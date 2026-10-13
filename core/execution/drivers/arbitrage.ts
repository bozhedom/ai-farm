import { query } from '../../db'
import { EXECUTION_POLICY as P } from '../../policy'
import {
  BPS,
  SCALE,
  cost,
  decimal,
  fee,
  floorStep,
  min,
  proceeds,
  units,
} from '../../trading/decimal'
import { baseAsset, screen } from '../../trading/universe'
import type {
  Account,
  Market,
  MarketListing,
  TradingExchange,
  TradingSymbol,
  TradingVenue,
} from '../../trading/types'
import { executionSpotVenue, createSpotAdapter } from '../adapters/spot'
import { createPaperAdapter } from '../adapters/paper'
import { verifiedAssets } from '../config'
import type {
  ExecutionDriver,
  ExecutionAdapter,
  ExecutionIntent,
  ExecutionLeg,
  ExecutionMode,
  ExecutionPortfolio,
  Json,
} from '../types'

type Snapshot = {
  usdt: string
  assets: { symbol: TradingSymbol; quantity: string; price: string }[]
}
type Inventory = {
  venue: TradingExchange
  identity: string
  snapshot: Snapshot
  cash: bigint
  assets: Map<TradingSymbol, bigint>
}
function fresh(m: Market) {
  if (
    Date.now() - m.book.at > P.quoteMaxAgeMs ||
    m.book.at > Date.now() + 2000 ||
    !m.book.asks.length ||
    !m.book.bids.length ||
    m.book.bids[0]![0] <= 0n ||
    m.book.asks[0]![0] < m.book.bids[0]![0]
  )
    throw new Error('EXECUTION_STALE_QUOTE')
}
function commonLot(a: bigint, b: bigint) {
  if (a <= 0n || b <= 0n) throw new Error('EXECUTION_MARKET_INVALID')
  let x = a,
    y = b
  while (y) {
    const r = x % y
    x = y
    y = r
  }
  return (a / x) * b
}
function quote(m: Market, buy: boolean) {
  fresh(m)
  return buy ? m.book.asks[0]![0] : m.book.bids[0]![0]
}
function qtyNet(l: ExecutionLeg) {
  return l.receipt ? units(l.receipt.filledQuantity) - units(l.receipt.baseFee) : 0n
}
function candidate(row: MarketListing) {
  // screen deliberately leaves eligible=false until spot-strategy candle inspection.
  // Arbitrage needs active, liquid markets; a quiet local price does not invalidate a spread.
  return ['SCOUT_ON_RADAR', 'SCOUT_QUIET'].includes(screen(row).reason)
}

export function createArbitrageDriver(
  mode: ExecutionMode,
  venues?: Partial<Record<TradingExchange, TradingVenue>>,
): ExecutionDriver {
  const cache = new Map<TradingExchange, TradingVenue>()
  const adapters = new Map<TradingExchange, ExecutionAdapter>()
  const venue = (id: TradingExchange) => {
    if (!cache.has(id)) cache.set(id, venues?.[id] || executionSpotVenue(id, mode))
    return cache.get(id)!
  }
  async function snapshots(p: ExecutionPortfolio): Promise<Inventory[]> {
    const rows = await query<{ venue: TradingExchange; identity: string; snapshot: Snapshot }>(
      'SELECT venue,identity,snapshot FROM execution_accounts WHERE track=$1 AND mode=$2 ORDER BY venue',
      [p.track, mode],
    )
    const legs = await query<ExecutionLeg>(
      'SELECT l.* FROM execution_legs l JOIN execution_operations o ON o.id=l.operation_id WHERE o.track=$1 AND o.mode=$2 AND l.receipt IS NOT NULL ORDER BY l.created_at,l.sequence',
      [p.track, mode],
    )
    return rows.map((row) => {
      let cash = units(row.snapshot.usdt)
      const assets = new Map(row.snapshot.assets.map((a) => [a.symbol, units(a.quantity)]))
      for (const leg of legs.filter((l) => l.prepared.intent.venue === row.venue)) {
        const r = leg.receipt!,
          buy = leg.prepared.intent.action === 'buy',
          symbol = leg.prepared.intent.symbol as TradingSymbol
        assets.set(
          symbol,
          (assets.get(symbol) || 0n) +
            (buy ? units(r.filledQuantity) : -units(r.filledQuantity)) -
            units(r.baseFee),
        )
        cash += (buy ? -units(r.grossQuote) : units(r.grossQuote)) - units(r.quoteFee)
      }
      return { ...row, cash, assets }
    })
  }
  async function reconciled(p: ExecutionPortfolio) {
    const rows = await snapshots(p)
    if (rows.length !== 2) throw new Error('EXECUTION_INVENTORY_REQUIRED')
    const accounts = new Map<TradingExchange, Account>()
    if (mode !== 'paper')
      for (const row of rows) {
        const symbols = [...row.assets.keys()],
          account = await venue(row.venue).account(symbols)
        if (account.identity !== row.identity) throw new Error('EXECUTION_ACCOUNT_CHANGED')
        if (
          account.balances.USDT.total !== row.cash ||
          account.balances.USDT.available !== row.cash
        )
          throw new Error('EXECUTION_ACCOUNT_DRIFT')
        for (const [symbol, q] of row.assets)
          if (
            (account.balances[baseAsset(symbol)]?.total || 0n) !== q ||
            (account.balances[baseAsset(symbol)]?.available || 0n) !== q
          )
            throw new Error('EXECUTION_ACCOUNT_DRIFT')
        const allowed = new Set(['USDT', ...symbols.map(baseAsset)])
        if (
          Object.entries(account.balances).some(([asset, b]) => b.total > 0n && !allowed.has(asset))
        )
          throw new Error('EXECUTION_FOREIGN_ASSET')
        if ((await venue(row.venue).pending()).length) throw new Error('EXECUTION_FOREIGN_ORDER')
        accounts.set(row.venue, account)
      }
    return { rows, accounts }
  }
  const driver: ExecutionDriver = {
    async accounts(p) {
      if (p.started_at)
        return (await reconciled(p)).rows.map((r) => ({ identity: r.identity, venue: r.venue }))
      const ids = [p.settings.buyExchange, p.settings.sellExchange]
      if (ids[0] === ids[1]) throw new Error('EXECUTION_DIFFERENT_EXCHANGES_REQUIRED')
      const listings = await Promise.all(ids.map((id) => venue(id).discover()))
      let common = listings[0]!
        .filter(
          (r) => candidate(r) && listings[1]!.some((b) => b.symbol === r.symbol && candidate(b)),
        )
        .map((r) => r.symbol)
      if (p.settings.symbols.length) common = common.filter((s) => p.settings.symbols.includes(s))
      if (mode !== 'paper')
        common = common.filter((s) =>
          verifiedAssets().some(
            (a) => a.symbol === s && ids.every((id) => a.exchanges.includes(id)),
          ),
        )
      common = common.slice(0, P.maxSymbols)
      if (!common.length) throw new Error('EXECUTION_NO_ELIGIBLE_ASSETS')
      const result: { identity: string; venue: TradingExchange; snapshot: Json }[] = []
      let totalCash = 0n,
        totalBase = 0n
      for (const id of ids) {
        const account = mode === 'paper' ? null : await venue(id).account(common)
        if (mode !== 'paper' && (await venue(id).pending()).length)
          throw new Error('EXECUTION_FOREIGN_ORDER')
        const snapshot: Snapshot = { usdt: decimal(units(p.capital) / 4n), assets: [] }
        if (account) snapshot.usdt = decimal(account.balances.USDT.total)
        for (const symbol of mode === 'paper' ? common.slice(0, 1) : common) {
          const available = account?.balances[baseAsset(symbol)]?.available || 0n
          if (account && available === 0n) continue
          const m = await venue(id).market(symbol),
            price = quote(m, false)
          const qty = account
            ? available
            : floorStep(((units(p.capital) / 4n) * SCALE) / price, m.instrument.lot)
          if (qty <= 0n) continue
          snapshot.assets.push({ symbol, quantity: decimal(qty), price: decimal(price) })
          totalBase += cost(qty, price)
          if (!account) snapshot.usdt = decimal(units(p.capital) / 2n - cost(qty, price))
        }
        if (!snapshot.assets.length) throw new Error('EXECUTION_INVENTORY_REQUIRED')
        totalCash += units(snapshot.usdt)
        if (units(snapshot.usdt) < units(p.capital) / 4n)
          throw new Error('EXECUTION_BALANCE_REQUIRED')
        if (account) {
          if (
            Object.values(account.balances).some((balance) => balance.available !== balance.total)
          )
            throw new Error('EXECUTION_ACCOUNT_DRIFT')
          const allowed = new Set(['USDT', ...snapshot.assets.map((a) => baseAsset(a.symbol))])
          if (
            Object.entries(account.balances).some(
              ([asset, b]) => b.total > 0n && !allowed.has(asset),
            )
          )
            throw new Error('EXECUTION_FOREIGN_ASSET')
        }
        result.push({
          identity: account?.identity || `paper:arbitrage:${id}`,
          venue: id,
          snapshot: snapshot as unknown as Json,
        })
      }
      if (totalBase > units(p.capital) / 2n || totalCash + totalBase < units(p.capital))
        throw new Error('EXECUTION_ALLOCATION_INVENTORY_MISMATCH')
      const shared = (result[0]!.snapshot as unknown as Snapshot).assets.some((asset) =>
        (result[1]!.snapshot as unknown as Snapshot).assets.some(
          (other) => other.symbol === asset.symbol && units(other.quantity) > 0n,
        ),
      )
      if (!shared) throw new Error('EXECUTION_INVENTORY_REQUIRED')
      return result
    },
    async equity(p) {
      const { rows } = await reconciled(p)
      let change = 0n
      for (const row of rows) {
        change += row.cash - units(row.snapshot.usdt)
        for (const asset of row.snapshot.assets) {
          const current = await venue(row.venue).market(asset.symbol)
          change +=
            proceeds(row.assets.get(asset.symbol) || 0n, quote(current, false)) -
            proceeds(units(asset.quantity), units(asset.price))
        }
      }
      return decimal(units(p.capital) + change)
    },
    async plan(p) {
      const { rows, accounts } = await reconciled(p)
      for (const buy of rows)
        for (const sell of rows.filter((r) => r.venue !== buy.venue)) {
          for (const symbol of sell.assets.keys()) {
            if (!buy.assets.has(symbol)) continue
            if (
              mode !== 'paper' &&
              !verifiedAssets().some(
                (a) =>
                  a.symbol === symbol &&
                  a.exchanges.includes(buy.venue) &&
                  a.exchanges.includes(sell.venue),
              )
            )
              continue
            const [a, b] = await Promise.all([
              venue(buy.venue).market(symbol),
              venue(sell.venue).market(symbol),
            ])
            const ask = quote(a, true),
              bid = quote(b, false),
              rateA = accounts.get(buy.venue)?.feeBps[symbol] ?? P.maxFeeBps,
              rateB = accounts.get(sell.venue)?.feeBps[symbol] ?? P.maxFeeBps
            if (
              [rateA, rateB].some(
                (rate) => !Number.isSafeInteger(rate) || rate < 0 || rate > P.maxFeeBps,
              )
            )
              throw new Error('EXECUTION_FEE_UNKNOWN')
            const budget = min(units(p.cash), (units(p.capital) * BigInt(P.maxOrderShareBps)) / BPS)
            const qty = floorStep(
              min(
                (((budget * SCALE) / (2n * ask)) * (BPS - BigInt(rateA + rateB))) / BPS,
                min(sell.assets.get(symbol) || 0n, min(a.book.asks[0]![1], b.book.bids[0]![1])),
              ),
              commonLot(a.instrument.lot, b.instrument.lot),
            )
            const spend = cost(qty, ask),
              income = proceeds(qty, bid),
              fees = fee(spend, rateA) + fee(income, rateB)
            if (
              qty < a.instrument.minQty ||
              qty < b.instrument.minQty ||
              spend < (a.instrument.minNotional || units(P.minOrder)) ||
              income < (b.instrument.minNotional || units(P.minOrder)) ||
              spend + fee(spend, rateA) > buy.cash
            )
              continue
            if ((income - spend - fees) * BPS < spend * BigInt(p.settings.minEdgeBps)) continue
            return {
              reserve: decimal(spend * 2n + fees),
              plan: {
                symbol,
                quantity: decimal(qty),
                entryPrice: decimal(ask),
                hedgePrice: decimal(bid),
                buyVenue: buy.venue,
                sellVenue: sell.venue,
                outcome: 'yes',
                rate: '0',
                nextPaymentAt: 0,
                intervalMs: 0,
              },
            }
          }
        }
      return null
    },
    async decide(p, op, legs) {
      if (
        legs.some(
          (leg) =>
            leg.state !== 'terminal' ||
            !leg.receipt ||
            ['pending', 'unknown'].includes(leg.receipt.status),
        )
      )
        return { type: 'attention', reason: 'EXECUTION_ORDER_UNKNOWN' }
      await reconciled(p)
      const plan = op.plan,
        symbol = plan.symbol as TradingSymbol
      const filled = legs.filter((l) => l.receipt),
        buys = filled.filter((l) => l.prepared.intent.action === 'buy'),
        sells = filled.filter((l) => l.prepared.intent.action === 'sell')
      const bought = buys.reduce((s, l) => s + qtyNet(l), 0n),
        sold = sells.reduce(
          (s, l) => s + units(l.receipt!.filledQuantity) + units(l.receipt!.baseFee),
          0n,
        )
      const fees = filled.reduce(
        (s, l) =>
          s +
          units(l.receipt!.quoteFee) +
          (units(l.receipt!.filledQuantity)
            ? (units(l.receipt!.baseFee) * units(l.receipt!.grossQuote)) /
              units(l.receipt!.filledQuantity)
            : 0n),
        0n,
      )
      const cash = filled.reduce(
        (s, l) =>
          s +
          (l.prepared.intent.action === 'buy'
            ? -units(l.receipt!.grossQuote)
            : units(l.receipt!.grossQuote)) -
          units(l.receipt!.quoteFee),
        0n,
      )
      if (!legs.length) {
        if (p.close_requested) return { type: 'close', pnl: '0', fees: '0' }
        const intent: ExecutionIntent = {
          clientId: '',
          venue: plan.buyVenue,
          action: 'buy',
          symbol,
          quantity: plan.quantity,
          limitPrice: plan.entryPrice,
          quoteBudget: decimal(
            cost(units(plan.quantity), units(plan.entryPrice)) +
              fee(cost(units(plan.quantity), units(plan.entryPrice)), P.maxFeeBps),
          ),
          positionQuantity: '0',
          expiresAt: Date.now() + P.intentLifetimeMs,
        }
        return { type: 'leg', role: 'buy', intent }
      }
      if (bought === sold) return { type: 'close', pnl: decimal(cash), fees: decimal(fees) }
      if (sold > bought) return { type: 'attention', reason: 'EXECUTION_EXCESS_SALE' }
      if (sells.length >= P.maxRepairLegs)
        return { type: 'attention', reason: 'EXECUTION_RESIDUAL_POSITION' }
      const target = sells.length ? plan.buyVenue : plan.sellVenue
      const market = await venue(target as TradingExchange).market(symbol),
        remaining = bought - sold
      const qty = floorStep(remaining, market.instrument.lot),
        price = quote(market, false)
      if (
        qty < market.instrument.minQty ||
        cost(qty, price) < (market.instrument.minNotional || units(P.minOrder))
      )
        return { type: 'attention', reason: 'EXECUTION_RESIDUAL_DUST' }
      return {
        type: 'leg',
        role: sells.length ? 'compensate' : 'sell',
        intent: {
          clientId: '',
          venue: target,
          action: 'sell',
          symbol,
          quantity: decimal(qty),
          limitPrice: decimal(price),
          positionQuantity: decimal(remaining),
          quoteBudget: decimal(fee(cost(qty, price), P.maxFeeBps)),
          expiresAt: Date.now() + P.intentLifetimeMs,
        },
      }
    },
    adapter(id) {
      if (!['okx', 'bybit', 'binance', 'bitget'].includes(id))
        throw new Error('EXECUTION_VENUE_INVALID')
      const exchange = id as TradingExchange
      if (!adapters.has(exchange)) {
        const v = venue(exchange)
        adapters.set(
          exchange,
          mode === 'paper'
            ? createPaperAdapter((i) => v.market(i.symbol as TradingSymbol))
            : createSpotAdapter(v, exchange, mode),
        )
      }
      return adapters.get(exchange)!
    },
  }
  return driver
}
