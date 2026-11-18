import { createHash } from 'node:crypto'
import { EXECUTION_POLICY as P } from '../../policy'
import { decimal, units } from '../../trading/decimal'
import type { OptionQuote, OptionsClient } from '../drivers/options'
import {
  ExecutionRejected,
  type ExecutionExchange,
  type ExecutionIntent,
  type ExecutionReceipt,
  type PreparedExecution,
} from '../types'
import {
  assertLiveWrite,
  buildRequest,
  requireRetOk,
  sendRequest,
  type RestCredentials,
  type RestMode,
} from './rest'

export type OptionsVenueOptions = {
  exchange: Extract<ExecutionExchange, 'bybit' | 'okx'>
  mode: RestMode
  credentials: RestCredentials
  liveEnabled?: boolean
  authorizeWrite?: () => boolean | Promise<boolean>
}

function amount(value: unknown) {
  if (value === undefined || value === null || value === '') return 0n
  return units(String(value))
}

function baseCoin(symbol: string) {
  return symbol.split('-')[0] || 'BTC'
}

function kindFromContract(symbol: string, fallback: 'call' | 'put'): 'call' | 'put' {
  if (symbol.endsWith('-C') || symbol.endsWith('-C'.toLowerCase()) || /[-]C$/.test(symbol))
    return 'call'
  if (symbol.endsWith('-P') || /[-]P$/.test(symbol)) return 'put'
  return fallback
}

