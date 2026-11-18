import { createHash } from 'node:crypto'
import { EXECUTION_POLICY as P } from '../../policy'
import { decimal, units } from '../../trading/decimal'
import type { Market, TradingSymbol } from '../../trading/types'
import type { FuturesClient, FuturesPosition } from '../drivers/futures'
import {
  ExecutionRejected,
  type ExecutionExchange,
  type ExecutionIntent,
  type ExecutionReceipt,
  type PreparedExecution,
} from '../types'
import {
  alreadyConfigured,
  assertLiveWrite,
  buildRequest,
  compactSymbol,
  okxSwapSymbol,
  requireRetOk,
  sendRequest,
  tradingSymbolFromCompact,
  type RestCredentials,
  type RestKind,
  type RestMode,
} from './rest'

export type FuturesVenueOptions = {
  mode: RestMode
  exchange: ExecutionExchange
  credentials: RestCredentials
  liveEnabled?: boolean
  leverage?: number
  authorizeWrite?: () => boolean | Promise<boolean>
}

function lev(value?: number) {
  const n = value ?? P.futures.defaultLeverage
  if (!Number.isSafeInteger(n) || n < P.futures.minLeverage || n > P.futures.maxLeverage)
    throw new Error('EXECUTION_LEVERAGE_FORBIDDEN')
  return n
}

function book(
  symbol: TradingSymbol,
  tick: bigint,
  lot: bigint,
  minQty: bigint,
  minNotional: bigint,
  bid: bigint,
  ask: bigint,
  at: number,
  last: bigint,
): Market {
  return {
    instrument: { symbol, lot, minQty, tick, minNotional },
    book: { symbol, at, bids: [[bid, units('1')]], asks: [[ask, units('1')]] },
    candles: [
      { at: at - 120_000, close: last },
      { at: at - 60_000, close: last },
      { at, close: last },
    ],
  }
}

function str(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error('EXECUTION_RESPONSE_INVALID')
  return String(value)
}

function amount(value: unknown) {
  const text = str(value)
  if (!text) return 0n
  return units(text)
}

