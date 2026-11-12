import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeFunctionResult } from 'viem'
import {
  buildRequest,
  signBinance,
  signBitget,
  signBybit,
  signOkx,
  venueOrigin,
} from '../../core/execution/adapters/rest'
import { createFuturesClient } from '../../core/execution/adapters/futures-venues'
import { createFundingVenue } from '../../core/execution/adapters/funding-venues'
import { createMarginClient } from '../../core/execution/adapters/margin-venues'
import { createEarnClient, earnProductListPath, earnProductPath } from '../../core/execution/adapters/earn-venues'
import { createOptionsClient } from '../../core/execution/adapters/options-venues'
import {
  createUniswapClient,
  encodeExactInputSingle,
  QUOTER_V2_ABI,
  toTokenAtoms,
  UNISWAP_V3,
} from '../../core/execution/adapters/uniswap'
import { executionReady, executionSecret } from '../../core/execution/config'
import type { ExecutionIntent, PreparedExecution } from '../../core/execution/types'
import { decimal, units } from '../../core/trading/decimal'

const now = 1_794_000_000_000
const credentials = { key: 'test-key', secret: 'test-secret', passphrase: 'test-pass' }

function captured() {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({
      url,
      method: String(init?.method || 'GET'),
      headers: Object.fromEntries(Object.entries(init?.headers || {}).map(([key, value]) => [key, String(value)])),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    throw new Error('EXECUTION_NETWORK_UNAVAILABLE')
  }
  return { calls, fetchImpl }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const intent: ExecutionIntent = {
  clientId: 'client-1',
  venue: 'bybit-futures',
  action: 'buy',
  symbol: 'BTC-USDT',
  quantity: '0.001',
  limitPrice: '10000',
  quoteBudget: '20',
  positionQuantity: '0',
  expiresAt: now + 60_000,
  stopPrice: '9850',
  takePrice: '10200',
  leverage: 2,
}

describe('exchange request signing', () => {
  it('signs Bybit, OKX, Binance and Bitget the official way and uses official demo hosts', () => {
    expect(venueOrigin('bybit', 'demo')).toBe('https://api-demo.bybit.com')
    expect(venueOrigin('binance', 'demo', 'futures')).toBe('https://demo-fapi.binance.com')
    expect(venueOrigin('okx', 'demo')).toBe('https://www.okx.com')
    expect(venueOrigin('bitget', 'demo')).toBe('https://api.bitget.com')
    const ts = String(now)
    expect(signBybit('s', ts, 'k', '5000', '{"a":1}')).toBe(
      createHmac('sha256', 's').update(ts + 'k' + '5000' + '{"a":1}').digest('hex'),
    )
    const iso = new Date(now).toISOString()
    expect(signOkx('s', iso, 'POST', '/api/v5/trade/order', '{"x":1}')).toBe(
      createHmac('sha256', 's').update(iso + 'POST' + '/api/v5/trade/order' + '{"x":1}').digest('base64'),
    )
    expect(signBinance('s', 'symbol=BTCUSDT&timestamp=1')).toBe(
      createHmac('sha256', 's').update('symbol=BTCUSDT&timestamp=1').digest('hex'),
    )
    expect(signBitget('s', ts, 'POST', '/api/v2/mix/order/place-order', '{"a":1}')).toBe(
      createHmac('sha256', 's').update(ts + 'POST' + '/api/v2/mix/order/place-order' + '{"a":1}').digest('base64'),
    )
    const okx = buildRequest({
      exchange: 'okx',
      mode: 'demo',
      method: 'POST',
      path: '/api/v5/trade/order',
      body: { instId: 'BTC-USDT-SWAP' },
      credentials,
      signed: true,
      now,
    })
    expect(okx.headers['x-simulated-trading']).toBe('1')
    expect(okx.headers['OK-ACCESS-KEY']).toBe('test-key')
    const bitget = buildRequest({
      exchange: 'bitget',
      mode: 'demo',
      method: 'POST',
      path: '/api/v2/mix/account/set-leverage',
      body: { leverage: '2' },
      credentials,
      signed: true,
      now,
    })
    expect(bitget.headers.paptrading).toBe('1')
    const binance = buildRequest({
      exchange: 'binance',
      mode: 'demo',
      kind: 'futures',
      method: 'POST',
      path: '/fapi/v1/order',
      body: { symbol: 'BTCUSDT', side: 'BUY' },
      credentials,
      signed: true,
      now,
    })
    expect(binance.url).toBe('https://demo-fapi.binance.com/fapi/v1/order')
    expect(binance.body).toContain('signature=')
    expect(binance.body?.endsWith(signBinance('test-secret', binance.body!.replace(/&signature=.+$/, '')))).toBe(true)
  })
})

describe('futures clients', () => {
  it('sets isolated margin and leverage then places a Bybit linear order with SL/TP', async () => {
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      paths.push(`${init?.method}:${url.pathname}`)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      if (url.pathname === '/v5/position/switch-isolated') {
        expect(body).toMatchObject({ category: 'linear', symbol: 'BTCUSDT', tradeMode: 1, buyLeverage: '2', sellLeverage: '2' })
        return json({ retCode: 0, result: {} })
      }
      if (url.pathname === '/v5/position/set-leverage') return json({ retCode: 0, result: {} })
      if (url.pathname === '/v5/order/create') {
        expect(url.host).toBe('api-demo.bybit.com')
        expect(body).toMatchObject({
          category: 'linear',
          symbol: 'BTCUSDT',
          side: 'Buy',
          takeProfit: '10200',
          stopLoss: '9850',
          tpslMode: 'Full',
        })
        return json({ retCode: 0, result: { orderId: '1' } })
      }
      return json({ retCode: 0, result: {} })
    }
    const client = createFuturesClient(
      { mode: 'demo', exchange: 'bybit', credentials, leverage: 2, authorizeWrite: () => true },
      fetchImpl,
      () => now,
    )
    await client.broadcast({ intent, payload: { mode: 'demo' }, externalId: null })
    expect(paths).toEqual(['POST:/v5/position/switch-isolated', 'POST:/v5/position/set-leverage', 'POST:/v5/order/create'])
  })

  it('refuses a live futures write when the live flag is off', async () => {
    const { calls, fetchImpl } = captured()
    const client = createFuturesClient(
      { mode: 'live', exchange: 'okx', credentials, liveEnabled: false, authorizeWrite: () => true },
      fetchImpl,
      () => now,
    )
    await expect(client.broadcast({ intent, payload: {}, externalId: null })).rejects.toThrow('EXECUTION_LIVE_DISABLED')
    expect(calls).toHaveLength(0)
  })
})

describe('funding market and execution', () => {
  it('reads OKX public funding and places an isolated 1x swap hedge', async () => {
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      paths.push(`${init?.method}:${url.pathname}`)
      if (url.pathname === '/api/v5/public/instruments') {
        return json({ code: '0', data: [{ tickSz: '0.1', lotSz: '1', minSz: '1', ctVal: '0.01' }] })
      }
      if (url.pathname === '/api/v5/market/books') {
        return json({ code: '0', data: [{ ts: String(now), bids: [['10000', '1']], asks: [['10001', '1']] }] })
      }
      if (url.pathname === '/api/v5/public/funding-rate') {
        return json({ code: '0', data: [{ fundingRate: '0.0001', fundingTime: String(now + 3_600_000) }] })
      }
      if (url.pathname === '/api/v5/account/set-leverage') {
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({ instId: 'BTC-USDT-SWAP', lever: '1', mgnMode: 'isolated' })
        expect(init?.headers && (init.headers as Record<string, string>)['x-simulated-trading']).toBe('1')
        return json({ code: '0', data: [] })
      }
      if (url.pathname === '/api/v5/trade/order') {
        const body = JSON.parse(String(init?.body))
        expect(body.tdMode).toBe('isolated')
        expect(body.instId).toBe('BTC-USDT-SWAP')
        expect(body.side).toBe('sell')
        return json({ code: '0', data: [{ ordId: '1' }] })
      }
      return json({ code: '0', data: [] })
    }
    const venue = createFundingVenue({ mode: 'demo', exchange: 'okx', credentials, authorizeWrite: () => true }, fetchImpl, () => now)
    const market = await venue.market('BTC-USDT')
    expect(market.fundingRate).toBe(units('0.0001'))
    expect(market.perp.instrument.lot).toBe(units('0.01'))
    await venue.broadcast({
      intent: { ...intent, venue: 'okx-funding', action: 'short', quantity: '0.01' },
      payload: {},
      externalId: null,
    })
    expect(paths).toContain('POST:/api/v5/account/set-leverage')
    expect(paths).toContain('POST:/api/v5/trade/order')
  })
})

