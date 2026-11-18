import { createHash } from 'node:crypto'
import { EXECUTION_POLICY as P } from '../../policy'
import { decimal, units } from '../../trading/decimal'
import type { Market, TradingSymbol } from '../../trading/types'
import type { MarginClient } from '../drivers/margin'
import {
  ExecutionRejected,
  type ExecutionExchange,
  type ExecutionIntent,
  type ExecutionReceipt,
  type PreparedExecution,
} from '../types'
import type { FuturesVenueOptions } from './futures-venues'
import {
  assertLiveWrite,
  buildRequest,
  compactSymbol,
  okxSpotSymbol,
  requireRetOk,
  sendRequest,
  type RestKind,
} from './rest'

function lev(value?: number) {
  const n = value ?? P.margin.defaultLeverage
  if (!Number.isSafeInteger(n) || n < P.margin.minLeverage || n > P.margin.maxLeverage)
    throw new Error('EXECUTION_LEVERAGE_FORBIDDEN')
  return n
}

function amount(value: unknown) {
  if (value === undefined || value === null || value === '') return 0n
  return units(String(value))
}

/** Isolated spot-margin clients. Borrow/repay/order follow official venue paths. */
export function createMarginClient(
  options: FuturesVenueOptions,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): MarginClient {
  const leverage = lev(options.leverage)
  const identity = createHash('sha256')
    .update(`margin:${options.exchange}:${options.mode}:${options.credentials.key}`)
    .digest('hex')
  const kind: RestKind = options.exchange === 'binance' ? 'sapi' : 'spot'
  const codeOf = (symbol: string) =>
    options.exchange === 'okx' ? okxSpotSymbol(symbol) : compactSymbol(symbol)

  async function call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    p: { query?: Record<string, string>; body?: Record<string, unknown>; signed?: boolean } = {},
  ) {
    const built = buildRequest({
      exchange: options.exchange,
      mode: options.mode,
      kind,
      method,
      path,
      query: p.query,
      body: p.body,
      credentials: options.credentials,
      signed: p.signed,
      now: now(),
    })
    return requireRetOk(options.exchange, await sendRequest(built, fetchImpl))
  }

  async function market(symbol: TradingSymbol): Promise<Market> {
    const code = codeOf(symbol)
    let tick = units('0.01')
    let lot = units('0.00001')
    let minQty = lot
    let minNotional = units('5')
    let bid = 0n
    let ask = 0n
    let at = now()
    if (options.exchange === 'bybit') {
      const info = (await call('GET', '/v5/market/instruments-info', {
        query: { category: 'spot', symbol: code },
      })) as {
        list?: { lotSizeFilter?: Record<string, string>; priceFilter?: Record<string, string> }[]
      }
      const row = info.list?.[0]
      lot = amount(row?.lotSizeFilter?.basePrecision || '0.00001')
      minQty = amount(row?.lotSizeFilter?.minOrderQty || '0.00001')
      tick = amount(row?.priceFilter?.tickSize || '0.01')
      minNotional = amount(row?.lotSizeFilter?.minOrderAmt || '5')
      const depth = (await call('GET', '/v5/market/orderbook', {
        query: { category: 'spot', symbol: code, limit: '1' },
      })) as {
        ts?: number
        b?: string[][]
        a?: string[][]
      }
      bid = amount(depth.b?.[0]?.[0])
      ask = amount(depth.a?.[0]?.[0])
      at = Number(depth.ts || now())
    } else if (options.exchange === 'okx') {
      const inst = (await call('GET', '/api/v5/public/instruments', {
        query: { instType: 'SPOT', instId: code },
      })) as {
        tickSz?: string
        lotSz?: string
        minSz?: string
      }[]
      const row = inst?.[0]
      tick = amount(row?.tickSz || '0.01')
      lot = amount(row?.lotSz || '0.00001')
      minQty = amount(row?.minSz || '0.00001')
      const depth = (await call('GET', '/api/v5/market/books', {
        query: { instId: code, sz: '1' },
      })) as {
        ts?: string
        bids?: string[][]
        asks?: string[][]
      }[]
      bid = amount(depth?.[0]?.bids?.[0]?.[0])
      ask = amount(depth?.[0]?.asks?.[0]?.[0])
      at = Number(depth?.[0]?.ts || now())
    } else if (options.exchange === 'binance') {
      const depth = (await call('GET', '/api/v3/depth', {
        query: { symbol: code, limit: '5' },
      })) as {
        bids?: string[][]
        asks?: string[][]
      }
      bid = amount(depth.bids?.[0]?.[0])
      ask = amount(depth.asks?.[0]?.[0])
    } else {
      const depth = (await call('GET', '/api/v2/spot/market/orderbook', {
        query: { symbol: code, type: 'step0', limit: '1' },
      })) as {
        bids?: string[][]
        asks?: string[][]
        ts?: string
      }
      bid = amount(depth.bids?.[0]?.[0])
      ask = amount(depth.asks?.[0]?.[0])
      at = Number(depth.ts || now())
    }
    const last = ask || bid
    return {
      instrument: { symbol, lot, minQty, tick, minNotional },
      book: { symbol, at, bids: [[bid || last, units('1')]], asks: [[ask || last, units('1')]] },
      candles: [
        { at: at - 120_000, close: last },
        { at: at - 60_000, close: last },
        { at, close: last },
      ],
    }
  }

  return {
    market,
    async discover() {
      return ['BTC-USDT', 'ETH-USDT']
    },
    async account(symbol) {
      let available = 0n
      let debt = 0n
      if (options.exchange === 'bybit') {
        const wallet = (await call('GET', '/v5/account/wallet-balance', {
          signed: true,
          query: { accountType: 'UNIFIED' },
        })) as {
          list?: {
            coin?: {
              coin: string
              walletBalance: string
              borrowAmount?: string
              availableToWithdraw?: string
            }[]
          }[]
        }
        const usdt = wallet.list?.[0]?.coin?.find((item) => item.coin === 'USDT')
        available = amount(usdt?.availableToWithdraw || usdt?.walletBalance)
        debt = amount(usdt?.borrowAmount)
      } else if (options.exchange === 'okx') {
        const bals = (await call('GET', '/api/v5/account/balance', { signed: true })) as {
          details?: { ccy: string; availBal: string; liab?: string }[]
        }[]
        const usdt = bals?.[0]?.details?.find((item) => item.ccy === 'USDT')
        available = amount(usdt?.availBal)
        debt = amount(usdt?.liab)
      } else if (options.exchange === 'binance') {
        const row = (await call('GET', '/sapi/v1/margin/isolated/account', {
          signed: true,
          query: { symbols: codeOf(symbol) },
        })) as { assets?: { quoteAsset?: { free?: string; borrowed?: string } }[] }
        available = amount(row.assets?.[0]?.quoteAsset?.free)
        debt = amount(row.assets?.[0]?.quoteAsset?.borrowed)
      } else {
        const row = (await call('GET', '/api/v2/margin/isolated/account/assets', {
          signed: true,
          query: { symbol: codeOf(symbol) },
        })) as { quoteAvailable?: string; quoteBorrowed?: string }[]
        available = amount(row?.[0]?.quoteAvailable)
        debt = amount(row?.[0]?.quoteBorrowed)
      }
      return { identity, available, debt, positions: [] }
    },
    async pending() {
      return []
    },
    async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
      if (!['buy', 'sell', 'borrow', 'repay'].includes(intent.action))
        throw new Error('EXECUTION_INTENT_INVALID')
      if (units(intent.quantity) <= 0n) throw new ExecutionRejected('EXECUTION_ORDER_SIZE')
      return {
        intent,
        payload: { mode: options.mode, exchange: options.exchange, leverage },
        externalId: null,
      }
    },
    async broadcast(prepared: PreparedExecution) {
      assertLiveWrite(options.mode, options.liveEnabled)
      if (options.authorizeWrite && !(await options.authorizeWrite()))
        throw new Error('EXECUTION_WRITE_FORBIDDEN')
      const intent = prepared.intent
      const code = codeOf(intent.symbol)
      const qty = intent.quantity
      if (intent.action === 'borrow' || intent.action === 'repay') {
        if (options.exchange === 'bybit') {
          await call(
            'POST',
            intent.action === 'borrow' ? '/v5/account/borrow' : '/v5/account/repay',
            {
              signed: true,
              body: { coin: 'USDT', amount: qty },
            },
          )
          return
        }
        if (options.exchange === 'okx') {
          await call('POST', '/api/v5/account/spot-manual-borrow-repay', {
            signed: true,
            body: {
              ccy: intent.symbol.endsWith('-USDT') ? intent.symbol.slice(0, -5) : 'USDT',
              amt: qty,
              side: intent.action === 'borrow' ? 'borrow' : 'repay',
            },
          })
          return
        }
        if (options.exchange === 'binance') {
          await call(
            'POST',
            intent.action === 'borrow' ? '/sapi/v1/margin/loan' : '/sapi/v1/margin/repay',
            {
              signed: true,
              body: { asset: 'USDT', isIsolated: 'TRUE', symbol: code, amount: qty },
            },
          )
          return
        }
        await call(
          'POST',
          intent.action === 'borrow'
            ? '/api/v2/margin/isolated/account/borrow'
            : '/api/v2/margin/isolated/account/repay',
          {
            signed: true,
            body: { symbol: code, coin: 'USDT', amount: qty },
          },
        )
        return
      }
      if (options.exchange === 'bybit') {
        await call('POST', '/v5/spot-margin-trade/set-leverage', {
          signed: true,
          body: { leverage: String(leverage) },
        })
        await call('POST', '/v5/order/create', {
          signed: true,
          body: {
            category: 'spot',
            symbol: code,
            isLeverage: 1,
            side: intent.action === 'buy' ? 'Buy' : 'Sell',
            orderType: 'Limit',
            timeInForce: 'IOC',
            qty,
            price: intent.limitPrice,
            orderLinkId: intent.clientId,
          },
        })
        return
      }
      if (options.exchange === 'okx') {
        await call('POST', '/api/v5/account/set-leverage', {
          signed: true,
          body: { instId: code, lever: String(leverage), mgnMode: 'isolated' },
        })
        await call('POST', '/api/v5/trade/order', {
          signed: true,
          body: {
            instId: code,
            tdMode: 'isolated',
            side: intent.action,
            ordType: 'ioc',
            sz: qty,
            px: intent.limitPrice,
            clOrdId: intent.clientId.replace(/[^0-9A-Za-z]/g, '').slice(0, 32),
          },
        })
        return
      }
      if (options.exchange === 'binance') {
        await call('POST', '/sapi/v1/margin/order', {
          signed: true,
          body: {
            symbol: code,
            isIsolated: 'TRUE',
            side: intent.action.toUpperCase(),
            type: 'LIMIT',
            timeInForce: 'IOC',
            quantity: qty,
            price: intent.limitPrice,
            newClientOrderId: intent.clientId,
            sideEffectType: 'MARGIN_BUY',
          },
        })
        return
      }
      await call('POST', '/api/v2/margin/isolated/order/place', {
        signed: true,
        body: {
          symbol: code,
          side: intent.action,
          orderType: 'limit',
          force: 'ioc',
          size: qty,
          price: intent.limitPrice,
          clientOid: intent.clientId,
        },
      })
    },
    async lookup(prepared: PreparedExecution): Promise<ExecutionReceipt | null> {
      if (['borrow', 'repay'].includes(prepared.intent.action)) {
        return {
          status: 'filled',
          externalId: prepared.externalId,
          filledQuantity: prepared.intent.quantity,
          grossQuote: prepared.intent.quantity,
          quoteFee: '0',
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
    async cancel(prepared) {
      assertLiveWrite(options.mode, options.liveEnabled)
      const code = codeOf(prepared.intent.symbol)
      if (options.exchange === 'bybit') {
        await call('POST', '/v5/order/cancel', {
          signed: true,
          body: { category: 'spot', symbol: code, orderLinkId: prepared.intent.clientId },
        })
      }
    },
  }
}
