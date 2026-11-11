import { afterEach, expect, it } from 'vitest'
import { config } from '../../core/config'
import { shortCycleSignal, orderCooldown, orderLimit } from '../../core/trading/short-cycle'
import { validateMarket } from '../../core/trading/strategy'
import { units } from '../../core/trading/decimal'
import { agent, market } from '../fixtures/trading'

const enabled = config().BYBIT_SHORT_CYCLE_ENABLED
afterEach(() => {
  config().BYBIT_SHORT_CYCLE_ENABLED = enabled
})
const holding = () =>
  agent({
    exchange: 'bybit',
    mode: 'live',
    base: units('0.1').toString(),
    basis: units('10').toString(),
    position_opened_at: new Date(Date.now() - 300_000),
  })
const hold = { side: null, reason: 'HOLDING_POSITION' } as const

it('times out Bybit positions at five minutes, even at a loss; never forces a buy', () => {
  config().BYBIT_SHORT_CYCLE_ENABLED = true
  const a = holding(),
    m = market()
  expect(shortCycleSignal(a, m, hold).reason).toBe('BYBIT_SHORT_TIME_EXIT')
  a.position_opened_at = new Date(Date.now() - 299_000)
  expect(shortCycleSignal(a, m, hold)).toEqual(hold)
  expect(
    shortCycleSignal(agent({ exchange: 'bybit' }), m, { side: null, reason: 'WAITING_SIGNAL' })
      .side,
  ).toBeNull()
  expect(
    shortCycleSignal({ ...a, exchange: 'okx', position_opened_at: new Date(0) }, m, hold),
  ).toEqual(hold)
  config().BYBIT_SHORT_CYCLE_ENABLED = false
  expect(shortCycleSignal(holding(), m, hold)).toEqual(hold)
})
it('preserves risk exits, stricter owner targets, and accounts for exit fee plus slippage', () => {
  config().BYBIT_SHORT_CYCLE_ENABLED = true
  const a = { ...holding(), position_opened_at: new Date() }
  const risk = { side: 'sell', reason: 'RISK_EXIT' } as const
  expect(shortCycleSignal(a, market(), risk)).toEqual(risk)
  expect(
    shortCycleSignal(a, market('BTC-USDT', '100.8'), { side: 'sell', reason: 'TAKE_PROFIT' }).side,
  ).toBeNull()
  expect(shortCycleSignal(a, market('BTC-USDT', '100.9'), hold).reason).toBe(
    'BYBIT_SHORT_TAKE_PROFIT',
  )
  expect(shortCycleSignal(a, market('BTC-USDT', '100.9'), hold, Date.now(), 200).side).toBeNull()
})
it('bounds increased frequency to Bybit and keeps owner limits', () => {
  config().BYBIT_SHORT_CYCLE_ENABLED = true
  expect(orderLimit({ exchange: 'bybit', mode: 'live' }, null)).toBe(600)
  expect(orderLimit({ exchange: 'bybit', mode: 'live' }, 20)).toBe(20)
  expect(orderLimit({ exchange: 'okx', mode: 'live' }, null)).toBe(40)
  expect(orderCooldown(holding(), 'sell')).toBe(0)
  expect(orderCooldown(holding(), 'buy')).toBe(30_000)
  expect(orderCooldown({ ...holding(), kind: 'grid' }, 'buy')).toBe(300_000)
})
it('wide spread blocks entries but not exits; stale or malformed books still block both', () => {
  const m = market()
  m.book.asks[0]![0] = units('102')
  expect(() => validateMarket(m)).toThrow('TRADING_SPREAD_TOO_WIDE')
  expect(() => validateMarket(m, Date.now(), 'exit')).not.toThrow()
  m.book.at -= 30_000
  expect(() => validateMarket(m, Date.now(), 'exit')).toThrow('TRADING_STALE_MARKET')
  m.book.at = Date.now()
  m.book.bids[0]![0] = units('103')
  expect(() => validateMarket(m, Date.now(), 'exit')).toThrow('TRADING_BOOK_INVALID')
})