describe('spot margin and earn', () => {
  it('builds Bybit borrow and leveraged spot orders', async () => {
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      paths.push(url.pathname)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      if (url.pathname === '/v5/account/borrow') expect(body).toMatchObject({ coin: 'USDT', amount: '10' })
      if (url.pathname === '/v5/order/create') expect(body).toMatchObject({ category: 'spot', isLeverage: 1 })
      return json({ retCode: 0, result: {} })
    }
    const client = createMarginClient({ mode: 'demo', exchange: 'bybit', credentials, leverage: 2, authorizeWrite: () => true }, fetchImpl, () => now)
    await client.broadcast({ intent: { ...intent, action: 'borrow', quantity: '10' }, payload: {}, externalId: null })
    await client.broadcast({ intent, payload: {}, externalId: null })
    expect(paths).toContain('/v5/account/borrow')
    expect(paths).toContain('/v5/spot-margin-trade/set-leverage')
    expect(paths).toContain('/v5/order/create')
  })

  it('looks up a Bybit flexible product and stakes it; Binance demo stays unavailable', async () => {
    expect(earnProductListPath('bybit')).toBe('/v5/earn/product')
    expect(earnProductPath('okx', 'subscribe')).toBe('/api/v5/finance/savings/purchase-redempt')
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/v5/earn/product') {
        expect(url.searchParams.get('category')).toBe('FlexibleSaving')
        return json({ retCode: 0, result: { list: [{ productId: '430', coin: 'USDT', latestApr: '0.05', status: 'Available' }] } })
      }
      if (url.pathname === '/v5/earn/place-order') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          category: 'FlexibleSaving',
          orderType: 'Stake',
          productId: '430',
          coin: 'USDT',
        })
        return json({ retCode: 0, result: { orderId: 'ord-1' } })
      }
      return json({ retCode: 0, result: {} })
    }
    const client = createEarnClient({ exchange: 'bybit', mode: 'demo', credentials, authorizeWrite: () => true }, fetchImpl, () => now)
    const receipt = await client.subscribe('USDT', units('10'))
    expect(receipt.externalId).toBe('ord-1')
    expect(await client.rateBps()).toBe(500)
    const binance = createEarnClient({ exchange: 'binance', mode: 'demo', credentials })
    await expect(binance.subscribe('USDT', units('1'))).rejects.toThrow('EXECUTION_EARN_DEMO_UNAVAILABLE')
  })
})

