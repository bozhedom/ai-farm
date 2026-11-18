import { createHash } from 'node:crypto'
import { decimal, units } from '../../trading/decimal'
import type { EarnClient } from '../drivers/earn'
import type { ExecutionExchange, ExecutionReceipt } from '../types'
import {
  assertLiveWrite,
  buildRequest,
  requireRetOk,
  sendRequest,
  type RestCredentials,
  type RestMode,
} from './rest'

export type EarnCredentials = RestCredentials

export type EarnVenueOptions = {
  exchange: Exclude<ExecutionExchange, 'bitget'>
  mode: RestMode
  credentials: EarnCredentials
  liveEnabled?: boolean
  authorizeWrite?: () => boolean | Promise<boolean>
}

export function earnProductPath(
  exchange: Exclude<ExecutionExchange, 'bitget'>,
  action: 'subscribe' | 'redeem',
) {
  if (exchange === 'binance')
    return action === 'subscribe'
      ? '/sapi/v1/simple-earn/flexible/subscribe'
      : '/sapi/v1/simple-earn/flexible/redeem'
  if (exchange === 'okx') return '/api/v5/finance/savings/purchase-redempt'
  return '/v5/earn/place-order'
}

export function earnProductListPath(exchange: Exclude<ExecutionExchange, 'bitget'>) {
  if (exchange === 'binance') return '/sapi/v1/simple-earn/flexible/list'
  if (exchange === 'okx') return '/api/v5/finance/savings/lending-rate-summary'
  return '/v5/earn/product'
}

function receipt(id: string | null, amount: bigint): ExecutionReceipt {
  return {
    status: 'filled',
    externalId: id,
    filledQuantity: decimal(amount),
    grossQuote: decimal(amount),
    quoteFee: '0',
    baseFee: '0',
  }
}

function amount(value: unknown) {
  if (value === undefined || value === null || value === '') return 0n
  return units(String(value))
}

function bpsFromRate(value: unknown) {
  const text = String(value ?? '')
  if (!text) return 0
  const asNumber = Number(text)
  if (!Number.isFinite(asNumber)) return 0
  // Bybit/Binance often return APY as 0.05 for 5%; OKX lending rate is similar.
  if (asNumber > 1) return Math.round(asNumber * 100)
  return Math.round(asNumber * 10_000)
}

