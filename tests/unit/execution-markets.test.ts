import { describe, expect, it } from 'vitest'
import { EXECUTION_POLICY as P } from '../../core/policy'
import { executionSettingsSchema } from '../../core/execution/store'
import { executionTracks } from '../../core/execution/types'
import { assertAaveConfigNetwork, AAVE_NETWORKS } from '../../core/execution/aave-networks'
import { createFuturesDriver } from '../../core/execution/drivers/futures'
import { createMarginDriver } from '../../core/execution/drivers/margin'
import { createEarnDriver } from '../../core/execution/drivers/earn'
import { createSwapDriver, minimumOut } from '../../core/execution/drivers/swap'
import { createOptionsDriver } from '../../core/execution/drivers/options'
import { createFundingDriver } from '../../core/execution/drivers/funding'
import { createPaperFundingVenue } from '../../core/execution/adapters/paper-funding'
import { uniswapSlippageCap, UNISWAP_V3 } from '../../core/execution/adapters/uniswap'
import { units, decimal, SCALE } from '../../core/trading/decimal'
import { syntheticBook } from '../../core/execution/adapters/paper-markets'
import type {
  ExecutionLeg,
  ExecutionOperation,
  ExecutionPortfolio,
  ExecutionSettings,
} from '../../core/execution/types'
import type { TradingSymbol } from '../../core/trading/types'

const settings: ExecutionSettings = executionSettingsSchema.parse({})

function portfolio(
  track: ExecutionPortfolio['track'],
  overrides: Partial<ExecutionPortfolio> = {},
): ExecutionPortfolio {
  return {
    track,
    mode: 'paper',
    status: 'running',
    capital: '100',
    cash: '100',
    equity: '100',
    realized: '0',
    fees: '0',
    peak: '100',
    day_equity: '100',
    risk_day: '',
    settings: {
      ...settings,
      symbols: ['BTC-USDT'],
      leverage: 2,
      stopLossBps: 150,
      takeProfitBps: 200,
    },
    reason: '',
    heartbeat: null,
    last_scan: null,
    started_at: new Date('2026-11-12T00:00:00Z'),
    close_requested: false,
    ...overrides,
  }
}

function operation(plan: ExecutionOperation['plan'], reserve = '20'): ExecutionOperation {
  return {
    id: 'op-1',
    track: 'futures',
    mode: 'paper',
    status: 'opening',
    reserve,
    plan,
    pnl: '0',
    fees: '0',
    created_at: new Date('2026-11-12T00:00:00Z'),
    closed_at: null,
  }
}

describe('execution settings defaults', () => {
  it('fills new market fields so legacy rows still parse', () => {
    const parsed = executionSettingsSchema.parse({
      buyExchange: 'okx',
      sellExchange: 'bybit',
    })
    expect(parsed.venue).toBe('bybit')
    expect(parsed.leverage).toBe(2)
    expect(parsed.defiNetwork).toBe('sepolia')
    expect(parsed.slippageBps).toBe(30)
    expect(parsed.optionKind).toBe('call')
  })

  it('rejects leverage above 3', () => {
    expect(() => executionSettingsSchema.parse({ ...settings, leverage: 5 })).toThrow()
  })

  it('lists every new book in the shared track set', () => {
    expect(executionTracks).toEqual([
      'arbitrage',
      'funding',
      'defi',
      'prediction',
      'futures',
      'margin',
      'earn',
      'swap',
      'options',
    ])
  })
})

describe('Aave network switch', () => {
  it('forbids mainnet config on Demo and Sepolia config on Live', () => {
    expect(() =>
      assertAaveConfigNetwork('demo', 'mainnet', { network: 'live', chainId: 1 }),
    ).toThrow('EXECUTION_DEFI_NETWORK_MISMATCH')
    expect(() =>
      assertAaveConfigNetwork('live', 'sepolia', { network: 'testnet', chainId: 11155111 }),
    ).toThrow('EXECUTION_DEFI_NETWORK_MISMATCH')
  })

  it('accepts official Ethereum pool addresses and rejects a wrong token', () => {
    assertAaveConfigNetwork('live', 'mainnet', {
      network: 'live',
      chainId: 1,
      pool: { address: AAVE_NETWORKS.mainnet.pool },
      token: { address: AAVE_NETWORKS.mainnet.token },
      aToken: { address: AAVE_NETWORKS.mainnet.aToken },
    })
    expect(() =>
      assertAaveConfigNetwork('live', 'mainnet', {
        network: 'live',
        chainId: 1,
        token: { address: '0x0000000000000000000000000000000000000001' },
      }),
    ).toThrow('EXECUTION_DEFI_ADDRESS_MISMATCH')
  })
})