describe('options and uniswap', () => {
  it('buys a Bybit option and marks a close as reduce-only', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/v5/market/tickers') {
        return json({
          retCode: 0,
          result: { list: [{ symbol: 'BTC-29NOV24-100000-C', markPrice: '1.5', ask1Price: '1.6' }] },
        })
      }
      if (url.pathname === '/v5/order/create') {
        bodies.push(JSON.parse(String(init?.body)))
        return json({ retCode: 0, result: { orderId: '1' } })
      }
      return json({ retCode: 0, result: {} })
    }
    const client = createOptionsClient({ exchange: 'bybit', mode: 'demo', credentials, authorizeWrite: () => true }, fetchImpl, () => now)
    const quote = await client.quote('BTC-USDT', 'call')
    expect(quote.symbol).toBe('BTC-29NOV24-100000-C')
    expect(quote.premium).toBe(units('1.6'))
    const prepared = await client.prepare!({ ...intent, venue: 'bybit-options', action: 'buy', limitPrice: '1.6' })
    await client.broadcast!(prepared)
    await client.broadcast!({ ...prepared, intent: { ...prepared.intent, action: 'sell' } })
    expect(bodies[0]).toMatchObject({ category: 'option', side: 'Buy', reduceOnly: false })
    expect(bodies[1]).toMatchObject({ category: 'option', side: 'Sell', reduceOnly: true })
  })

  it('quotes and encodes a Uniswap V3 swap against official Sepolia pins without broadcasting', async () => {
    expect(UNISWAP_V3.sepolia.swapRouter02).toBe('0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E')
    expect(UNISWAP_V3.sepolia.quoterV2).toBe('0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3')
    const amountOut = toTokenAtoms(units('0.001'), 18)
    const encoded = encodeFunctionResult({
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      result: [amountOut, 0n, 0, 0n],
    })
    const rpc = async (method: string) => {
      if (method === 'eth_call') return encoded
      if (method === 'eth_getTransactionCount') return '0x1'
      if (method === 'eth_gasPrice') return '0x3b9aca00'
      throw new Error(`unexpected ${method}`)
    }
    const client = createUniswapClient(
      {
        rpcUrl: 'http://127.0.0.1:0',
        network: 'sepolia',
        chainId: 11155111,
        sender: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        slippageBps: 30,
      },
      rpc,
      () => now,
    )
    const quote = await client.quote('USDC-USDT', units('10'))
    expect(quote.midOut).toBe(units('0.001'))
    const prepared = await client.prepareSwap!(intent, quote)
    expect(String(prepared.payload.router)).toBe(UNISWAP_V3.sepolia.swapRouter02)
    expect(String(prepared.payload.data)).toBe(
      encodeExactInputSingle({
        tokenIn: UNISWAP_V3.sepolia.usdc,
        tokenOut: UNISWAP_V3.sepolia.weth,
        fee: 500,
        recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        amountIn: toTokenAtoms(units('10'), 6),
        amountOutMinimum: toTokenAtoms(quote.amountOut, 18),
      }),
    )
    const live = createUniswapClient(
      {
        rpcUrl: 'http://127.0.0.1:0',
        network: 'mainnet',
        chainId: 1,
        sender: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        slippageBps: 30,
        liveEnabled: false,
      },
      async () => {
        throw new Error('no-rpc')
      },
    )
    await expect(live.broadcast!({ intent, payload: { rawTransaction: '0xabc' }, externalId: null } satisfies PreparedExecution)).rejects.toThrow(
      'EXECUTION_LIVE_DISABLED',
    )
  })
})

