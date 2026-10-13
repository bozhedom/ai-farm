import { constants, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  KalshiExecutionAdapter,
  KalshiExecutionVenue,
  kalshiClientOrderId,
  kalshiSignature,
  type KalshiOrderIntent,
  type KalshiSettings,
} from '../../core/execution/adapters/kalshi'
import { ExecutionRejected, type ExecutionIntent } from '../../core/execution/types'

const instant = Date.parse('2026-10-13T00:00:00Z')
const keys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const settings: KalshiSettings = {
  mode: 'demo',
  keyId: 'test-key-id',
  privateKey,
  accountId: 'owner-user-id',
  liveEnabled: false,
  eligibilityConfirmed: false,
  subaccount: 2,
  maxQuoteAgeMs: 5000,
  requestTimeoutMs: 7000,
  maxPages: 3,
}
const intent: KalshiOrderIntent = {
  id: 'durable-execution-step',
  ticker: 'KXEXAMPLE-26OCT13-T100',
  outcome: 'yes',
  action: 'buy',
  quantity: '1.25',
  limitPrice: '0.5000',
  maxSpend: '1.00',
  feeReserve: '0.375',
  ownedQuantity: '0',
}
const engineIntent: ExecutionIntent = {
  clientId: intent.id,
  venue: 'kalshi',
  action: 'buy',
  symbol: intent.ticker,
  quantity: intent.quantity,
  limitPrice: intent.limitPrice,
  quoteBudget: intent.maxSpend,
  positionQuantity: '0',
  outcome: 'yes',
  expiresAt: instant + 5000,
}
const market = {
  ticker: intent.ticker,
  event_ticker: 'KXEXAMPLE-26OCT13',
  market_type: 'binary',
  status: 'active',
  open_time: new Date(instant - 10000).toISOString(),
  close_time: new Date(instant + 86400000).toISOString(),
  notional_value_dollars: '1.0000',
  price_ranges: [{ start: '0.0000', end: '1.0000', step: '0.0100' }],
}
const book = {
  orderbook_fp: {
    yes_dollars: [['0.4900', '100.25']],
    no_dollars: [['0.5000', '200.50']],
  },
}
const position = {
  ticker: intent.ticker,
  position_fp: '2.50',
  market_exposure_dollars: '1.2500',
  realized_pnl_dollars: '-0.020001',
  fees_paid_dollars: '0.010007',
  last_updated_ts: new Date(instant).toISOString(),
}
const clientId = kalshiClientOrderId('demo', intent.id)
const order = {
  order_id: 'exchange-order-id',
  user_id: 'owner-user-id',
  client_order_id: clientId,
  ticker: intent.ticker,
  book_side: 'bid',
  status: 'canceled',
  yes_price_dollars: '0.5000',
  no_price_dollars: '0.5000',
  fill_count_fp: '0.75',
  remaining_count_fp: '0.00',
  initial_count_fp: '1.25',
  taker_fees_dollars: '0.010007',
  maker_fees_dollars: '0.000000',
  subaccount_number: 2,
}
const fill = {
  fill_id: 'fill-1',
  order_id: order.order_id,
  ticker: intent.ticker,
  book_side: 'bid',
  count_fp: '0.75',
  yes_price_dollars: '0.5000',
  no_price_dollars: '0.5000',
  fee_cost: '0.010007',
  created_time: new Date(instant).toISOString(),
  subaccount_number: 2,
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

function mockApi(
  overrides: Record<string, unknown | ((url: URL, options: RequestInit) => unknown)> = {},
) {
  return vi.fn<typeof fetch>().mockImplementation(async (raw, options = {}) => {
    const url = new URL(String(raw))
    const path = url.pathname.replace('/trade-api/v2', '')
    const routes: Record<string, unknown> = {
      [`/markets/${intent.ticker}`]: { market },
      [`/markets/${intent.ticker}/orderbook`]: book,
      '/exchange/status': { exchange_active: true, trading_active: true },
      '/portfolio/balance': { balance_dollars: '100.0000' },
      '/api_keys': {
        api_keys: [
          {
            api_key_id: settings.keyId,
            scopes: ['read', 'write::trade'],
            subaccount: settings.subaccount,
          },
        ],
      },
      '/portfolio/positions': { market_positions: [], cursor: '' },
      '/portfolio/orders': { orders: [order], cursor: '' },
      [`/portfolio/orders/${order.order_id}`]: { order },
      '/portfolio/fills': { fills: [fill], cursor: '' },
      '/historical/fills': { fills: [], cursor: '' },
      '/historical/orders': { orders: [], cursor: '' },
      '/portfolio/events/orders': {
        order_id: order.order_id,
        client_order_id: clientId,
        fill_count: '0.75',
        remaining_count: '0.00',
      },
    }
    let data = Object.hasOwn(overrides, path) ? overrides[path] : routes[path]
    if (typeof data === 'function') data = data(url, options)
    if (data instanceof Error) throw data
    if (data instanceof Response) return data
    if (data === undefined) throw new Error(`Unexpected test URL: ${path}`)
    return response(data)
  })
}

describe('Kalshi current V2 execution', () => {
  it('signs exactly timestamp + method + path with RSA-PSS SHA256 and digest salt', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const signature = kalshiSignature(
      pem,
      '123456789',
      'get',
      '/trade-api/v2/portfolio/orders?limit=100',
    )
    expect(
      verify(
        'sha256',
        Buffer.from('123456789GET/trade-api/v2/portfolio/orders'),
        {
          key: rsa.publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true)
    expect(() => kalshiSignature('private material', '1', 'GET', '/')).toThrow(
      'EXECUTION_KALSHI_KEY_INVALID',
    )
  })

  it('supports the current default Ed25519 keys and keeps demo/live IDs distinct', () => {
    const signature = kalshiSignature(
      privateKey,
      '123',
      'GET',
      '/trade-api/v2/portfolio/balance?subaccount=2',
    )
    expect(
      verify(
        null,
        Buffer.from('123GET/trade-api/v2/portfolio/balance'),
        keys.publicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true)
    expect(kalshiClientOrderId('demo', intent.id)).toBe(clientId)
    expect(kalshiClientOrderId('live', intent.id)).not.toBe(clientId)
  })

  it('prepares read-only, then submits one fractional fixed-point IOC to the demo V2 endpoint', async () => {
    const transport = mockApi()
    const venue = new KalshiExecutionVenue(settings, transport, () => instant)
    const prepared = await venue.prepare(intent)
    expect(transport.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true)
    await venue.broadcast(prepared)
    const [raw, options] = transport.mock.calls.at(-1)!
    expect(String(raw)).toBe(
      'https://external-api.demo.kalshi.co/trade-api/v2/portfolio/events/orders',
    )
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = options!.headers as Record<string, string>
    expect(headers['KALSHI-ACCESS-KEY']).toBe(settings.keyId)
    expect(JSON.parse(String(options!.body))).toEqual({
      ticker: intent.ticker,
      client_order_id: clientId,
      side: 'bid',
      count: '1.25',
      price: '0.5000',
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      cancel_order_on_pause: true,
      reduce_only: false,
      subaccount: 2,
    })
    expect(JSON.stringify(prepared)).not.toContain(privateKey)
  })

  it('converts buy NO to a YES ask and supports sub-cent dynamic price ranges', async () => {
    const transport = mockApi({
      [`/markets/${intent.ticker}`]: {
        market: { ...market, price_ranges: [{ start: '0', end: '1', step: '0.0001' }] },
      },
      [`/markets/${intent.ticker}/orderbook`]: {
        orderbook_fp: { yes_dollars: [['0.4999', '2.50']], no_dollars: [] },
      },
    })
    const prepared = await new KalshiExecutionVenue(settings, transport, () => instant).prepare({
      ...intent,
      outcome: 'no',
      limitPrice: '0.5001',
      maxSpend: '1.01',
    })
    expect(prepared.body).toMatchObject({
      side: 'ask',
      price: '0.4999',
      count: '1.25',
      reduce_only: false,
    })
  })

  it('exits only locally owned contracts with native reduce_only', async () => {
    const transport = mockApi({
      '/portfolio/positions': { market_positions: [position], cursor: '' },
    })
    const venue = new KalshiExecutionVenue(settings, transport, () => instant)
    const sell = { ...intent, action: 'sell' as const, limitPrice: '0.49', ownedQuantity: '1.25' }
    const prepared = await venue.prepare(sell)
    expect(prepared.body).toMatchObject({ side: 'ask', price: '0.4900', reduce_only: true })
    await expect(venue.prepare({ ...sell, ownedQuantity: '1.24' })).rejects.toThrow(
      'INSUFFICIENT_POSITION',
    )
    await expect(venue.prepare({ ...sell, outcome: 'no', limitPrice: '0.50' })).rejects.toThrow(
      'INSUFFICIENT_POSITION',
    )
  })

  it('does not interpret an opposite holding as cash for a new bet', async () => {
    const transport = mockApi({
      '/portfolio/positions': {
        market_positions: [{ ...position, position_fp: '-2.50' }],
        cursor: '',
      },
    })
    await expect(
      new KalshiExecutionVenue(settings, transport, () => instant).prepare(intent),
    ).rejects.toThrow('OPPOSITE_POSITION')
  })

  it('blocks live before any HTTP unless both explicit enablement and eligibility are present', async () => {
    const transport = mockApi()
    for (const overrides of [
      { liveEnabled: false, eligibilityConfirmed: true },
      { liveEnabled: true, eligibilityConfirmed: false },
    ]) {
      await expect(
        new KalshiExecutionVenue(
          { ...settings, ...overrides, mode: 'live' },
          transport,
          () => instant,
        ).prepare(intent),
      ).rejects.toThrow(/LIVE_DISABLED|ELIGIBILITY_REQUIRED/)
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('fails closed on off-grid, fractional precision, shallow depth and insufficient cost reserve', async () => {
    const venue = new KalshiExecutionVenue(settings, mockApi(), () => instant)
    await expect(venue.prepare({ ...intent, limitPrice: '0.5001' })).rejects.toThrow(
      'OFF_GRID_PRICE',
    )
    await expect(venue.prepare({ ...intent, quantity: '1.251' })).rejects.toThrow(
      'RESPONSE_INVALID',
    )
    await expect(venue.prepare({ ...intent, maxSpend: '0.999999' })).rejects.toThrow(
      'BUDGET_EXCEEDED',
    )
    await expect(
      venue.prepare({ ...intent, quantity: '201', maxSpend: '200', feeReserve: '1' }),
    ).rejects.toThrow(/INSUFFICIENT_BALANCE|INSUFFICIENT_DEPTH/)
    const shallow = new KalshiExecutionVenue(
      settings,
      mockApi({
        [`/markets/${intent.ticker}/orderbook`]: {
          orderbook_fp: { yes_dollars: [], no_dollars: [['0.5000', '1.24']] },
        },
      }),
      () => instant,
    )
    await expect(shallow.prepare(intent)).rejects.toThrow('INSUFFICIENT_DEPTH')
  })

  it('rejects paused, closing and crossed markets', async () => {
    for (const overrides of [
      { '/exchange/status': { exchange_active: true, trading_active: false } },
      {
        [`/markets/${intent.ticker}`]: {
          market: { ...market, close_time: new Date(instant + 4999).toISOString() },
        },
      },
      {
        [`/markets/${intent.ticker}/orderbook`]: {
          orderbook_fp: { yes_dollars: [['0.5000', '2.00']], no_dollars: [['0.5000', '2.00']] },
        },
      },
    ])
      await expect(
        new KalshiExecutionVenue(settings, mockApi(overrides), () => instant).prepare(intent),
      ).rejects.toThrow(/EXCHANGE_PAUSED|MARKET_CLOSED|BOOK_CROSSED/)
  })

  it('does not retry an uncertain submit and recovers the same client ID after restart', async () => {
    const transport = mockApi({ '/portfolio/events/orders': new Error('secret transport details') })
    const adapter = new KalshiExecutionAdapter(settings, transport, () => instant)
    const prepared = await adapter.prepare(engineIntent)
    await expect(adapter.broadcast(prepared)).rejects.toThrow('EXECUTION_KALSHI_SUBMISSION_UNKNOWN')
    expect(transport.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    const restored = JSON.parse(JSON.stringify(prepared))
    const receipt = await new KalshiExecutionAdapter(settings, transport, () => instant).lookup(
      restored,
    )
    expect(receipt).toEqual({
      status: 'cancelled',
      externalId: order.order_id,
      filledQuantity: '0.75',
      grossQuote: '0.375',
      quoteFee: '0.010007',
      baseFee: '0',
    })
  })

  it('maps only definitive rejections to ExecutionRejected and sanitizes access errors', async () => {
    const transport = mockApi({
      '/portfolio/events/orders': () => response({ secret: privateKey }, 400),
    })
    const adapter = new KalshiExecutionAdapter(settings, transport, () => instant)
    await expect(adapter.broadcast(await adapter.prepare(engineIntent))).rejects.toBeInstanceOf(
      ExecutionRejected,
    )
    const denied = mockApi({ '/portfolio/balance': () => response({ secret: privateKey }, 451) })
    await expect(
      new KalshiExecutionVenue(settings, denied, () => instant).balance(),
    ).rejects.toThrow(/^EXECUTION_KALSHI_ACCESS_RESTRICTED$/)
  })

  it('will not send stale or tampered durable payloads', async () => {
    let now = instant
    const transport = mockApi()
    const adapter = new KalshiExecutionAdapter(settings, transport, () => now)
    const prepared = await adapter.prepare(engineIntent)
    now += 5001
    await expect(adapter.broadcast(prepared)).rejects.toThrow('QUOTE_STALE')
    now = instant
    const tampered = structuredClone(prepared)
    tampered.intent.quoteBudget = '1000'
    await expect(adapter.broadcast(tampered)).rejects.toThrow('PREPARED_MISMATCH')
    expect(transport.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })

  it('reconciles full fractional fills and six-decimal fees without floating-point loss', async () => {
    const transport = mockApi({
      '/portfolio/orders': {
        orders: [
          { ...order, status: 'executed', fill_count_fp: '1.25', taker_fees_dollars: '0.010009' },
        ],
        cursor: '',
      },
      '/portfolio/fills': {
        fills: [
          { ...fill, count_fp: '1.00', fee_cost: '0.010007' },
          { ...fill, fill_id: 'fill-2', count_fp: '0.25', fee_cost: '0.000002' },
        ],
        cursor: '',
      },
    })
    const venue = new KalshiExecutionVenue(settings, transport, () => instant)
    expect(await venue.lookup(await venue.prepare(intent))).toMatchObject({
      state: 'filled',
      filledQuantity: '1.25',
      grossAmount: '0.625',
      feeAmount: '0.010009',
      cashDelta: '-0.635009',
    })
  })

  it('never marks a delayed fill/fee reconciliation as completed', async () => {
    const transport = mockApi({ '/portfolio/fills': { fills: [], cursor: '' } })
    const venue = new KalshiExecutionVenue(settings, transport, () => instant)
    expect(await venue.lookup(await venue.prepare(intent))).toMatchObject({
      state: 'pending',
      filledQuantity: '0',
    })
    const missing = new KalshiExecutionVenue(
      settings,
      mockApi({ '/portfolio/orders': { orders: [], cursor: '' } }),
      () => instant,
    )
    expect(await missing.lookup(await missing.prepare(intent))).toMatchObject({ state: 'unknown' })
  })

  it('retains confirmed fills while waiting for the matching cumulative fee total', async () => {
    const transport = mockApi({
      '/portfolio/orders': {
        orders: [{ ...order, taker_fees_dollars: '0.020000' }],
        cursor: '',
      },
    })
    const venue = new KalshiExecutionVenue(settings, transport, () => instant)
    expect(await venue.lookup(await venue.prepare(intent))).toMatchObject({
      state: 'pending',
      filledQuantity: '0.75',
      grossAmount: '0.375',
      feeAmount: '0.010007',
      cashDelta: '-0.385007',
    })
  })

  it('checks fill identity, account, complement, price and quantity', async () => {
    for (const bad of [
      { ...fill, subaccount_number: 3 },
      { ...fill, order_id: 'unrelated' },
      { ...fill, yes_price_dollars: '0.6000', no_price_dollars: '0.4000' },
      { ...fill, no_price_dollars: '0.4000' },
      { ...fill, count_fp: '1.50' },
    ]) {
      const venue = new KalshiExecutionVenue(
        settings,
        mockApi({ '/portfolio/fills': { fills: [bad], cursor: '' } }),
        () => instant,
      )
      await expect(venue.lookup(await venue.prepare(intent))).rejects.toThrow(
        /FILL_MISMATCH|FILL_PRICE_MISMATCH/,
      )
    }
  })

  it('reads archived orders/fills and deduplicates identical fills across the handoff', async () => {
    const transport = mockApi({
      '/portfolio/orders': { orders: [], cursor: '' },
      '/historical/orders': { orders: [order], cursor: '' },
      '/portfolio/fills': { fills: [], cursor: '' },
      '/historical/fills': { fills: [fill, fill], cursor: '' },
    })
    const venue = new KalshiExecutionVenue(settings, transport, () => instant)
    expect(await venue.lookup(await venue.prepare(intent))).toMatchObject({
      state: 'canceled',
      feeAmount: '0.010007',
    })
  })

  it('reports confirmed fee overruns to the ledger instead of losing accepted fills', async () => {
    const transport = mockApi({
      '/portfolio/orders': { orders: [{ ...order, taker_fees_dollars: '0.5' }], cursor: '' },
      '/portfolio/fills': { fills: [{ ...fill, fee_cost: '0.5' }], cursor: '' },
    })
    const adapter = new KalshiExecutionAdapter(settings, transport, () => instant)
    expect(await adapter.lookup(await adapter.prepare(engineIntent))).toMatchObject({
      status: 'cancelled',
      quoteFee: '0.5',
      filledQuantity: '0.75',
    })
  })

  it('fails closed when history is truncated or a cursor repeats', async () => {
    const repeated = new KalshiExecutionVenue(
      settings,
      mockApi({ '/portfolio/positions': { market_positions: [], cursor: 'same' } }),
      () => instant,
    )
    await expect(repeated.positions(intent.ticker)).rejects.toThrow('PAGINATION_INVALID')
    let cursor = 0
    const truncated = new KalshiExecutionVenue(
      { ...settings, maxPages: 2 },
      mockApi({
        '/portfolio/positions': () => ({ market_positions: [], cursor: String(++cursor) }),
      }),
      () => instant,
    )
    await expect(truncated.positions(intent.ticker)).rejects.toThrow('HISTORY_INCOMPLETE')
  })

  it('reads signed positions and actual settlement receipts, never predicted payouts', async () => {
    const transport = mockApi({
      '/portfolio/positions': {
        market_positions: [{ ...position, position_fp: '-2.50' }],
        cursor: '',
      },
      '/portfolio/settlements': {
        settlements: [
          {
            ticker: intent.ticker,
            exchange_index: 1,
            market_result: 'no',
            yes_count_fp: '0.00',
            no_count_fp: '2.50',
            yes_total_cost_dollars: '0.0000',
            no_total_cost_dollars: '1.2500',
            revenue: 250,
            fee_cost: '0.010007',
            settled_time: new Date(instant).toISOString(),
          },
        ],
        cursor: '',
      },
    })
    const venue = new KalshiExecutionVenue(settings, transport, () => instant)
    expect(await venue.positions(intent.ticker)).toMatchObject([
      { signedQuantity: '-2.5', realizedPnl: '-0.020001' },
    ])
    expect(await venue.settlements(intent.ticker)).toMatchObject([
      { yesQuantity: '0', noQuantity: '2.5', cost: '1.25', revenue: '2.5', fees: '0.010007' },
    ])
  })

  it('verifies the owner identity and restricted trading key independently of the key fingerprint', async () => {
    const venue = new KalshiExecutionVenue(settings, mockApi(), () => instant)
    expect(await venue.account()).toMatchObject({
      accountId: settings.accountId,
      subaccount: 2,
      source: 'orders',
      balance: '100',
    })
    const empty = new KalshiExecutionVenue(
      settings,
      mockApi({ '/portfolio/orders': { orders: [], cursor: '' } }),
      () => instant,
    )
    expect(await empty.account()).toMatchObject({ source: 'owner_configuration' })
    const foreign = new KalshiExecutionVenue(
      settings,
      mockApi({
        '/portfolio/orders': { orders: [{ ...order, user_id: 'someone-else' }], cursor: '' },
      }),
      () => instant,
    )
    await expect(foreign.account()).rejects.toThrow('ACCOUNT_MISMATCH')
    for (const override of [
      { scopes: ['read', 'write'], subaccount: 2 },
      { scopes: ['read', 'write::trade', 'write::transfer'], subaccount: 2 },
      { scopes: ['read', 'write::trade'], subaccount: 0 },
      { scopes: ['read', 'write::trade'], subaccount: null },
    ]) {
      const unsafe = new KalshiExecutionVenue(
        settings,
        mockApi({ '/api_keys': { api_keys: [{ api_key_id: settings.keyId, ...override }] } }),
        () => instant,
      )
      await expect(unsafe.account()).rejects.toThrow('KEY_PERMISSIONS_INVALID')
    }
  })

  it('requires current Kalshi location attestation in Live and never switches hosts to evade it', async () => {
    const transport = mockApi({
      '/api_keys': {
        api_keys: [{ api_key_id: settings.keyId, scopes: ['read', 'write::trade'], subaccount: 2 }],
        api_key_region_expiration_ts: instant / 1000 - 1,
      },
    })
    const venue = new KalshiExecutionVenue(
      { ...settings, mode: 'live', liveEnabled: true, eligibilityConfirmed: true },
      transport,
      () => instant,
    )
    await expect(venue.account()).rejects.toThrow('LOCATION_ATTESTATION_REQUIRED')
    expect(
      transport.mock.calls.every(
        ([url]) => new URL(String(url)).host === 'external-api.kalshi.com',
      ),
    ).toBe(true)
  })

  it('credits a settlement only for the exact holding and only after current positions disappear', async () => {
    const settled = {
      ticker: intent.ticker,
      exchange_index: 1,
      market_result: 'yes',
      yes_count_fp: '1.25',
      no_count_fp: '0.00',
      yes_total_cost_dollars: '0.625',
      no_total_cost_dollars: '0',
      revenue: 125,
      fee_cost: '0.010007',
      settled_time: new Date(instant + 1000).toISOString(),
    }
    const venue = new KalshiExecutionVenue(
      settings,
      mockApi({ '/portfolio/settlements': { settlements: [settled], cursor: '' } }),
      () => instant,
    )
    expect(
      await venue.settledPosition({
        ticker: intent.ticker,
        outcome: 'yes',
        quantity: '1.25',
        openedAt: instant,
      }),
    ).toMatchObject({ revenue: '1.25' })
    await expect(
      venue.settledPosition({
        ticker: intent.ticker,
        outcome: 'yes',
        quantity: '1.24',
        openedAt: instant,
      }),
    ).rejects.toThrow('SETTLEMENT_MISMATCH')
    expect(
      await venue.settledPosition({
        ticker: intent.ticker,
        outcome: 'yes',
        quantity: '1.25',
        openedAt: instant + 2000,
      }),
    ).toBeNull()
    const notSettled = new KalshiExecutionVenue(
      settings,
      mockApi({
        '/portfolio/settlements': { settlements: [settled], cursor: '' },
        '/portfolio/positions': { market_positions: [position], cursor: '' },
      }),
      () => instant,
    )
    await expect(
      notSettled.settledPosition({
        ticker: intent.ticker,
        outcome: 'yes',
        quantity: '1.25',
        openedAt: instant,
      }),
    ).rejects.toThrow('SETTLEMENT_MISMATCH')
  })
})
