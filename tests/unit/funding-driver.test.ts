import { describe, expect, it, vi } from 'vitest'
import {
  createFundingDriver,
  firstSettlementAfter,
  FUNDING_STRATEGY,
} from '../../core/execution/drivers/funding'
import type {
  BybitFundingAdapter,
  FundingAccount,
  FundingMarket,
} from '../../core/execution/adapters/bybit-funding'
import type {
  ExecutionIntent,
  ExecutionLeg,
  ExecutionOperation,
  ExecutionPortfolio,
  ExecutionReceipt,
} from '../../core/execution/types'
import { units } from '../../core/trading/decimal'

const now = 1_792_000_000_000
const portfolio: ExecutionPortfolio = {
  track: 'funding',
  mode: 'paper',
  status: 'running',
  capital: '2000',
  cash: '2000',
  equity: '2000',
  realized: '0',
  fees: '0',
  peak: '2000',
  day_equity: '2000',
  risk_day: '2026-10-13',
  reason: '',
  heartbeat: null,
  last_scan: null,
  started_at: new Date(now - 1000),
  close_requested: false,
  settings: {
    buyExchange: 'okx',
    sellExchange: 'bybit',
    symbols: ['SUI-USDT'],
    minEdgeBps: 1,
    minFundingBps: 1,
    maxHoldHours: 72,
    predictionTicker: '',
    probabilityBps: 5000,
    outcome: 'yes',
  },
}
const market: FundingMarket = {
  spot: {
    instrument: {
      symbol: 'SUI-USDT',
      lot: units('0.001'),
      minQty: units('0.001'),
      tick: units('0.001'),
      minNotional: units('5'),
    },
    book: {
      symbol: 'SUI-USDT',
      at: now,
      bids: [[units('1'), units('10000')]],
      asks: [[units('1.001'), units('10000')]],
    },
    candles: [],
  },
  perp: {
    instrument: {
      symbol: 'SUI-USDT',
      lot: units('1'),
      minQty: units('1'),
      tick: units('0.001'),
      minNotional: units('5'),
    },
    book: {
      symbol: 'SUI-USDT',
      at: now,
      bids: [[units('1'), units('10000')]],
      asks: [[units('1.001'), units('10000')]],
    },
    candles: [],
  },
  spotMaxQty: units('10000'),
  perpMaxQty: units('10000'),
  fundingRate: units('0.01'),
  fundingIntervalMinutes: 480,
  nextFundingAt: now + 3_600_000,
  at: now,
}
const eightHours = 8 * 3_600_000
/** Three settled positive rates before the next settlement, as Bybit publishes them. */
const positiveHistory = [3, 2, 1].map((k) => ({
  at: market.nextFundingAt - k * eightHours,
  rate: units('0.0001'),
}))
const account: FundingAccount = {
  identity: 'separate-account',
  balances: { USDT: { total: units('2000'), available: units('2000') } },
  availableMargin: units('2000'),
  positions: [],
  feeBps: null,
}
const operation: ExecutionOperation = {
  id: 'operation-1',
  track: 'funding',
  mode: 'paper',
  status: 'opening',
  reserve: '100',
  pnl: '0',
  fees: '0',
  created_at: new Date(now - 1000),
  closed_at: null,
  plan: {
    symbol: 'SUI-USDT',
    quantity: '20',
    entryPrice: '1',
    hedgePrice: '1',
    buyVenue: 'bybit-funding',
    sellVenue: 'bybit-funding',
    outcome: 'yes',
    rate: '0.01',
    nextPaymentAt: now + 3_600_000,
    intervalMs: 8 * 3_600_000,
  },
}
const methods = () => ({
  market: vi.fn().mockResolvedValue(market),
  discover: vi.fn().mockResolvedValue(['SUI-USDT']),
  account: vi.fn().mockResolvedValue(account),
  positions: vi.fn().mockResolvedValue([]),
  pending: vi.fn().mockResolvedValue([]),
  fundingHistory: vi.fn().mockResolvedValue([]),
  fundingRates: vi.fn().mockResolvedValue(positiveHistory),
  prepare: vi.fn(),
  broadcast: vi.fn(),
  lookup: vi.fn(),
  cancel: vi.fn(),
})
type TestVenue = ReturnType<typeof methods>
function driver(venue: TestVenue = methods(), mode: 'paper' | 'demo' = 'paper', clock = () => now) {
  return createFundingDriver(
    mode,
    { credentials: { key: '', secret: '' } },
    { venue: venue as unknown as BybitFundingAdapter, now: clock },
  )
}
function executionLeg(
  action: 'buy' | 'sell' | 'short' | 'cover',
  quantity: string,
  extra: Partial<ExecutionReceipt> = {},
  role: string = action,
  at = now - 500,
): ExecutionLeg {
  const intent: ExecutionIntent = {
    clientId: `leg-${action}-${at}`,
    venue: 'bybit-funding',
    action,
    symbol: 'SUI-USDT',
    quantity,
    limitPrice: '1',
    quoteBudget: '100',
    positionQuantity: '20',
    expiresAt: now + 1000,
  }
  return {
    id: intent.clientId,
    operation_id: operation.id,
    sequence: 1,
    role,
    state: 'terminal',
    prepared: { intent, externalId: null, payload: {} },
    receipt: {
      status: 'filled',
      externalId: intent.clientId,
      filledQuantity: quantity,
      grossQuote: quantity,
      quoteFee: '0',
      baseFee: '0',
      ...extra,
    },
    created_at: new Date(at),
  }
}

