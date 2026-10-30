import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../core/config'
import { BybitVenue } from '../../core/trading/bybit'
import { assertBybitSpotPermissions } from '../../core/trading/bybit-policy'

const original = { ...config() }
afterEach(() => Object.assign(config(), original))

describe('Bybit spot credential scope', () => {
  it('permits only SpotTrade and the exact optional legacy permission', () => {
    expect(() => assertBybitSpotPermissions({ Spot: ['SpotTrade'] }, true)).not.toThrow()
    expect(() =>
      assertBybitSpotPermissions(
        { Spot: ['SpotTrade'], Derivatives: ['DerivativesTrade'], Wallet: [], Options: [] },
        true,
      ),
    ).not.toThrow()
  })

  it.each<Record<string, string[]>>([
    {},
    { Derivatives: ['DerivativesTrade'] },
    { Spot: ['SpotTrade', 'Other'] },
    { Spot: ['SpotTrade'], Derivatives: ['Other'] },
    { Spot: ['SpotTrade'], Derivatives: ['DerivativesTrade', 'Other'] },
    ...['Withdraw', 'AccountTransfer', 'SubMemberTransfer'].map((p) => ({
      Spot: ['SpotTrade'],
      Derivatives: ['DerivativesTrade'],
      Wallet: [p],
    })),
    ...['ContractTrade', 'Options', 'Earn', 'FutureUnknownPermission'].map((group) => ({
      Spot: ['SpotTrade'],
      [group]: ['Trade'],
    })),
  ])('refuses missing spot access and unrelated permissions: %j', (permissions) => {
    expect(() => assertBybitSpotPermissions(permissions, true)).toThrow('TRADING_KEY_PERMISSIONS')
  })
})

const cashOrder = {
  category: 'spot',
  symbol: 'BTCUSDT',
  side: 'Buy',
  orderType: 'Limit',
  qty: '0.0001',
  price: '80000',
  timeInForce: 'IOC',
  isLeverage: 0,
  orderLinkId: 'farm-test-1',
}
// Deliberately exercise the private signing boundary: even an internal caller cannot evade it.
type SigningBoundary = {
  request(
    path: string,
    params: Record<string, string>,
    body?: Record<string, unknown>,
    privateCall?: boolean,
  ): Promise<unknown>
}
const boundary = (transport: typeof fetch) =>
  new BybitVenue('live', transport) as unknown as SigningBoundary

describe('Bybit spot requests are fenced before signing or sending', () => {
  it.each([
    ['category', 'linear'],
    ['category', 'inverse'],
    ['category', 'option'],
    ['isLeverage', 1],
    ['isLeverage', '0'],
    ['orderType', 'Market'],
    ['timeInForce', 'GTC'],
    ['qty', '0'],
    ['qty', '-1'],
    ['price', '0'],
    ['symbol', 'BTCUSD'],
    ['triggerPrice', '1'],
    ['takeProfit', '1'],
    ['reduceOnly', true],
  ])('blocks order field %s=%s without contacting Bybit', async (field, value) => {
    const transport = vi.fn<typeof fetch>()
    await expect(
      boundary(transport).request('/v5/order/create', {}, { ...cashOrder, [field]: value }, true),
    ).rejects.toThrow('TRADING_BYBIT_REQUEST_FORBIDDEN')
    expect(transport).not.toHaveBeenCalled()
  })

  it.each([
    '/v5/position/set-leverage',
    '/v5/asset/withdraw/create',
    '/v5/asset/transfer/inter-transfer',
    '/v5/spot-margin-trade/switch-mode',
    '/v5/user/update-api',
    '/v5/order/create?category=linear',
  ])('blocks unsupported endpoint %s', async (path) => {
    const transport = vi.fn<typeof fetch>()
    await expect(boundary(transport).request(path, {}, cashOrder, true)).rejects.toThrow(
      'TRADING_BYBIT_REQUEST_FORBIDDEN',
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses request-method, authentication and query/body substitutions', async () => {
    const transport = vi.fn<typeof fetch>(),
      venue = boundary(transport)
    for (const args of [
      ['/v5/order/create', {}, undefined, true],
      ['/v5/order/create', {}, cashOrder, false],
      ['/v5/order/create', { category: 'linear' }, cashOrder, true],
      ['/v5/account/info', {}, {}, true],
      ['/v5/order/realtime', { category: 'linear', openOnly: '0', limit: '50' }, undefined, true],
      [
        '/v5/order/cancel',
        {},
        { category: 'linear', symbol: 'BTCUSDT', orderLinkId: 'farm-test-1' },
        true,
      ],
      ['/v5/market/time', {}, undefined, true],
    ] as const) {
      await expect(venue.request(args[0], args[1], args[2], args[3])).rejects.toThrow(
        'TRADING_BYBIT_REQUEST_FORBIDDEN',
      )
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('keeps the Live flag at the signing boundary, while permitting cancellation of a spot order', async () => {
    Object.assign(config(), {
      TRADING_LIVE_ENABLED: false,
      BYBIT_LIVE_API_KEY: 'test-key',
      BYBIT_LIVE_SECRET: 'test-secret',
    })
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ retCode: 0, result: {} })))
    const venue = boundary(transport)
    await expect(venue.request('/v5/order/create', {}, cashOrder, true)).rejects.toThrow(
      'TRADING_LIVE_DISABLED',
    )
    expect(transport).not.toHaveBeenCalled()
    await venue.request(
      '/v5/order/cancel',
      {},
      { category: 'spot', symbol: 'BTCUSDT', orderLinkId: 'farm-test-1' },
      true,
    )
    expect(transport).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body))).toEqual({
      category: 'spot',
      symbol: 'BTCUSDT',
      orderLinkId: 'farm-test-1',
    })
  })
})