export function createFuturesClient(
  options: FuturesVenueOptions,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): FuturesClient {
  const leverage = lev(options.leverage)
  const identity = createHash('sha256')
    .update(`futures:${options.exchange}:${options.mode}:${options.credentials.key}`)
    .digest('hex')

  const native = (symbol: string) =>
    options.exchange === 'okx' ? okxSwapSymbol(symbol) : compactSymbol(symbol)

  async function call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    p: {
      query?: Record<string, string>
      body?: Record<string, unknown>
      signed?: boolean
      kind?: RestKind
    } = {},
  ) {
    const built = buildRequest({
      exchange: options.exchange,
      mode: options.mode,
      kind: p.kind || 'futures',
      method,
      path,
      query: p.query,
      body: p.body,
      credentials: options.credentials,
      signed: p.signed,
      now: now(),
    })
    const raw = await sendRequest(built, fetchImpl)
    try {
      return requireRetOk(options.exchange, raw)
    } catch (error) {
      if (alreadyConfigured(options.exchange, raw)) return raw
      throw error
    }
  }

  async function ensureIsolated(symbol: TradingSymbol) {
    const code = native(symbol)
    const value = String(leverage)
    if (options.exchange === 'bybit') {
      await call('POST', '/v5/position/switch-isolated', {
        signed: true,
        body: {
          category: 'linear',
          symbol: code,
          tradeMode: 1,
          buyLeverage: value,
          sellLeverage: value,
        },
      })
      await call('POST', '/v5/position/set-leverage', {
        signed: true,
        body: { category: 'linear', symbol: code, buyLeverage: value, sellLeverage: value },
      })
      return
    }
    if (options.exchange === 'okx') {
      await call('POST', '/api/v5/account/set-leverage', {
        signed: true,
        body: { instId: code, lever: value, mgnMode: 'isolated' },
      })
      return
    }
    if (options.exchange === 'binance') {
      await call('POST', '/fapi/v1/marginType', {
        signed: true,
        body: { symbol: code, marginType: 'ISOLATED' },
      })
      await call('POST', '/fapi/v1/leverage', {
        signed: true,
        body: { symbol: code, leverage: value },
      })
      return
    }
    await call('POST', '/api/v2/mix/account/set-margin-mode', {
      signed: true,
      body: {
        symbol: code,
        productType: 'USDT-FUTURES',
        marginCoin: 'USDT',
        marginMode: 'isolated',
      },
    })
    await call('POST', '/api/v2/mix/account/set-leverage', {
      signed: true,
      body: { symbol: code, productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage: value },
    })
  }

  async function market(symbol: TradingSymbol): Promise<Market> {
    const code = native(symbol)
    if (options.exchange === 'bybit') {
      const info = (await call('GET', '/v5/market/instruments-info', {
        query: { category: 'linear', symbol: code },
      })) as { list?: Record<string, unknown>[] }
      const row = info.list?.[0] as Record<string, unknown> | undefined
      const lot = row?.lotSizeFilter as Record<string, string> | undefined
      const price = row?.priceFilter as Record<string, string> | undefined
      const bookRaw = (await call('GET', '/v5/market/orderbook', {
        query: { category: 'linear', symbol: code, limit: '1' },
      })) as { ts?: number; b?: string[][]; a?: string[][] }
      const tickers = (await call('GET', '/v5/market/tickers', {
        query: { category: 'linear', symbol: code },
      })) as { list?: Record<string, string>[] }
      const last = amount(tickers.list?.[0]?.lastPrice || tickers.list?.[0]?.markPrice)
      return book(
        symbol,
        amount(price?.tickSize || '0.01'),
        amount(lot?.qtyStep || '0.001'),
        amount(lot?.minOrderQty || '0.001'),
        amount(lot?.minNotionalValue || '5'),
        amount(bookRaw.b?.[0]?.[0] || last),
        amount(bookRaw.a?.[0]?.[0] || last),
        Number(bookRaw.ts || now()),
        last,
      )
    }
    if (options.exchange === 'okx') {
      const inst = (await call('GET', '/api/v5/public/instruments', {
        query: { instType: 'SWAP', instId: code },
      })) as Record<string, string>[]
      const row = inst?.[0]
      const ctVal = amount(row?.ctVal || '1')
      const depth = (await call('GET', '/api/v5/market/books', {
        query: { instId: code, sz: '1' },
      })) as Record<string, unknown>[]
      const bookRow = depth?.[0] as
        { ts?: string; bids?: string[][]; asks?: string[][] } | undefined
      const ticker = (await call('GET', '/api/v5/market/ticker', {
        query: { instId: code },
      })) as Record<string, string>[]
      const last = amount(ticker?.[0]?.last || ticker?.[0]?.markPx)
      return book(
        symbol,
        amount(row?.tickSz || '0.01'),
        ctVal,
        amount(row?.minSz || '1') * ctVal,
        units('5'),
        amount(bookRow?.bids?.[0]?.[0] || last),
        amount(bookRow?.asks?.[0]?.[0] || last),
        Number(bookRow?.ts || now()),
        last,
      )
    }
    if (options.exchange === 'binance') {
      const info = (await call('GET', '/fapi/v1/exchangeInfo', { query: { symbol: code } })) as {
        symbols?: {
          filters?: {
            filterType: string
            tickSize?: string
            stepSize?: string
            minQty?: string
            notional?: string
          }[]
        }[]
      }
      const filters = info.symbols?.[0]?.filters || []
      const price = filters.find((item) => item.filterType === 'PRICE_FILTER')
      const lot = filters.find((item) => item.filterType === 'LOT_SIZE')
      const notional = filters.find((item) => item.filterType === 'MIN_NOTIONAL')
      const depth = (await call('GET', '/fapi/v1/depth', {
        query: { symbol: code, limit: '5' },
      })) as {
        bids?: string[][]
        asks?: string[][]
        T?: number
      }
      const ticker = (await call('GET', '/fapi/v1/ticker/price', { query: { symbol: code } })) as {
        price?: string
      }
      const last = amount(ticker.price)
      return book(
        symbol,
        amount(price?.tickSize || '0.01'),
        amount(lot?.stepSize || '0.001'),
        amount(lot?.minQty || '0.001'),
        amount(notional?.notional || '5'),
        amount(depth.bids?.[0]?.[0] || last),
        amount(depth.asks?.[0]?.[0] || last),
        Number(depth.T || now()),
        last,
      )
    }
    const contract = (await call('GET', '/api/v2/mix/market/contracts', {
      query: { productType: 'USDT-FUTURES', symbol: code },
    })) as Record<string, string>[]
    const row = contract?.[0]
    const depth = (await call('GET', '/api/v2/mix/market/orderbook', {
      query: { productType: 'USDT-FUTURES', symbol: code, limit: '1' },
    })) as { bids?: string[][]; asks?: string[][]; ts?: string }
    const ticker = (await call('GET', '/api/v2/mix/market/ticker', {
      query: { productType: 'USDT-FUTURES', symbol: code },
    })) as Record<string, string>[] | { lastPr?: string }
    const last = amount(Array.isArray(ticker) ? ticker[0]?.lastPr : ticker.lastPr)
    return book(
      symbol,
      amount(
        row?.pricePlace
          ? `0.${'0'.repeat(Math.max(0, Number(row.pricePlace) - 1))}1`
          : row?.tickSize || '0.01',
      ),
      amount(row?.sizeMultiplier || row?.minTradeNum || '0.001'),
      amount(row?.minTradeNum || '0.001'),
      units('5'),
      amount(depth.bids?.[0]?.[0] || last),
      amount(depth.asks?.[0]?.[0] || last),
      Number(depth.ts || now()),
      last,
    )
  }

  async function discover(): Promise<TradingSymbol[]> {
    if (options.exchange === 'bybit') {
      const rows = (await call('GET', '/v5/market/instruments-info', {
        query: { category: 'linear' },
      })) as {
        list?: { symbol?: string; quoteCoin?: string; status?: string; contractType?: string }[]
      }
      return (rows.list || [])
        .filter(
          (row) =>
            row.quoteCoin === 'USDT' &&
            row.status === 'Trading' &&
            row.contractType === 'LinearPerpetual',
        )
        .map((row) => tradingSymbolFromCompact(row.symbol || ''))
        .slice(0, P.maxSymbols) as TradingSymbol[]
    }
    if (options.exchange === 'okx') {
      const rows = (await call('GET', '/api/v5/public/instruments', {
        query: { instType: 'SWAP' },
      })) as {
        instId?: string
        settleCcy?: string
        state?: string
        ctType?: string
      }[]
      return (rows || [])
        .filter(
          (row) =>
            row.settleCcy === 'USDT' &&
            row.state === 'live' &&
            (row.instId || '').endsWith('-USDT-SWAP'),
        )
        .map((row) => (row.instId || '').replace(/-SWAP$/, '') as TradingSymbol)
        .slice(0, P.maxSymbols) as TradingSymbol[]
    }
    if (options.exchange === 'binance') {
      const info = (await call('GET', '/fapi/v1/exchangeInfo')) as {
        symbols?: { symbol?: string; contractType?: string; quoteAsset?: string; status?: string }[]
      }
      return (info.symbols || [])
        .filter(
          (row) =>
            row.quoteAsset === 'USDT' &&
            row.status === 'TRADING' &&
            row.contractType === 'PERPETUAL',
        )
        .map((row) => tradingSymbolFromCompact(row.symbol || ''))
        .slice(0, P.maxSymbols) as TradingSymbol[]
    }
    const rows = (await call('GET', '/api/v2/mix/market/contracts', {
      query: { productType: 'USDT-FUTURES' },
    })) as {
      symbol?: string
      quoteCoin?: string
      symbolStatus?: string
    }[]
    return (rows || [])
      .filter(
        (row) => (row.quoteCoin === 'USDT' || true) && (row.symbolStatus || 'normal') !== 'offline',
      )
      .map((row) => tradingSymbolFromCompact(row.symbol || ''))
      .slice(0, P.maxSymbols) as TradingSymbol[]
  }

  async function account(symbol: TradingSymbol) {
    let available = 0n
    const positions: FuturesPosition[] = []
    const code = native(symbol)
    if (options.exchange === 'bybit') {
      const wallet = (await call('GET', '/v5/account/wallet-balance', {
        signed: true,
        query: { accountType: 'UNIFIED' },
      })) as {
        list?: { coin?: { coin: string; walletBalance: string; availableToWithdraw?: string }[] }[]
      }
      const usdt = wallet.list?.[0]?.coin?.find((item) => item.coin === 'USDT')
      available = amount(usdt?.availableToWithdraw || usdt?.walletBalance || '0')
      const list = (await call('GET', '/v5/position/list', {
        signed: true,
        query: { category: 'linear', symbol: code },
      })) as { list?: Record<string, string>[] }
      for (const row of list.list || []) {
        const qty = amount(row.size)
        if (!qty) continue
        positions.push({
          symbol,
          side: row.side === 'Sell' ? 'sell' : 'buy',
          qty,
          entry: amount(row.avgPrice || row.entryPrice || '0'),
          mark: amount(row.markPrice || '0'),
          liquidation: row.liqPrice ? amount(row.liqPrice) : null,
          leverage: Number(row.leverage || leverage),
          margin: amount(row.positionIM || '0'),
        })
      }
    } else if (options.exchange === 'okx') {
      const bals = (await call('GET', '/api/v5/account/balance', { signed: true })) as {
        details?: { ccy: string; availBal: string }[]
      }[]
      const usdt = bals?.[0]?.details?.find((item) => item.ccy === 'USDT')
      available = amount(usdt?.availBal || '0')
      const snapshot = await market(symbol)
      const list = (await call('GET', '/api/v5/account/positions', {
        signed: true,
        query: { instType: 'SWAP', instId: code },
      })) as Record<string, string>[]
      for (const row of list || []) {
        const contracts = amount(row.pos)
        if (!contracts) continue
        const qty = (contracts * snapshot.instrument.lot) / units('1')
        const side = Number(row.pos) < 0 || row.posSide === 'short' ? 'sell' : 'buy'
        positions.push({
          symbol,
          side,
          qty: qty < 0n ? -qty : qty,
          entry: amount(row.avgPx || '0'),
          mark: amount(row.markPx || '0'),
          liquidation: row.liqPx ? amount(row.liqPx) : null,
          leverage: Number(row.lever || leverage),
          margin: amount(row.margin || '0'),
        })
      }
    } else if (options.exchange === 'binance') {
      const bals = (await call('GET', '/fapi/v2/balance', { signed: true })) as {
        asset?: string
        availableBalance?: string
      }[]
      const usdt = (bals || []).find((item) => item.asset === 'USDT')
      available = amount(usdt?.availableBalance || '0')
      const list = (await call('GET', '/fapi/v2/positionRisk', {
        signed: true,
        query: { symbol: code },
      })) as Record<string, string>[]
      for (const row of list || []) {
        const qty = amount(row.positionAmt)
        if (!qty) continue
        positions.push({
          symbol,
          side: qty < 0n ? 'sell' : 'buy',
          qty: qty < 0n ? -qty : qty,
          entry: amount(row.entryPrice || '0'),
          mark: amount(row.markPrice || '0'),
          liquidation:
            row.liquidationPrice && row.liquidationPrice !== '0'
              ? amount(row.liquidationPrice)
              : null,
          leverage: Number(row.leverage || leverage),
          margin: amount(row.isolatedWallet || row.isolatedMargin || '0'),
        })
      }
    } else {
      const bals = (await call('GET', '/api/v2/mix/account/account', {
        signed: true,
        query: { productType: 'USDT-FUTURES', symbol: code, marginCoin: 'USDT' },
      })) as { available?: string; accountEquity?: string }
      available = amount((bals as { available?: string }).available || '0')
      const list = (await call('GET', '/api/v2/mix/position/all-position', {
        signed: true,
        query: { productType: 'USDT-FUTURES', marginCoin: 'USDT', symbol: code },
      })) as Record<string, string>[]
      for (const row of list || []) {
        const qty = amount(row.total || row.size || '0')
        if (!qty) continue
        positions.push({
          symbol,
          side: row.holdSide === 'short' || row.side === 'sell' ? 'sell' : 'buy',
          qty,
          entry: amount(row.openPriceAvg || row.averageOpenPrice || '0'),
          mark: amount(row.markPrice || '0'),
          liquidation: row.liquidationPrice ? amount(row.liquidationPrice) : null,
          leverage: Number(row.leverage || leverage),
          margin: amount(row.marginSize || '0'),
        })
      }
    }
    if (positions.some((item) => item.leverage > P.futures.maxLeverage))
      throw new Error('EXECUTION_LEVERAGE_FORBIDDEN')
    return { identity, available, positions, feeBps: P.maxFeeBps }
  }

  return {
    market,
    discover,
    account,
    async pending() {
      return []
    },
    async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
      if (!['buy', 'sell', 'short', 'cover'].includes(intent.action))
        throw new Error('EXECUTION_INTENT_INVALID')
      compactSymbol(intent.symbol)
      if (units(intent.quantity) <= 0n || units(intent.limitPrice) <= 0n)
        throw new ExecutionRejected('EXECUTION_ORDER_SIZE')
      const snapshot = await market(intent.symbol as TradingSymbol)
      if (units(intent.quantity) % snapshot.instrument.lot)
        throw new ExecutionRejected('EXECUTION_ORDER_SIZE')
      return {
        intent,
        payload: {
          mode: options.mode,
          exchange: options.exchange,
          leverage,
          isolated: true,
          stopPrice: intent.stopPrice || null,
          takePrice: intent.takePrice || null,
        },
        externalId: null,
      }
    },
    async broadcast(prepared: PreparedExecution) {
      assertLiveWrite(options.mode, options.liveEnabled)
      if (options.authorizeWrite && !(await options.authorizeWrite()))
        throw new Error('EXECUTION_WRITE_FORBIDDEN')
      await ensureIsolated(prepared.intent.symbol as TradingSymbol)
      const code = native(prepared.intent.symbol)
      const side = ['buy', 'cover'].includes(prepared.intent.action) ? 'buy' : 'sell'
      const reduceOnly =
        ['sell', 'cover'].includes(prepared.intent.action) &&
        ['sell', 'cover'].includes(prepared.intent.action) &&
        prepared.intent.action !== 'buy' &&
        prepared.intent.action !== 'short'
      const qty = prepared.intent.quantity
      const price = prepared.intent.limitPrice
      const stop =
        prepared.intent.stopPrice ||
        (typeof prepared.payload.stopPrice === 'string' ? prepared.payload.stopPrice : '')
      const take =
        prepared.intent.takePrice ||
        (typeof prepared.payload.takePrice === 'string' ? prepared.payload.takePrice : '')
      if (options.exchange === 'bybit') {
        await call('POST', '/v5/order/create', {
          signed: true,
          body: {
            category: 'linear',
            symbol: code,
            side: side === 'buy' ? 'Buy' : 'Sell',
            orderType: 'Limit',
            timeInForce: 'IOC',
            qty,
            price,
            orderLinkId: prepared.intent.clientId,
            reduceOnly,
            takeProfit: take || undefined,
            stopLoss: stop || undefined,
            tpslMode: take || stop ? 'Full' : undefined,
            tpOrderType: take ? 'Market' : undefined,
            slOrderType: stop ? 'Market' : undefined,
          },
        })
        return
      }
      if (options.exchange === 'okx') {
        const snapshot = await market(prepared.intent.symbol as TradingSymbol)
        const contracts = units(qty) / snapshot.instrument.lot
        if (contracts <= 0n) throw new ExecutionRejected('EXECUTION_ORDER_SIZE')
        await call('POST', '/api/v5/trade/order', {
          signed: true,
          body: {
            instId: code,
            tdMode: 'isolated',
            side,
            ordType: 'ioc',
            sz: decimal(contracts).replace(/\.?0+$/, '') || '1',
            px: price,
            clOrdId: prepared.intent.clientId.replace(/[^0-9A-Za-z]/g, '').slice(0, 32),
            reduceOnly: reduceOnly ? 'true' : undefined,
            attachAlgoOrds:
              stop || take
                ? [
                    {
                      slTriggerPx: stop || undefined,
                      slOrdPx: stop ? '-1' : undefined,
                      tpTriggerPx: take || undefined,
                      tpOrdPx: take ? '-1' : undefined,
                    },
                  ]
                : undefined,
          },
        })
        return
      }
      if (options.exchange === 'binance') {
        await call('POST', '/fapi/v1/order', {
          signed: true,
          body: {
            symbol: code,
            side: side.toUpperCase(),
            type: 'LIMIT',
            timeInForce: 'IOC',
            quantity: qty,
            price,
            newClientOrderId: prepared.intent.clientId,
            reduceOnly: reduceOnly ? 'true' : undefined,
          },
        })
        if (stop) {
          await call('POST', '/fapi/v1/order', {
            signed: true,
            body: {
              symbol: code,
              side: side === 'buy' ? 'SELL' : 'BUY',
              type: 'STOP_MARKET',
              stopPrice: stop,
              closePosition: 'true',
              workingType: 'MARK_PRICE',
            },
          })
        }
        if (take) {
          await call('POST', '/fapi/v1/order', {
            signed: true,
            body: {
              symbol: code,
              side: side === 'buy' ? 'SELL' : 'BUY',
              type: 'TAKE_PROFIT_MARKET',
              stopPrice: take,
              closePosition: 'true',
              workingType: 'MARK_PRICE',
            },
          })
        }
        return
      }
      await call('POST', '/api/v2/mix/order/place-order', {
        signed: true,
        body: {
          symbol: code,
          productType: 'USDT-FUTURES',
          marginMode: 'isolated',
          marginCoin: 'USDT',
          size: qty,
          price,
          side,
          orderType: 'limit',
          force: 'ioc',
          clientOid: prepared.intent.clientId,
          reduceOnly: reduceOnly ? 'YES' : 'NO',
          presetStopLossPrice: stop || undefined,
          presetStopSurplusPrice: take || undefined,
        },
      })
    },
    async lookup(prepared: PreparedExecution): Promise<ExecutionReceipt | null> {
      const code = native(prepared.intent.symbol)
      if (options.exchange === 'bybit') {
        const rows = (await call('GET', '/v5/order/realtime', {
          signed: true,
          query: { category: 'linear', symbol: code, orderLinkId: prepared.intent.clientId },
        })) as { list?: Record<string, string>[] }
        const row = rows.list?.[0]
        if (!row) return null
        const filled = amount(row.cumExecQty)
        return {
          status:
            row.orderStatus === 'Filled'
              ? 'filled'
              : row.orderStatus === 'Cancelled' || row.orderStatus === 'Rejected'
                ? row.orderStatus === 'Rejected'
                  ? 'rejected'
                  : 'cancelled'
                : 'pending',
          externalId: row.orderId || null,
          filledQuantity: decimal(filled),
          grossQuote: decimal(amount(row.cumExecValue || '0')),
          quoteFee: decimal(amount(row.cumExecFee || '0')),
          baseFee: '0',
        }
      }
      return {
        status: 'pending',
        externalId: prepared.externalId,
        filledQuantity: '0',
        grossQuote: '0',
        quoteFee: '0',
        baseFee: '0',
      }
    },
    async cancel(prepared: PreparedExecution) {
      assertLiveWrite(options.mode, options.liveEnabled)
      if (options.authorizeWrite && !(await options.authorizeWrite()))
        throw new Error('EXECUTION_WRITE_FORBIDDEN')
      const code = native(prepared.intent.symbol)
      if (options.exchange === 'bybit') {
        await call('POST', '/v5/order/cancel', {
          signed: true,
          body: { category: 'linear', symbol: code, orderLinkId: prepared.intent.clientId },
        })
        return
      }
      if (options.exchange === 'okx') {
        await call('POST', '/api/v5/trade/cancel-order', {
          signed: true,
          body: {
            instId: code,
            clOrdId: prepared.intent.clientId.replace(/[^0-9A-Za-z]/g, '').slice(0, 32),
          },
        })
        return
      }
      if (options.exchange === 'binance') {
        await call('DELETE', '/fapi/v1/order', {
          signed: true,
          query: { symbol: code, origClientOrderId: prepared.intent.clientId },
        })
        return
      }
      await call('POST', '/api/v2/mix/order/cancel-order', {
        signed: true,
        body: { symbol: code, productType: 'USDT-FUTURES', clientOid: prepared.intent.clientId },
      })
    },
  }
}