describe('funding portfolio plans', () => {
  it('allocates no more than twenty percent across paid spot, 1x margin and all fees', async () => {
    const venue = methods()
    const selected = await driver(venue).plan(portfolio)
    expect(selected).not.toBeNull()
    expect(units(selected!.reserve)).toBeLessThanOrEqual(units('400'))
    expect(units(selected!.plan.quantity)).toBeGreaterThan(0n)
    expect(selected!.plan.buyVenue).toBe('bybit-funding')
    expect(selected!.plan.sellVenue).toBe('bybit-funding')
    expect(venue.prepare).not.toHaveBeenCalled()
    expect(venue.broadcast).not.toHaveBeenCalled()
  })

  it('discovers eligible symbols when no fixed list is selected', async () => {
    const venue = methods()
    await expect(
      driver(venue).plan({ ...portfolio, settings: { ...portfolio.settings, symbols: [] } }),
    ).resolves.not.toBeNull()
    expect(venue.discover).toHaveBeenCalledOnce()
    expect(venue.market).toHaveBeenCalledWith('SUI-USDT')
  })

  it('does not open when funding cannot cover fee/spread estimates or cash is too small', async () => {
    const venue = methods()
    venue.market.mockResolvedValue({ ...market, fundingRate: units('0.00001') })
    expect(await driver(venue).plan(portfolio)).toBeNull()
    expect(await driver().plan({ ...portfolio, cash: '9' })).toBeNull()
  })

  it('requires an empty separately funded account on first activation and permits a tracked hedge on resume', async () => {
    const venue = methods()
    const started = { ...portfolio, mode: 'demo' as const, started_at: null }
    expect(await driver(venue, 'demo').accounts(started)).toEqual([
      { identity: 'separate-account', venue: 'bybit-funding' },
    ])
    venue.account.mockResolvedValue({
      ...account,
      availableMargin: units('1000'),
      positions: [
        { symbol: 'SUI-USDT', qty: units('20'), markPrice: units('1'), liquidationPrice: null },
      ],
    })
    await expect(driver(venue, 'demo').accounts(started)).rejects.toThrow(
      'EXECUTION_INSUFFICIENT_BALANCE',
    )
    expect(
      await driver(venue, 'demo').accounts({ ...started, started_at: new Date(now - 1000) }),
    ).toEqual([{ identity: 'separate-account', venue: 'bybit-funding' }])
    expect(await driver(venue).accounts(portfolio)).toEqual([
      { identity: 'bybit-funding:paper:virtual', venue: 'bybit-funding' },
    ])
  })
})

