import { expect, it } from 'vitest'
import { isResidual } from '../../core/trading/residuals'
import { agent, market } from '../fixtures/trading'
import { units } from '../../core/trading/decimal'

it('only separates small unexecutable live holdings using a fresh market', () => {
  const a = agent({
    mode: 'live',
    base: units('0.000001').toString(),
    basis: units('0.0001').toString(),
  })
  const m = market()
  expect(isResidual(a, m)).toBe(true)
  expect(isResidual({ ...a, mode: 'paper' }, m)).toBe(false)
  expect(isResidual({ ...a, residual_only: true }, m)).toBe(false)
  expect(isResidual(a, undefined)).toBe(false)
  expect(isResidual(a, market('ETH-USDT'))).toBe(false)
  expect(isResidual({ ...a, base: units('0.01').toString() }, m)).toBe(false)
  m.instrument.minNotional = units('5')
  expect(isResidual({ ...a, base: units('0.009').toString() }, m)).toBe(true)
  expect(isResidual({ ...a, base: units('0.04').toString() }, m)).toBe(false)
  m.book.at -= 60000
  expect(() => isResidual(a, m)).toThrow('TRADING_STALE_MARKET')
})