describe('executionReady after adapters landed', () => {
  it('asks for keys instead of leaving tracks pending', () => {
    const names = [
      'EXECUTION_FUTURES_BYBIT_DEMO_API_KEY',
      'EXECUTION_FUTURES_BYBIT_DEMO_SECRET',
      'EXECUTION_OPTIONS_OKX_DEMO_API_KEY',
      'EXECUTION_OPTIONS_OKX_DEMO_SECRET',
      'EXECUTION_OPTIONS_OKX_DEMO_PASSPHRASE',
    ]
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    try {
      for (const name of names) delete process.env[name]
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('EXECUTION_FUTURES_') || key.startsWith('EXECUTION_OPTIONS_') || key.startsWith('EXECUTION_EARN_')) {
          previous[key] = process.env[key]
          delete process.env[key]
        }
      }
      expect(executionReady('futures', 'demo')).toBe('EXECUTION_CREDENTIALS_REQUIRED')
      expect(executionReady('options', 'demo')).toBe('EXECUTION_CREDENTIALS_REQUIRED')
      expect(executionReady('earn', 'demo')).toBe('EXECUTION_CREDENTIALS_REQUIRED')
      process.env.EXECUTION_FUTURES_BYBIT_DEMO_API_KEY = 'k'
      process.env.EXECUTION_FUTURES_BYBIT_DEMO_SECRET = 's'
      expect(executionReady('futures', 'demo')).toBe('')
      process.env.EXECUTION_OPTIONS_OKX_DEMO_API_KEY = 'k'
      process.env.EXECUTION_OPTIONS_OKX_DEMO_SECRET = 's'
      expect(executionReady('options', 'demo')).toBe('EXECUTION_CREDENTIALS_REQUIRED')
      process.env.EXECUTION_OPTIONS_OKX_DEMO_PASSPHRASE = 'p'
      expect(executionReady('options', 'demo')).toBe('')
      expect(executionSecret('FUTURES_BYBIT_DEMO_API_KEY')).toBe('k')
    } finally {
      for (const name of Object.keys(previous)) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
      delete process.env.EXECUTION_FUTURES_BYBIT_DEMO_API_KEY
      delete process.env.EXECUTION_FUTURES_BYBIT_DEMO_SECRET
      delete process.env.EXECUTION_OPTIONS_OKX_DEMO_API_KEY
      delete process.env.EXECUTION_OPTIONS_OKX_DEMO_SECRET
      delete process.env.EXECUTION_OPTIONS_OKX_DEMO_PASSPHRASE
      for (const name of Object.keys(previous)) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
    }
  })
})