describe('funding entry timing', () => {
  it('opens only within the window before the next settlement', async () => {
    const at = (lead: number) => {
      const venue = methods()
      venue.market.mockResolvedValue({ ...market, nextFundingAt: now + lead })
      venue.fundingRates.mockResolvedValue(
        [3, 2, 1].map((k) => ({ at: now + lead - k * eightHours, rate: units('0.0001') })),
      )
      return driver(venue).plan(portfolio)
    }
    // Right after a payment the next one is almost eight hours away.
    expect(await at(eightHours - 60_000)).toBeNull()
    expect(await at(FUNDING_STRATEGY.entryWindowMs + 1)).toBeNull()
    expect(await at(FUNDING_STRATEGY.minLeadMs - 1)).toBeNull()
    expect(await at(FUNDING_STRATEGY.entryWindowMs)).not.toBeNull()
    expect(await at(30 * 60_000)).not.toBeNull()
  })

  it('requires the latest settled rates to be positive and a complete history', async () => {
    const plan = async (rates: { at: number; rate: bigint }[] | Error) => {
      const venue = methods()
      if (rates instanceof Error) venue.fundingRates.mockRejectedValue(rates)
      else venue.fundingRates.mockResolvedValue(rates)
      return driver(venue).plan(portfolio)
    }
    expect(await plan(positiveHistory)).not.toBeNull()
    expect(
      await plan(positiveHistory.map((row, i) => (i === 1 ? { ...row, rate: -1n } : row))),
    ).toBeNull()
    expect(
      await plan(positiveHistory.map((row, i) => (i === 2 ? { ...row, rate: 0n } : row))),
    ).toBeNull()
    expect(await plan(positiveHistory.slice(1))).toBeNull()
    expect(await plan(new Error('EXECUTION_HISTORY_INVALID'))).toBeNull()
    const venue = methods()
    await driver(venue).plan(portfolio)
    const [, start, end] = venue.fundingRates.mock.calls[0]!
    expect(end).toBe(now)
    expect(start).toBeLessThan(positiveHistory[0]!.at)
  })

  it('finds the first settlement after the hedge opened on the plan schedule', () => {
    const plan = { nextPaymentAt: 1_000_000, intervalMs: 100 }
    expect(firstSettlementAfter(999_000, plan)).toBe(1_000_000)
    expect(firstSettlementAfter(1_000_000, plan)).toBe(1_000_100)
    expect(firstSettlementAfter(1_000_250, plan)).toBe(1_000_300)
    expect(firstSettlementAfter(1_000_250, { ...plan, intervalMs: 0 })).toBeNull()
    expect(firstSettlementAfter(5, { nextPaymentAt: 0, intervalMs: 100 })).toBeNull()
  })
})