describe('directional futures paper book', () => {
  it('plans an isolated long with leverage 2, stop and take profit', async () => {
    const driver = createFuturesDriver('paper', 'bybit')
    const planned = await driver.plan(portfolio('futures'))
    expect(planned).toBeTruthy()
    expect(planned!.plan.side).toBe('buy')
    expect(planned!.plan.leverage).toBe(2)
    expect(units(planned!.plan.stopPrice!)).toBeLessThan(units(planned!.plan.entryPrice))
    expect(units(planned!.plan.takePrice!)).toBeGreaterThan(units(planned!.plan.entryPrice))
    expect(units(planned!.reserve)).toBeGreaterThan(0n)
  })

  it('closes when the mark crosses the stop', async () => {
    const driver = createFuturesDriver('paper', 'bybit')
    const planned = (await driver.plan(portfolio('futures')))!
    const opened: ExecutionLeg[] = [
      {
        id: 'l1',
        operation_id: 'op-1',
        sequence: 0,
        role: 'open',
        state: 'terminal',
        prepared: {
          intent: {
            clientId: 'c1',
            venue: 'bybit-futures',
            action: 'buy',
            symbol: 'BTC-USDT',
            quantity: planned.plan.quantity,
            limitPrice: planned.plan.entryPrice,
            quoteBudget: planned.reserve,
            positionQuantity: '0',
            expiresAt: Date.now() + 10_000,
          },
          payload: {},
          externalId: 'paper:c1',
        },
        receipt: {
          status: 'filled',
          externalId: 'paper:c1',
          filledQuantity: planned.plan.quantity,
          grossQuote: planned.plan.entryPrice,
          quoteFee: '0',
          baseFee: '0',
        },
        created_at: new Date(),
      },
    ]
    const crushed = createFuturesDriver('paper', 'bybit', {
      async market(symbol: TradingSymbol) {
        return syntheticBook(symbol, '90')
      },
      async discover() {
        return ['BTC-USDT']
      },
      async account() {
        return { identity: 'x', available: units('100'), positions: [], feeBps: 10 }
      },
      async pending() {
        return []
      },
      async prepare() {
        throw new Error('no')
      },
      async broadcast() {},
      async lookup() {
        return null
      },
    })
    const decision = await crushed.decide(portfolio('futures'), operation(planned.plan), opened)
    expect(decision.type).toBe('leg')
    if (decision.type === 'leg') expect(decision.intent.action).toBe('sell')
  })

  it('refuses to start live-shaped accounts that already have 5x leverage', async () => {
    const driver = createFuturesDriver('demo', 'okx', {
      async market(symbol) {
        return syntheticBook(symbol, '100')
      },
      async discover() {
        return ['BTC-USDT']
      },
      async account() {
        return {
          identity: 'acct',
          available: units('100'),
          positions: [
            {
              symbol: 'BTC-USDT',
              side: 'buy',
              qty: units('1'),
              entry: units('100'),
              mark: units('100'),
              liquidation: units('80'),
              leverage: 5,
              margin: units('20'),
            },
          ],
          feeBps: 10,
        }
      },
      async pending() {
        return []
      },
      async prepare() {
        throw new Error('no')
      },
      async broadcast() {},
      async lookup() {
        return null
      },
    })
    await expect(
      driver.accounts(portfolio('futures', { mode: 'demo', started_at: new Date() })),
    ).rejects.toThrow('EXECUTION_LEVERAGE_FORBIDDEN')
  })
})

describe('funding paper venue for other exchanges', () => {
  it('opens a 1x hedge on a virtual OKX book when the rate stays positive', async () => {
    const venue = createPaperFundingVenue()
    const driver = createFundingDriver(
      'paper',
      { credentials: { key: '', secret: '' } },
      { venue, exchange: 'okx' },
    )
    const planned = await driver.plan(
      portfolio('funding', {
        settings: { ...settings, minFundingBps: 2, minEdgeBps: 10, maxHoldHours: 48 },
      }),
    )
    expect(planned).toBeTruthy()
    expect(planned!.plan.buyVenue).toBe('okx-funding')
  })
})

describe('spot margin paper book', () => {
  it('reserves only the isolated margin, not the full notional, at 2x', async () => {
    const driver = createMarginDriver('paper', 'bybit')
    const planned = await driver.plan(portfolio('margin'))
    expect(planned).toBeTruthy()
    expect(planned!.plan.leverage).toBe(2)
    const notional = (units(planned!.plan.quantity) * units(planned!.plan.entryPrice)) / SCALE
    expect(units(planned!.reserve)).toBeLessThan(notional)
  })
})

