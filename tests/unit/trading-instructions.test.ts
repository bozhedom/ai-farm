import { expect, it } from 'vitest'
import { parseTradingInstructions } from '../../core/trading/instructions'
import {
  defaultTradingRules,
  instructionInterpretationSchema,
} from '../../core/contracts/trading-instructions'
import { ownerEntryReason, ownerSignal, validateTradingRules } from '../../core/trading/owner-rules'
import { sizeOrder } from '../../core/trading/strategy'
import { cost, fee, units } from '../../core/trading/decimal'
import { agent, market } from '../fixtures/trading'

it('parses complete owner commands, including decimal amounts, without silently accepting extra text', () => {
  const parsed = parseTradingInstructions(
    'Не покупать BTC и ETH; Покупка не больше 7,5 USDT\nСтоп-лосс 1,25%',
  )!
  expect(parsed.rules).toMatchObject({
    blockedSymbols: ['BTC-USDT', 'ETH-USDT'],
    maxOrderUsdt: '7.5',
    positionStopBps: 125,
  })
  expect(parseTradingInstructions('Не покупать BTC; а ещё торговать по новостям')).toBeNull()
  expect(parseTradingInstructions('Покупка не больше 7 USDT; покупка не больше 9 USDT')).toBeNull()
  expect(() => parseTradingInstructions('Покупка не больше 100 USDT')).toThrow(
    'TRADING_INSTRUCTION_ORDER_LIMIT',
  )
})

it('refuses action fields, policy escalation and contradictory restrictions from a model', () => {
  expect(
    instructionInterpretationSchema.safeParse({
      rules: defaultTradingRules(),
      managerNotes: [],
      issues: [],
      shell: 'command',
    }).success,
  ).toBe(false)
  expect(() => validateTradingRules({ ...defaultTradingRules(), positionStopBps: 999 })).toThrow()
  expect(() =>
    validateTradingRules({
      ...defaultTradingRules(),
      allowedSymbols: ['BTC-USDT'],
      blockedSymbols: ['BTC-USDT'],
    }),
  ).toThrow('TRADING_INSTRUCTION_CONFLICT')
})

it('sizes purchases within the owner amount including fees and exchange minimums', () => {
  const m = market(),
    a = agent()
  const order = sizeOrder(a, m, 'buy', 'test', undefined, units('7'))!
  expect(cost(order.qty, order.price) + fee(cost(order.qty, order.price), 25)).toBeLessThanOrEqual(
    units('7'),
  )
  m.instrument.minNotional = units('8')
  expect(sizeOrder(a, m, 'buy', 'test', undefined, units('7'))).toBeNull()
})

it('blocks only entries while keeping mandatory exits and tighter owner stops available', () => {
  const r = {
    ...defaultTradingRules(),
    pauseEntries: true,
    blockedSymbols: ['BTC-USDT'],
    positionStopBps: 100,
  }
  expect(ownerEntryReason(r, agent())).toBe('OWNER_ENTRIES_PAUSED')
  const a = agent({
    base: units('0.1').toString(),
    basis: units('10').toString(),
    position_opened_at: new Date(),
  })
  expect(
    ownerSignal(r, a, market('BTC-USDT', '98.8'), { side: null, reason: 'HOLDING_POSITION' }),
  ).toEqual({ side: 'sell', reason: 'OWNER_POSITION_STOP' })
  expect(ownerSignal(r, a, market(), { side: 'sell', reason: 'RISK_EXIT' })).toEqual({
    side: 'sell',
    reason: 'RISK_EXIT',
  })
})