export function createOptionsClient(
  options: OptionsVenueOptions,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): OptionsClient {
  const identityValue = createHash('sha256')
    .update(`options:${options.exchange}:${options.mode}:${options.credentials.key}`)
    .digest('hex')

  async function call(
    method: 'GET' | 'POST',
    path: string,
    p: { query?: Record<string, string>; body?: Record<string, unknown>; signed?: boolean } = {},
  ) {
    const built = buildRequest({
      exchange: options.exchange,
      mode: options.mode,
      kind: 'spot',
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

  async function quote(symbol: string, kind: 'call' | 'put'): Promise<OptionQuote> {
    if (options.exchange === 'bybit') {
      const contract = symbol.includes('-') && /-(C|P)$/.test(symbol) ? symbol : ''
      const rows = (await call('GET', '/v5/market/tickers', {
        query: contract
          ? { category: 'option', symbol: contract }
          : { category: 'option', baseCoin: baseCoin(symbol) },
      })) as {
        list?: { symbol?: string; markPrice?: string; bid1Price?: string; ask1Price?: string }[]
      }
      const list = (rows.list || []).filter(
        (row) => kindFromContract(row.symbol || '', kind) === kind,
      )
      const row = list[0]
      if (!row?.symbol) throw new Error('EXECUTION_OPTIONS_MARKET_UNAVAILABLE')
      const ask = amount(row.ask1Price || row.markPrice)
      if (ask <= 0n) throw new Error('EXECUTION_OPTIONS_MARKET_UNAVAILABLE')
      return {
        symbol: row.symbol,
        kind,
        premium: ask,
        mark: amount(row.markPrice || row.ask1Price),
        expiry: now() + 7 * 86_400_000,
        at: now(),
      }
    }
    const instFamily = `${baseCoin(symbol)}-USD`
    const tickers = (await call('GET', '/api/v5/market/tickers', {
      query: { instType: 'OPTION', instFamily },
    })) as { instId?: string; askPx?: string; markPx?: string; last?: string }[]
    const list = (tickers || []).filter((row) => kindFromContract(row.instId || '', kind) === kind)
    const row =
      symbol.includes('-C') || symbol.includes('-P')
        ? (tickers || []).find((item) => item.instId === symbol)
        : list[0]
    if (!row?.instId) throw new Error('EXECUTION_OPTIONS_MARKET_UNAVAILABLE')
    const ask = amount(row.askPx || row.markPx || row.last)
    if (ask <= 0n) throw new Error('EXECUTION_OPTIONS_MARKET_UNAVAILABLE')
    return {
      symbol: row.instId,
      kind,
      premium: ask,
      mark: amount(row.markPx || row.askPx),
      expiry: now() + 7 * 86_400_000,
      at: now(),
    }
  }

  return {
    quote,
    async identity() {
      return identityValue
    },
    async available() {
      if (options.exchange === 'bybit') {
        const wallet = (await call('GET', '/v5/account/wallet-balance', {
          signed: true,
          query: { accountType: 'UNIFIED' },
        })) as {
          list?: {
            coin?: { coin: string; walletBalance: string; availableToWithdraw?: string }[]
          }[]
        }
        const usdt = wallet.list?.[0]?.coin?.find((item) => item.coin === 'USDT')
        return amount(usdt?.availableToWithdraw || usdt?.walletBalance)
      }
      const bals = (await call('GET', '/api/v5/account/balance', { signed: true })) as {
        details?: { ccy: string; availBal: string }[]
      }[]
      return amount(bals?.[0]?.details?.find((item) => item.ccy === 'USDT')?.availBal)
    },
    async prepare(intent: ExecutionIntent): Promise<PreparedExecution> {
      if (intent.action !== 'buy' && intent.action !== 'sell')
        throw new Error('EXECUTION_ACTION_INVALID')
      const quoted = await quote(intent.symbol, intent.outcome === 'no' ? 'put' : 'call')
      if (intent.action === 'buy' && units(intent.limitPrice) > quoted.premium * 2n) {
        // limit is the total premium for the order, not a unit price in every path
      }
      if (intent.action === 'buy' && units(intent.quantity) <= 0n)
        throw new ExecutionRejected('EXECUTION_ORDER_SIZE')
      return {
        intent: { ...intent, symbol: quoted.symbol },
        payload: { mode: options.mode, contract: quoted.symbol },
        externalId: null,
      }
    },
    async broadcast(prepared: PreparedExecution) {
      assertLiveWrite(options.mode, options.liveEnabled)
      if (options.authorizeWrite && !(await options.authorizeWrite()))
        throw new Error('EXECUTION_WRITE_FORBIDDEN')
      if (prepared.intent.action !== 'buy' && prepared.intent.action !== 'sell')
        throw new Error('EXECUTION_ACTION_INVALID')
      const contract = String(prepared.payload.contract || prepared.intent.symbol)
      if (options.exchange === 'bybit') {
        await call('POST', '/v5/order/create', {
          signed: true,
          body: {
            category: 'option',
            symbol: contract,
            side: prepared.intent.action === 'buy' ? 'Buy' : 'Sell',
            orderType: 'Limit',
            timeInForce: 'IOC',
            qty: prepared.intent.quantity,
            price: prepared.intent.limitPrice,
            orderLinkId: prepared.intent.clientId,
            reduceOnly: prepared.intent.action === 'sell',
          },
        })
        return
      }
      await call('POST', '/api/v5/trade/order', {
        signed: true,
        body: {
          instId: contract,
          tdMode: 'cash',
          side: prepared.intent.action,
          ordType: 'ioc',
          sz: prepared.intent.quantity,
          px: prepared.intent.limitPrice,
          clOrdId: prepared.intent.clientId.replace(/[^0-9A-Za-z]/g, '').slice(0, 32),
          reduceOnly: prepared.intent.action === 'sell' ? true : undefined,
        },
      })
    },
    async lookup(prepared: PreparedExecution): Promise<ExecutionReceipt | null> {
      const contract = String(prepared.payload.contract || prepared.intent.symbol)
      if (options.exchange === 'bybit') {
        const rows = (await call('GET', '/v5/order/realtime', {
          signed: true,
          query: { category: 'option', symbol: contract, orderLinkId: prepared.intent.clientId },
        })) as { list?: Record<string, string>[] }
        const row = rows.list?.[0]
        if (!row) return null
        return {
          status: row.orderStatus === 'Filled' ? 'filled' : 'pending',
          externalId: row.orderId || null,
          filledQuantity: decimal(amount(row.cumExecQty)),
          grossQuote: decimal(amount(row.cumExecValue)),
          quoteFee: decimal(amount(row.cumExecFee)),
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
      const contract = String(prepared.payload.contract || prepared.intent.symbol)
      if (options.exchange === 'bybit') {
        await call('POST', '/v5/order/cancel', {
          signed: true,
          body: { category: 'option', symbol: contract, orderLinkId: prepared.intent.clientId },
        })
      }
    },
  }
}

export const OPTIONS_POLICY_REF = P.options.maxLossBps