describe('flexible earn paper book', () => {
  it('subscribes cash and later redeems with a virtual yield', async () => {
    let now = Date.parse('2026-11-12T00:00:00Z')
    const driver = createEarnDriver('paper', 'bybit', undefined, () => now)
    const p = portfolio('earn')
    const planned = (await driver.plan(p))!
    const first = await driver.decide(p, operation(planned.plan, planned.reserve), [])
    expect(first.type).toBe('leg')
    if (first.type !== 'leg') throw new Error('expected subscribe')
    expect(first.intent.action).toBe('subscribe')
    const opened: ExecutionLeg[] = [
      {
        id: 's1',
        operation_id: 'op-1',
        sequence: 0,
        role: 'open',
        state: 'terminal',
        prepared: { intent: first.intent, payload: {}, externalId: 'paper:1' },
        receipt: {
          status: 'filled',
          externalId: 'paper:1',
          filledQuantity: first.intent.quantity,
          grossQuote: first.intent.quantity,
          quoteFee: '0',
          baseFee: '0',
        },
        created_at: new Date(now),
      },
    ]
    now += 25 * 60 * 60_000
    const closing = await driver.decide(
      { ...p, close_requested: true },
      { ...operation(planned.plan, planned.reserve), created_at: new Date(now - 25 * 60 * 60_000) },
      opened,
    )
    expect(closing.type).toBe('leg')
    if (closing.type === 'leg') expect(closing.intent.action).toBe('redeem')
  })

  it('does not offer Bitget earn', () => {
    expect(() => createEarnDriver('paper', 'bitget')).toThrow('EXECUTION_EARN_VENUE_UNSUPPORTED')
  })
})

describe('Uniswap paper swap', () => {
  it('rejects a quote that slips more than the cap', () => {
    expect(() => minimumOut(units('100'), 80)).toThrow('EXECUTION_SLIPPAGE_FORBIDDEN')
    expect(minimumOut(units('100'), 30)).toBe((units('100') * (10000n - 30n)) / 10000n)
  })

  it('closes a paper swap after a fill above the minimum out', async () => {
    const driver = createSwapDriver('paper')
    const planned = (await driver.plan(
      portfolio('swap', { settings: { ...settings, symbols: ['USDC-USDT'], slippageBps: 30 } }),
    ))!
    const open = await driver.decide(
      portfolio('swap'),
      operation(planned.plan, planned.reserve),
      [],
    )
    expect(open.type).toBe('leg')
    if (open.type !== 'leg') throw new Error('expected swap')
    const filled = units(planned.plan.hedgePrice) + units('1')
    const decision = await driver.decide(
      portfolio('swap'),
      operation(planned.plan, planned.reserve),
      [
        {
          id: 'sw1',
          operation_id: 'op-1',
          sequence: 0,
          role: 'swap',
          state: 'terminal',
          prepared: { intent: open.intent, payload: {}, externalId: 'paper:sw' },
          receipt: {
            status: 'filled',
            externalId: 'paper:sw',
            filledQuantity: decimal(filled),
            grossQuote: planned.plan.quantity,
            quoteFee: '0',
            baseFee: '0',
          },
          created_at: new Date(),
        },
      ],
    )
    expect(decision.type).toBe('close')
  })

  it('keeps official Ethereum router pins and the 50 bps cap', () => {
    expect(UNISWAP_V3.mainnet.swapRouter02).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(UNISWAP_V3.sepolia.swapRouter02).toBe('0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E')
    expect(uniswapSlippageCap(P.swap.maxSlippageBps)).toBe(50)
    expect(() => uniswapSlippageCap(51)).toThrow('EXECUTION_SLIPPAGE_FORBIDDEN')
  })
})

describe('options paper book', () => {
  it('buys only a long option and caps premium by the max-loss budget', async () => {
    const driver = createOptionsDriver('paper', 'bybit', {
      async quote() {
        return {
          symbol: 'BTC-USDT',
          kind: 'call',
          premium: units('2'),
          mark: units('2'),
          expiry: Date.now() + 86_400_000,
          at: Date.now(),
        }
      },
    })
    const planned = await driver.plan(portfolio('options', { capital: '100', cash: '100' }))
    expect(planned).toBeTruthy()
    const premium = (units(planned!.plan.entryPrice) * units(planned!.plan.quantity)) / SCALE
    const cap = (units('100') * BigInt(P.options.maxLossBps)) / 10000n
    expect(premium).toBeLessThanOrEqual(cap)
    const first = await driver.decide(
      portfolio('options'),
      operation(planned!.plan, planned!.reserve),
      [],
    )
    expect(first.type).toBe('leg')
    if (first.type === 'leg') expect(first.intent.action).toBe('buy')
  })

  it('leaves Demo/Live options on the pending adapter', async () => {
    const driver = createOptionsDriver('demo', 'okx')
    await expect(driver.accounts(portfolio('options', { mode: 'demo' }))).rejects.toThrow(
      'EXECUTION_OPTIONS_ADAPTER_PENDING',
    )
  })
})
