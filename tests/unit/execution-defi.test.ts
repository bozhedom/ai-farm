import { describe, expect, it } from 'vitest'
import { createDefiDriver } from '../../core/execution/drivers/defi'
import type {
  ExecutionLeg,
  ExecutionOperation,
  ExecutionPortfolio,
  ExecutionIntent,
  ExecutionDecision,
} from '../../core/execution/types'
import { aaveRpcFixture } from '../fixtures/aave-rpc'

const time = Date.parse('2026-10-13T00:00:00Z')
const source = async () => ({ apyBps: 500, observedAt: time })
function portfolio(mode: ExecutionPortfolio['mode'] = 'paper'): ExecutionPortfolio {
  return {
    track: 'defi',
    mode,
    status: 'running',
    capital: '100',
    cash: '100',
    equity: '100',
    realized: '0',
    fees: '0',
    peak: '100',
    day_equity: '100',
    risk_day: '2026-10-13',
    settings: {
      buyExchange: 'okx',
      sellExchange: 'bybit',
      symbols: ['BTC-USDT'],
      minEdgeBps: 10,
      minFundingBps: 1,
      maxHoldHours: 24,
      predictionTicker: '',
      probabilityBps: 5000,
      outcome: 'yes',
    },
    reason: '',
    heartbeat: null,
    last_scan: null,
    started_at: new Date(time),
    close_requested: false,
  }
}
function operation(mode: ExecutionPortfolio['mode'] = 'paper'): ExecutionOperation {
  return {
    id: 'op-1',
    track: 'defi',
    mode,
    status: 'opening',
    reserve: '50',
    plan: {
      symbol: 'USDC',
      quantity: '50',
      entryPrice: '1',
      hedgePrice: '1',
      buyVenue: 'aave',
      sellVenue: 'aave',
      outcome: 'yes',
      rate: '0.05',
      nextPaymentAt: 0,
      intervalMs: 0,
    },
    pnl: '0',
    fees: '0',
    created_at: new Date(time),
    closed_at: null,
  }
}
function makeLeg(
  action: ExecutionIntent['action'],
  quantity = '50',
  status: 'filled' | 'rejected' = 'filled',
): ExecutionLeg {
  const approval = ['approve', 'revoke'].includes(action)
  return {
    id: `${action}-1`,
    operation_id: 'op-1',
    sequence: 1,
    role: action,
    state: 'terminal',
    prepared: {
      intent: {
        clientId: `${action}-1`,
        venue: 'aave',
        action,
        symbol: 'USDC',
        quantity,
        limitPrice: '1',
        quoteBudget: '50',
        positionQuantity: '50',
        expiresAt: time + 1000,
      },
      payload: {},
      externalId: `test:${action}-1`,
    },
    receipt: {
      status,
      externalId: `test:${action}-1`,
      filledQuantity: approval || status === 'rejected' ? '0' : quantity,
      grossQuote: approval || status === 'rejected' ? '0' : quantity,
      quoteFee: '0',
      baseFee: '0',
    },
    created_at: new Date(time),
  }
}
function action(decision: ExecutionDecision) {
  if (decision.type !== 'leg') throw new Error(`expected leg, received ${decision.type}`)
  return decision.intent
}
describe('Aave supply driver', () => {
  it('uses fresh public APY for paper and reserves at most half the allocation', async () => {
    const driver = createDefiDriver('paper', null, source, { now: () => time })
    expect(await driver.accounts(portfolio())).toEqual([{ identity: 'paper:aave', venue: 'aave' }])
    expect(await driver.plan(portfolio())).toMatchObject({
      reserve: '50',
      plan: { quantity: '50', rate: '0.05' },
    })
    expect(await driver.plan({ ...portfolio(), cash: '17.500001' })).toMatchObject({
      reserve: '17.500001',
    })
    expect(
      await createDefiDriver('paper', null, source, { now: () => time + 4_000_000 }).plan(
        portfolio(),
      ),
    ).toBeNull()
    expect(await createDefiDriver('paper', null).plan(portfolio())).toBeNull()
    expect(
      await createDefiDriver('paper', null, async () => ({ apyBps: -1, observedAt: time }), {
        now: () => time,
      }).plan(portfolio()),
    ).toBeNull()
  })

  it('makes approval and supply independent legs and returns only virtual interest in paper', async () => {
    let clock = time
    const d = createDefiDriver('paper', null, source, { now: () => clock })
    const p = portfolio(),
      op = operation()
    expect(action(await d.decide(p, op, [])).action).toBe('approve')
    const approval = makeLeg('approve')
    expect(action(await d.decide(p, op, [approval])).action).toBe('supply')
    const supply = makeLeg('supply')
    clock += 24 * 60 * 60 * 1000
    const withdrawal = action(await d.decide(p, op, [approval, supply]))
    expect(withdrawal.action).toBe('withdraw')
    expect(withdrawal.quantity).toBe('50.006849')
    const prepared = await d.adapter('aave').prepare(withdrawal)
    expect(prepared.payload.paper).toBe(true)
    expect(await d.adapter('aave').lookup(prepared)).toMatchObject({
      status: 'filled',
      filledQuantity: '50.006849',
    })
    expect(await d.decide(p, op, [approval, supply, makeLeg('withdraw', '50.006849')])).toEqual({
      type: 'close',
      pnl: '0.006849',
      fees: '0',
    })
  })

  it('clears permission if the owner stops between approval and deposit', async () => {
    const d = createDefiDriver('paper', null, source, { now: () => time })
    const p = { ...portfolio(), close_requested: true }
    expect(action(await d.decide(p, operation(), [makeLeg('approve')]))).toMatchObject({
      action: 'revoke',
      quantity: '0',
    })
    expect(await d.decide(p, operation(), [makeLeg('approve'), makeLeg('revoke', '0')])).toEqual({
      type: 'close',
      pnl: '0',
      fees: '0',
    })
  })

  it('does not assume a failed or unknown approval succeeded', async () => {
    const d = createDefiDriver('paper', null, source, { now: () => time })
    expect(
      await d.decide(portfolio(), operation(), [makeLeg('approve', '50', 'rejected')]),
    ).toEqual({ type: 'attention', reason: 'EXECUTION_DEFI_APPROVAL_FAILED' })
    expect(
      await d.decide(portfolio(), operation(), [{ ...makeLeg('approve'), state: 'unknown' }]),
    ).toEqual({ type: 'attention', reason: 'EXECUTION_DEFI_UNCERTAIN_TRANSACTION' })
    expect(
      action(
        await d.decide(portfolio(), operation(), [
          makeLeg('approve'),
          makeLeg('supply', '50', 'rejected'),
        ]),
      ).action,
    ).toBe('revoke')
  })

  it('checks dedicated wallet, chain mode, token balance and gas before external activation', async () => {
    const f = aaveRpcFixture()
    const driver = createDefiDriver('demo', f.config, source, { rpc: f.rpc, now: () => time })
    const initial = { ...portfolio('demo'), started_at: null }
    await expect(driver.accounts(initial)).rejects.toThrow('DEDICATED_WALLET_REQUIRED')
    expect(await driver.accounts(portfolio('demo'))).toHaveLength(1)
    f.state.supplied = 0n
    expect(await driver.accounts(initial)).toEqual([
      { identity: `aave:11155111:${f.config.sender.toLowerCase()}`, venue: 'aave' },
    ])
    expect(await driver.plan(portfolio('demo'))).toMatchObject({
      reserve: '10',
      plan: { quantity: '10' },
    })
    f.state.wallet = 1n
    await expect(driver.accounts(initial)).rejects.toThrow('BALANCE')
    expect(() => createDefiDriver('live', f.config)).toThrow('NETWORK_MISMATCH')
    expect(() => createDefiDriver('demo', null)).toThrow('WALLET_REQUIRED')
  })

  it('uses actual aToken balance for redeem and never labels APY estimates as real income', async () => {
    const f = aaveRpcFixture()
    const d = createDefiDriver('demo', f.config, source, { rpc: f.rpc, now: () => time + 1000 })
    const p = portfolio('demo'),
      op = operation('demo')
    op.reserve = op.plan.quantity = '5'
    f.state.supplied = 5_100_000n
    f.state.allowance = 0n
    const supply = makeLeg('supply', '5')
    expect(await d.decide(p, op, [supply])).toEqual({ type: 'hold', pnl: '0.1', fees: '0' })
    expect(action(await d.decide({ ...p, close_requested: true }, op, [supply]))).toMatchObject({
      action: 'withdraw',
      quantity: '5.1',
      positionQuantity: '5.1',
    })
    f.state.supplied = 0n
    expect(await d.decide(p, op, [supply, makeLeg('withdraw', '5.1')])).toEqual({
      type: 'close',
      pnl: '0.1',
      fees: '0',
    })
  })

  it('reads the pinned reserve rate for private plans without a public yield callback', async () => {
    const f = aaveRpcFixture()
    f.state.supplied = 0n
    const d = createDefiDriver('demo', f.config, undefined, { rpc: f.rpc, now: () => time })
    expect(await d.plan(portfolio('demo'))).toMatchObject({
      plan: { quantity: '10', rate: '0.05' },
    })
    f.state.rateRay = 0n
    expect(await d.plan(portfolio('demo'))).toBeNull()
  })

  it('exits on loss and keeps residual supply visible after the bounded recovery limit', async () => {
    const f = aaveRpcFixture()
    const d = createDefiDriver('demo', f.config, source, { rpc: f.rpc, now: () => time + 1000 })
    const op = operation('demo'),
      p = portfolio('demo')
    f.state.supplied = 40_000_000n
    expect(action(await d.decide(p, op, [makeLeg('supply')])).action).toBe('withdraw')
    f.state.supplied = 1n
    expect(
      await d.decide({ ...p, close_requested: true }, op, [
        makeLeg('supply'),
        makeLeg('withdraw', '10'),
        makeLeg('withdraw', '10'),
        makeLeg('withdraw', '10'),
      ]),
    ).toEqual({ type: 'attention', reason: 'EXECUTION_DEFI_REMAINING_SUPPLY' })
  })
})
