import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../core/config'
import { units } from '../../core/trading/decimal'
import { OkxVenue, signature } from '../../core/trading/okx'
import type { OrderRequest } from '../../core/trading/types'

const request: OrderRequest = {
  clientId: 'testorder001',
  symbol: 'BTC-USDT',
  side: 'buy',
  qty: units('0.0001'),
  price: units('80000'),
}
const original = { ...config() }
function configure() {
  Object.assign(config(), {
    OKX_DEMO_API_KEY: 'demo-key',
    OKX_DEMO_SECRET: 'demo-secret',
    OKX_DEMO_PASSPHRASE: 'demo-pass',
    OKX_LIVE_API_KEY: 'live-key',
    OKX_LIVE_SECRET: 'live-secret',
    OKX_LIVE_PASSPHRASE: 'live-pass',
    TRADING_LIVE_ENABLED: true,
  })
}
const response = (data: unknown[], code = '0') =>
  new Response(JSON.stringify({ code, data }), { status: 200 })
afterEach(() => {
  Object.assign(config(), original)
  vi.restoreAllMocks()
})

describe('OKX wire contract', () => {
  it('signs the exact method, path/query and JSON bytes', () => {
    const stamp = '2026-10-12T00:00:00.000Z',
      path = '/api/v5/trade/order?instId=BTC-USDT&clOrdId=x'
    expect(signature('secret', stamp, 'GET', path)).toBe(
      createHmac('sha256', 'secret')
        .update(stamp + 'GET' + path)
        .digest('base64'),
    )
  })

  it('keeps demo and live credentials/headers separate and sends only cash IOC orders', async () => {
    configure()
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        response([{ sCode: '0', clOrdId: request.clientId, ordId: '1' }]),
      )
    await new OkxVenue('demo', transport).place(request)
    const [url, options] = transport.mock.calls[0]!
    expect(String(url)).toBe('https://openapi.okx.com/api/v5/trade/order')
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'OK-ACCESS-KEY': 'demo-key', 'x-simulated-trading': '1' },
    })
    expect(JSON.parse(String(options!.body))).toEqual({
      instId: 'BTC-USDT',
      tdMode: 'cash',
      clOrdId: 'testorder001',
      side: 'buy',
      ordType: 'ioc',
      sz: '0.0001',
      px: '80000',
    })
    expect((options!.headers as Record<string, string>).expTime).toMatch(/^\d{13}$/)
    await new OkxVenue('live', transport).place(request)
    const headers = transport.mock.calls[1]![1]!.headers as Record<string, string>
    expect(headers['OK-ACCESS-KEY']).toBe('live-key')
    expect(headers['x-simulated-trading']).toBeUndefined()
    config().OKX_DEMO_API_KEY = ''
    const count = transport.mock.calls.length
    await expect(new OkxVenue('demo', transport).place(request)).rejects.toThrow(
      'TRADING_ORDER_UNKNOWN',
    )
    expect(transport.mock.calls).toHaveLength(count)
  })

  it('treats HTTP errors and duplicate IDs as unknown; never exposes a server message', async () => {
    configure()
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('secret-key-in-message', { status: 503 }))
    await expect(new OkxVenue('demo', transport).place(request)).rejects.toThrow(
      'TRADING_ORDER_UNKNOWN',
    )
    transport.mockResolvedValue(
      response([{ sCode: '51016', clOrdId: request.clientId, ordId: '' }]),
    )
    await expect(new OkxVenue('demo', transport).place(request)).rejects.toThrow(
      'TRADING_ORDER_UNKNOWN',
    )
    expect(transport).toHaveBeenCalledTimes(2)
    transport.mockResolvedValue(
      response([{ sCode: '51008', clOrdId: request.clientId, ordId: '' }]),
    )
    await expect(new OkxVenue('demo', transport).place(request)).rejects.toThrow(
      'TRADING_ORDER_REJECTED',
    )
  })

  it('sums actual fills, verifies identity and accounts for the fee currency', async () => {
    configure()
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('/trade/order?'))
        return response([
          {
            instId: 'BTC-USDT',
            clOrdId: request.clientId,
            ordId: '123',
            side: 'buy',
            tdMode: 'cash',
            ordType: 'ioc',
            sz: '0.0001',
            px: '80000',
            accFillSz: '0.0001',
            state: 'canceled',
          },
        ])
      return response([
        {
          instId: 'BTC-USDT',
          ordId: '123',
          tradeId: 'a',
          side: 'buy',
          fillPx: '79999',
          fillSz: '0.00006',
          fee: '-0.00000006',
          feeCcy: 'BTC',
        },
        {
          instId: 'BTC-USDT',
          ordId: '123',
          tradeId: 'b',
          side: 'buy',
          fillPx: '80000',
          fillSz: '0.00004',
          fee: '-0.00000004',
          feeCcy: 'BTC',
        },
      ])
    })
    expect(await new OkxVenue('demo', transport).order(request)).toMatchObject({
      state: 'canceled',
      filledQty: units('0.0001'),
      quote: units('7.99994'),
      baseFee: units('-0.0000001'),
      quoteFee: 0n,
    })
    await expect(
      new OkxVenue('demo', transport).order({ ...request, qty: units('0.0002') }),
    ).rejects.toThrow('TRADING_ORDER_MISMATCH')
  })

  it('refuses an incomplete or duplicate fill history instead of estimating an average price', async () => {
    configure()
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).includes('/trade/order?')
        ? response([
            {
              instId: 'BTC-USDT',
              clOrdId: request.clientId,
              ordId: '123',
              side: 'buy',
              tdMode: 'cash',
              ordType: 'ioc',
              sz: '0.0001',
              px: '80000',
              accFillSz: '0.0001',
              state: 'filled',
            },
          ])
        : response([
            {
              instId: 'BTC-USDT',
              ordId: '123',
              tradeId: 'a',
              side: 'buy',
              fillPx: '80000',
              fillSz: '0.00005',
              fee: '0',
              feeCcy: 'BTC',
            },
          ]),
    )
    await expect(new OkxVenue('demo', transport).order(request)).rejects.toThrow(
      'TRADING_FILLS_INCOMPLETE',
    )
  })

  it('rejects keys with withdrawals, live keys without IP binding, margin modes and debt', async () => {
    configure()
    const account = { uid: 'uid', perm: 'read_only,trade', acctLv: '1', ip: '203.0.113.1' }
    const balance = { details: [{ ccy: 'USDT', cashBal: '100', availBal: '100', liab: '0' }] }
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/time')) return response([{ ts: String(Date.now()) }])
      if (path.endsWith('/config')) return response([account])
      if (path.endsWith('/positions')) return response([])
      if (path.endsWith('/balance')) return response([balance])
      if (path.endsWith('/trade-fee')) return response([{ feeGroup: [{ taker: '-0.001' }] }])
      throw new Error('UNEXPECTED_PATH')
    })
    const venue = new OkxVenue('live', transport)
    expect((await venue.account()).balances.USDT.available).toBe(units('100'))
    account.perm = 'read_only,trade,withdraw'
    await expect(venue.account()).rejects.toThrow('TRADING_KEY_PERMISSIONS')
    account.perm = 'read_only,trade'
    account.ip = ''
    await expect(venue.account()).rejects.toThrow('TRADING_IP_REQUIRED')
    account.ip = '203.0.113.1'
    account.acctLv = '4'
    await expect(venue.account()).rejects.toThrow('TRADING_ACCOUNT_MODE')
    account.acctLv = '1'
    balance.details[0]!.liab = '1'
    await expect(venue.account()).rejects.toThrow('TRADING_DEBT_FORBIDDEN')
  })
})