describe('funding pair execution decisions', () => {
  it('buys spot first and sizes the short only from the confirmed net base after fees', async () => {
    const d = driver()
    expect(await d.decide(portfolio, operation, [])).toMatchObject({
      type: 'leg',
      role: 'open-spot',
      intent: { action: 'buy', quantity: '20', venue: 'bybit-funding' },
    })
    const bought = executionLeg('buy', '20', { baseFee: '0.02' }, 'open-spot')
    expect(await d.decide(portfolio, operation, [bought])).toMatchObject({
      type: 'leg',
      role: 'open-short',
      intent: { action: 'short', quantity: '19', positionQuantity: '19.98' },
    })
  })

  it('compensates an unmatched spot fill when the short partially fills', async () => {
    const legs = [
      executionLeg('buy', '20', {}, 'open-spot'),
      executionLeg('short', '10', { status: 'cancelled' }, 'open-short'),
    ]
    expect(await driver().decide(portfolio, operation, legs)).toMatchObject({
      type: 'leg',
      role: 'repair-spot',
      intent: { action: 'sell', quantity: '10' },
    })
  })

  it('does not retry a refused hedge and liquidates its confirmed spot leg', async () => {
    const legs = [
      executionLeg('buy', '20', {}, 'open-spot'),
      executionLeg('short', '0', { status: 'rejected' }, 'open-short'),
    ]
    expect(await driver().decide(portfolio, operation, legs)).toMatchObject({
      type: 'leg',
      role: 'repair-spot',
      intent: { action: 'sell', quantity: '20' },
    })
  })

  it('covers an uncovered short with a bounded reduce-only action', async () => {
    const legs = [
      executionLeg('buy', '10', {}, 'open-spot'),
      executionLeg('short', '20', {}, 'open-short'),
    ]
    expect(await driver().decide(portfolio, operation, legs)).toMatchObject({
      type: 'leg',
      role: 'repair-short',
      intent: { action: 'cover', quantity: '10', positionQuantity: '20' },
    })
  })

  it('does not authorize another leg while a prior submission is unknown', async () => {
    const unknown = { ...executionLeg('buy', '20'), state: 'unknown' as const, receipt: null }
    expect(await driver().decide(portfolio, operation, [unknown])).toEqual({
      type: 'attention',
      reason: 'EXECUTION_ORDER_UNKNOWN',
    })
  })

  it('limits compensation attempts and keeps unsettled exposure in attention', async () => {
    const legs = [
      executionLeg('buy', '20'),
      executionLeg('short', '10'),
      ...[1, 2, 3].map((attempt) =>
        executionLeg('sell', '0', { status: 'rejected' }, 'repair-spot', now - attempt),
      ),
    ]
    expect(await driver().decide(portfolio, operation, legs)).toEqual({
      type: 'attention',
      reason: 'EXECUTION_REPAIR_LIMIT',
    })
  })

  it('holds only the matched hedge while preserving the sub-lot remainder in mark-to-market value', async () => {
    const legs = [executionLeg('buy', '20', { baseFee: '0.02' }), executionLeg('short', '19')]
    const result = await driver().decide(portfolio, operation, legs)
    expect(result.type).toBe('hold')
    if (result.type === 'hold') {
      expect(units(result.fees)).toBe(units('0.02'))
      expect(units(result.pnl)).toBeLessThan(0n)
    }
  })

  it('keeps an already accepted hedge running during a portfolio pause', async () => {
    const legs = [executionLeg('buy', '20'), executionLeg('short', '20')]
    expect((await driver().decide({ ...portfolio, status: 'paused' }, operation, legs)).type).toBe(
      'hold',
    )
  })

  it('closes the short first, then sells only the confirmed covered spot amount', async () => {
    const p = { ...portfolio, close_requested: true }
    const legs = [executionLeg('buy', '20'), executionLeg('short', '20')]
    expect(await driver().decide(p, operation, legs)).toMatchObject({
      type: 'leg',
      role: 'close-short',
      intent: { action: 'cover', quantity: '20' },
    })
    legs.push(executionLeg('cover', '10', { status: 'cancelled' }, 'close-short'))
    expect(await driver().decide(p, operation, legs)).toMatchObject({
      type: 'leg',
      role: 'close-spot',
      intent: { action: 'sell', quantity: '10' },
    })
  })

  it('holds through the first settlement on negative funding, then closes; or at maximum age', async () => {
    const legs = [executionLeg('buy', '20'), executionLeg('short', '20')]
    const venue = methods()
    venue.market.mockResolvedValue({ ...market, fundingRate: units('-0.0001') })
    // The predicted rate turned negative before the first payment: holding is cheaper than
    // paying four commissions for nothing.
    expect((await driver(venue).decide(portfolio, operation, legs)).type).toBe('hold')
    const settled = operation.plan.nextPaymentAt
    expect(
      (
        await driver(venue, 'paper', () => settled + 60_000).decide(
          { ...portfolio },
          operation,
          legs,
        )
      ).type,
    ).toBe('hold')
    expect(
      await driver(venue, 'paper', () => settled + FUNDING_STRATEGY.settlementGraceMs).decide(
        portfolio,
        operation,
        legs,
      ),
    ).toMatchObject({ type: 'leg', role: 'close-short' })
    expect(
      await driver(methods(), 'paper', () => now + 73 * 3_600_000).decide(
        portfolio,
        operation,
        legs,
      ),
    ).toMatchObject({ type: 'leg', role: 'close-short' })
  })

  it('reduces an existing short below the opening minimum notional', async () => {
    const legs = [executionLeg('buy', '1'), executionLeg('short', '1')]
    expect(
      await driver().decide({ ...portfolio, close_requested: true }, operation, legs),
    ).toMatchObject({ type: 'leg', intent: { action: 'cover', quantity: '1' } })
  })

  it('does not report a nonzero untradeable dust remainder as a closed position', async () => {
    const legs = [
      executionLeg('buy', '20', { baseFee: '0.0001' }),
      executionLeg('short', '19'),
      executionLeg('cover', '19', {}, 'close-short'),
      executionLeg('sell', '19.999', {}, 'close-spot'),
    ]
    expect(await driver().decide({ ...portfolio, close_requested: true }, operation, legs)).toEqual(
      { type: 'attention', reason: 'EXECUTION_RESIDUAL_DUST' },
    )
  })

  it('detects out-of-band private account changes instead of compensating unrelated holdings', async () => {
    const venue = methods()
    venue.account.mockResolvedValue({
      ...account,
      balances: { ...account.balances, SUI: { total: units('21'), available: units('21') } },
    })
    expect(
      await driver(venue, 'demo').decide(
        { ...portfolio, mode: 'demo' },
        { ...operation, mode: 'demo' },
        [executionLeg('buy', '20')],
      ),
    ).toEqual({ type: 'attention', reason: 'EXECUTION_POSITION_MISMATCH' })
  })

  it('closes near the short liquidation price even when combined spot/perpetual P&L is flat', async () => {
    const venue = methods()
    venue.account.mockResolvedValue({
      ...account,
      balances: { ...account.balances, SUI: { total: units('20'), available: units('20') } },
      positions: [
        {
          symbol: 'SUI-USDT',
          qty: units('20'),
          markPrice: units('1.8'),
          liquidationPrice: units('2'),
        },
      ],
    })
    expect(
      await driver(venue, 'demo').decide(
        { ...portfolio, mode: 'demo' },
        { ...operation, mode: 'demo' },
        [executionLeg('buy', '20'), executionLeg('short', '20')],
      ),
    ).toMatchObject({
      type: 'leg',
      role: 'close-short',
      intent: { action: 'cover', quantity: '20' },
    })
  })
})