export function createEarnClient(
  options: EarnVenueOptions,
  fetchImpl?: typeof fetch,
  now?: () => number,
): EarnClient
export function createEarnClient(
  exchange: Exclude<ExecutionExchange, 'bitget'>,
  mode: RestMode,
  credentials: EarnCredentials,
): EarnClient
export function createEarnClient(
  exchangeOrOptions: Exclude<ExecutionExchange, 'bitget'> | EarnVenueOptions,
  modeOrFetch?: RestMode | typeof fetch,
  credentialsOrNow?: EarnCredentials | (() => number),
  maybeFetch?: typeof fetch,
  maybeNow?: () => number,
): EarnClient {
  const options: EarnVenueOptions =
    typeof exchangeOrOptions === 'string'
      ? {
          exchange: exchangeOrOptions,
          mode: modeOrFetch as RestMode,
          credentials: credentialsOrNow as EarnCredentials,
        }
      : exchangeOrOptions
  const fetchImpl =
    (typeof exchangeOrOptions === 'string' ? maybeFetch : (modeOrFetch as typeof fetch)) || fetch
  const now =
    (typeof exchangeOrOptions === 'string' ? maybeNow : (credentialsOrNow as () => number)) ||
    Date.now
  if (options.exchange === 'binance' && options.mode === 'demo') {
    const refuse: EarnClient = {
      async identity() {
        return createHash('sha256')
          .update(`earn:binance:demo:${options.credentials.key}`)
          .digest('hex')
      },
      async available() {
        throw new Error('EXECUTION_EARN_DEMO_UNAVAILABLE')
      },
      async rateBps() {
        throw new Error('EXECUTION_EARN_DEMO_UNAVAILABLE')
      },
      async subscribe() {
        throw new Error('EXECUTION_EARN_DEMO_UNAVAILABLE')
      },
      async redeem() {
        throw new Error('EXECUTION_EARN_DEMO_UNAVAILABLE')
      },
    }
    return refuse
  }

  async function call(
    method: 'GET' | 'POST',
    path: string,
    p: { query?: Record<string, string>; body?: Record<string, unknown>; signed?: boolean } = {},
  ) {
    const built = buildRequest({
      exchange: options.exchange,
      mode: options.mode,
      kind: options.exchange === 'binance' ? 'sapi' : 'spot',
      method,
      path,
      query: p.query,
      body: p.body,
      credentials: options.credentials,
      signed: p.signed ?? true,
      now: now(),
    })
    return requireRetOk(options.exchange, await sendRequest(built, fetchImpl))
  }

  let productId: string | null = null
  let cachedRate = 0

  async function lookupProduct(asset: string) {
    const coin = asset.replace('-USDT', '') || 'USDT'
    if (options.exchange === 'bybit') {
      const rows = (await call('GET', '/v5/earn/product', {
        query: { category: 'FlexibleSaving', coin },
      })) as {
        list?: { productId?: string; coin?: string; latestApr?: string; status?: string }[]
      }
      const row = (rows.list || []).find(
        (item) => item.coin === coin && (item.status || 'Available') !== 'SoldOut',
      )
      if (!row?.productId) throw new Error('EXECUTION_EARN_PRODUCT_UNAVAILABLE')
      productId = row.productId
      cachedRate = bpsFromRate(row.latestApr)
      return row.productId
    }
    if (options.exchange === 'binance') {
      const rows = (await call('GET', '/sapi/v1/simple-earn/flexible/list', {
        query: { asset: coin },
      })) as {
        rows?: {
          productId?: string
          asset?: string
          latestAnnualPercentageRate?: string
          status?: string
        }[]
      }
      const row = (rows.rows || []).find(
        (item) => item.asset === coin && item.status === 'PURCHASING',
      )
      const fallback = (rows.rows || [])[0]
      const chosen = row || fallback
      if (!chosen?.productId) throw new Error('EXECUTION_EARN_PRODUCT_UNAVAILABLE')
      productId = chosen.productId
      cachedRate = bpsFromRate(chosen.latestAnnualPercentageRate)
      return chosen.productId
    }
    const rows = (await call('GET', '/api/v5/finance/savings/lending-rate-summary', {
      query: { ccy: coin },
    })) as {
      ccy?: string
      avgRate?: string
    }[]
    const row = (rows || []).find((item) => item.ccy === coin) || rows?.[0]
    if (!row) throw new Error('EXECUTION_EARN_PRODUCT_UNAVAILABLE')
    productId = coin
    cachedRate = bpsFromRate(row.avgRate)
    return coin
  }

  return {
    async identity() {
      return createHash('sha256')
        .update(`earn:${options.exchange}:${options.mode}:${options.credentials.key}`)
        .digest('hex')
    },
    async available() {
      if (options.exchange === 'bybit') {
        const wallet = (await call('GET', '/v5/account/wallet-balance', {
          query: { accountType: 'UNIFIED' },
        })) as {
          list?: {
            coin?: { coin: string; walletBalance: string; availableToWithdraw?: string }[]
          }[]
        }
        const usdt = wallet.list?.[0]?.coin?.find((item) => item.coin === 'USDT')
        return amount(usdt?.availableToWithdraw || usdt?.walletBalance)
      }
      if (options.exchange === 'okx') {
        const bals = (await call('GET', '/api/v5/account/balance')) as {
          details?: { ccy: string; availBal: string }[]
        }[]
        return amount(bals?.[0]?.details?.find((item) => item.ccy === 'USDT')?.availBal)
      }
      const bals = (await call('GET', '/sapi/v1/capital/config/getall')) as {
        coin?: string
        free?: string
      }[]
      return amount((bals || []).find((item) => item.coin === 'USDT')?.free)
    },
    async rateBps() {
      if (!productId) await lookupProduct('USDT')
      return cachedRate
    },
    async subscribe(asset, qty) {
      assertLiveWrite(options.mode, options.liveEnabled)
      if (options.authorizeWrite && !(await options.authorizeWrite()))
        throw new Error('EXECUTION_WRITE_FORBIDDEN')
      const id = productId || (await lookupProduct(asset))
      const coin = asset.replace('-USDT', '') || 'USDT'
      if (options.exchange === 'bybit') {
        const result = (await call('POST', '/v5/earn/place-order', {
          body: {
            category: 'FlexibleSaving',
            orderType: 'Stake',
            accountType: 'FUND',
            amount: decimal(qty),
            coin,
            productId: id,
          },
        })) as { orderId?: string }
        return receipt(result.orderId || null, qty)
      }
      if (options.exchange === 'okx') {
        const result = (await call('POST', '/api/v5/finance/savings/purchase-redempt', {
          body: { ccy: coin, amt: decimal(qty), side: 'purchase' },
        })) as { ccy?: string }[]
        return receipt(result?.[0]?.ccy || coin, qty)
      }
      const result = (await call('POST', '/sapi/v1/simple-earn/flexible/subscribe', {
        body: { productId: id, amount: decimal(qty) },
      })) as { purchaseId?: string; success?: boolean }
      if (result.success === false) throw new Error('EXECUTION_EXCHANGE_API_ERROR')
      return receipt(result.purchaseId || null, qty)
    },
    async redeem(asset, qty) {
      assertLiveWrite(options.mode, options.liveEnabled)
      if (options.authorizeWrite && !(await options.authorizeWrite()))
        throw new Error('EXECUTION_WRITE_FORBIDDEN')
      const id = productId || (await lookupProduct(asset))
      const coin = asset.replace('-USDT', '') || 'USDT'
      if (options.exchange === 'bybit') {
        const result = (await call('POST', '/v5/earn/place-order', {
          body: {
            category: 'FlexibleSaving',
            orderType: 'Redeem',
            accountType: 'FUND',
            amount: decimal(qty),
            coin,
            productId: id,
          },
        })) as { orderId?: string }
        return receipt(result.orderId || null, qty)
      }
      if (options.exchange === 'okx') {
        await call('POST', '/api/v5/finance/savings/purchase-redempt', {
          body: { ccy: coin, amt: decimal(qty), side: 'redempt' },
        })
        return receipt(coin, qty)
      }
      const result = (await call('POST', '/sapi/v1/simple-earn/flexible/redeem', {
        body: { productId: id, amount: decimal(qty) },
      })) as { redeemId?: string; success?: boolean }
      if (result.success === false) throw new Error('EXECUTION_EXCHANGE_API_ERROR')
      return receipt(result.redeemId || null, qty)
    },
  }
}