describe('funding settled cashflows', () => {
  it('returns stable real settlement IDs and cumulative P&L without estimating private income', async () => {
    const venue = methods()
    venue.account.mockResolvedValue({
      ...account,
      balances: { ...account.balances, SUI: { total: units('20'), available: units('20') } },
      positions: [
        { symbol: 'SUI-USDT', qty: units('20'), markPrice: units('1'), liquidationPrice: null },
      ],
    })
    venue.fundingHistory.mockResolvedValue([
      { id: 'actual-funding-1', symbol: 'SUI-USDT', at: now - 10, amount: units('0.5') },
    ])
    const legs = [
      executionLeg('buy', '20', { quoteFee: '0.02' }),
      executionLeg('short', '20', { quoteFee: '0.01' }),
    ]
    const first = await driver(venue, 'demo').decide(
      { ...portfolio, mode: 'demo' },
      { ...operation, mode: 'demo' },
      legs,
    )
    const second = await driver(venue, 'demo').decide(
      { ...portfolio, mode: 'demo' },
      { ...operation, mode: 'demo' },
      legs,
    )
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      type: 'hold',
      fees: '0.03',
      flows: [{ externalId: 'actual-funding-1', kind: 'funding', amount: '0.5', at: now - 10 }],
    })
    expect(venue.fundingRates).not.toHaveBeenCalled()
  })

  it('paper accrues from published past rates only and only while its short exists', async () => {
    const venue = methods()
    venue.fundingRates.mockResolvedValue([{ at: now - 10, rate: units('0.01') }])
    const legs = [executionLeg('buy', '20'), executionLeg('short', '20')]
    const result = await driver(venue).decide(portfolio, operation, legs)
    expect(result).toMatchObject({
      type: 'hold',
      flows: [{ externalId: `paper:SUI-USDT:${now - 10}`, amount: '0.2' }],
    })
    expect(venue.fundingHistory).not.toHaveBeenCalled()
  })

  it('closes only a zero-exposure pair, including actual fees and all confirmed funding', async () => {
    const venue = methods()
    venue.fundingRates.mockResolvedValue([
      { at: now - 300, rate: units('0.01') },
      { at: now - 100, rate: units('0.01') },
    ])
    const legs = [
      executionLeg('buy', '20', { quoteFee: '0.02' }, 'open-spot', now - 500),
      executionLeg('short', '20', { quoteFee: '0.01' }, 'open-short', now - 400),
      executionLeg('cover', '20', { grossQuote: '19', quoteFee: '0.01' }, 'close-short', now - 200),
      executionLeg('sell', '20', { grossQuote: '19.2', quoteFee: '0.02' }, 'close-spot', now - 100),
    ]
    const result = await driver(venue).decide(
      { ...portfolio, close_requested: true },
      operation,
      legs,
    )
    expect(result).toEqual({
      type: 'close',
      pnl: '0.34',
      fees: '0.06',
      flows: [
        {
          externalId: `paper:SUI-USDT:${now - 300}`,
          kind: 'funding',
          amount: '0.2',
          at: now - 300,
        },
      ],
    })
  })

  it('executes a complete paper pair through the shared adapter and returns to zero exposure', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const venue = methods()
      const d = driver(venue)
      const selected = await d.plan(portfolio)
      expect(selected).not.toBeNull()
      const op = { ...operation, reserve: selected!.reserve, plan: selected!.plan }
      const legs: ExecutionLeg[] = []
      let p = { ...portfolio }
      let held = false
      let closed = false
      for (let index = 0; index < 10; index++) {
        const decision = await d.decide(p, op, legs)
        if (decision.type === 'hold') {
          held = true
          p = { ...p, close_requested: true }
          continue
        }
        if (decision.type === 'close') {
          closed = true
          expect(units(decision.fees)).toBeGreaterThan(0n)
          expect(units(decision.pnl)).toBeLessThan(0n)
          break
        }
        expect(decision.type).toBe('leg')
        if (decision.type !== 'leg') break
        const intent = { ...decision.intent, clientId: `paper-pair-${index}` }
        const adapter = d.adapter(intent.venue)
        const prepared = await adapter.prepare(intent)
        await adapter.broadcast(prepared)
        const receipt = await adapter.lookup(prepared)
        expect(receipt?.status).toBe('filled')
        legs.push({
          id: intent.clientId,
          operation_id: op.id,
          sequence: index,
          role: decision.role,
          state: 'terminal',
          prepared,
          receipt,
          created_at: new Date(now),
        })
      }
      expect(held).toBe(true)
      expect(closed).toBe(true)
      expect(legs.map((item) => item.prepared.intent.action)).toEqual([
        'buy',
        'short',
        'cover',
        'sell',
      ])
      expect(venue.account).not.toHaveBeenCalled()
      expect(venue.broadcast).not.toHaveBeenCalled()
      expect(venue.fundingHistory).not.toHaveBeenCalled()
    } finally {
      time.mockRestore()
    }
  })

  it('simulated rates: a hedge whose rate turns negative still collects the settlement', async () => {
    let clock = now
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const settlement = now + 30 * 60_000
      const settled = units('0.02')
      const history = [...positiveHistory.map((row) => ({ ...row, at: row.at - 30 * 60_000 }))]
      const venue = methods()
      let predicted = units('0.01')
      venue.market.mockImplementation(async () => ({
        ...market,
        spot: { ...market.spot, book: { ...market.spot.book, at: clock } },
        perp: { ...market.perp, book: { ...market.perp.book, at: clock } },
        fundingRate: predicted,
        nextFundingAt: clock < settlement ? settlement : settlement + eightHours,
        at: clock,
      }))
      venue.fundingRates.mockImplementation(async (_symbol, start: number, end: number) =>
        [...history, ...(clock >= settlement ? [{ at: settlement, rate: settled }] : [])].filter(
          (row) => row.at >= start && row.at <= end,
        ),
      )
      const d = driver(venue, 'paper', () => clock)
      const selected = await d.plan(portfolio)
      expect(selected).not.toBeNull()
      const op = {
        ...operation,
        created_at: new Date(clock),
        reserve: selected!.reserve,
        plan: selected!.plan,
      }
      const legs: ExecutionLeg[] = []
      const step = async () => {
        const decision = await d.decide(portfolio, op, legs)
        if (decision.type !== 'leg') return decision
        const intent = { ...decision.intent, clientId: `sim-${legs.length}` }
        const prepared = await d.adapter(intent.venue).prepare(intent)
        legs.push({
          id: intent.clientId,
          operation_id: op.id,
          sequence: legs.length,
          role: decision.role,
          state: 'terminal',
          prepared,
          receipt: await d.adapter(intent.venue).lookup(prepared),
          created_at: new Date(clock),
        })
        return decision
      }
      expect(await step()).toMatchObject({ role: 'open-spot' })
      clock += 15_000
      expect(await step()).toMatchObject({ role: 'open-short' })
      // Ten minutes later the predicted rate drops below zero: the old rule sold here.
      clock = now + 10 * 60_000
      predicted = units('-0.0001')
      expect((await step()).type).toBe('hold')
      clock = settlement + 30_000
      expect((await step()).type).toBe('hold')
      clock = settlement + FUNDING_STRATEGY.settlementGraceMs
      expect(await step()).toMatchObject({ role: 'close-short' })
      expect(await step()).toMatchObject({ role: 'close-spot' })
      const result = await step()
      expect(result.type).toBe('close')
      if (result.type !== 'close') return
      expect(result.flows).toEqual([
        expect.objectContaining({ externalId: `paper:SUI-USDT:${settlement}`, kind: 'funding' }),
      ])
      expect(units(result.flows![0]!.amount)).toBeGreaterThan(units(result.fees))
      expect(units(result.pnl)).toBeGreaterThan(0n)
    } finally {
      time.mockRestore()
    }
  })

  it('simulated rates: a loss or liquidation-distance exit is not delayed by the hold', async () => {
    const legs = [executionLeg('buy', '20'), executionLeg('short', '20')]
    const venue = methods()
    // The spot leg lost most of its value; the hedge cannot cover a 3% reserve loss.
    venue.market.mockResolvedValue({
      ...market,
      fundingRate: units('0.01'),
      spot: {
        ...market.spot,
        book: { ...market.spot.book, bids: [[units('0.5'), units('10000')]] },
      },
    })
    expect(await driver(venue).decide(portfolio, operation, legs)).toMatchObject({
      type: 'leg',
      role: 'close-short',
    })
  })
})
