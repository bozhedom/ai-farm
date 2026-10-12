import { describe, expect, it } from 'vitest'
import { TRADING_POLICY as P } from '../../core/policy'
import { decimal, units, cost } from '../../core/trading/decimal'
import { applyFill, paperFill, riskReason } from '../../core/trading/accounting'
import { eligible, signal, sizeOrder, validateMarket } from '../../core/trading/strategy'
import { agent, market } from '../fixtures/trading'

describe('spot accounting and risk', () => {
  it('round-trips exact decimals without IEEE-754 or exponent notation', () => {
    for (const value of [
      '0',
      '100',
      '-0.000000000000000001',
      '0.100000000000000001',
      '999999999999999999999999.99',
    ])
      expect(decimal(units(value))).toBe(value)
    for (const value of ['NaN', 'Infinity', '1e-8', '0.0000000000000000001', ' 1', '1.'])
      expect(() => units(value)).toThrow()
    expect(cost(units('0.00000001'), units('83991.4'))).toBe(units('0.000839914'))
  })

  it('sizes a buy below cash/order caps and charges adverse execution and fees', () => {
    const a = agent(),
      m = market()
    const order = sizeOrder(a, m, 'buy', 'test')!
    expect(cost(order.qty, order.price)).toBeLessThanOrEqual(units('10'))
    const fill = paperFill(order, m.book, m.instrument.lot)
    expect(fill.filledQty).toBe(order.qty)
    expect(fill.quoteFee).toBeLessThan(0n)
    const booked = applyFill(a, fill, m.instrument.minQty)
    expect(booked.cash + booked.basis).toBe(units('25'))
    expect(booked.fees).toBe(-fill.quoteFee)
    expect(booked.base).toBe(order.qty)
  })

  it('respects exchange minimum notional for both entries and exits', () => {
    const m = market()
    m.instrument.minNotional = units('10')
    expect(sizeOrder(agent(), m, 'buy', 'min')).toBeNull()
    expect(sizeOrder(agent({ base: units('0.01').toString() }), m, 'sell', 'dust')).toBeNull()
    expect(sizeOrder(agent({ base: units('0.2').toString() }), m, 'sell', 'exit')).not.toBeNull()
  })

  it('walks depth and books partial IOC cancellation exactly once at settlement', () => {
    const m = market()
    m.book.asks[0]![1] = units('0.01')
    const a = agent(),
      order = sizeOrder(a, m, 'buy', 'partial')!
    const fill = paperFill(order, m.book, m.instrument.lot)
    expect(fill.state).toBe('canceled')
    expect(fill.filledQty).toBe(units('0.01'))
    const held = applyFill(a, fill, m.instrument.minQty)
    expect(held.base).toBe(fill.filledQty)
    expect(held.cash).toBeLessThan(units('25'))
    m.book.asks[0]![0] = order.price + 1n
    expect(paperFill(order, m.book, m.instrument.lot).filledQty).toBe(0n)
  })

  it('accounts for base-denominated buy fees and quote-denominated sale fees', () => {
    const m = market(),
      a = agent()
    const bought = applyFill(
      a,
      {
        clientId: 'fee',
        symbol: 'BTC-USDT',
        side: 'buy',
        qty: units('0.1'),
        price: units('100'),
        exchangeId: '1',
        state: 'filled',
        filledQty: units('0.1'),
        quote: units('10'),
        baseFee: units('-0.0001'),
        quoteFee: 0n,
      },
      m.instrument.minQty,
    )
    expect(bought.base).toBe(units('0.0999'))
    expect(bought.basis).toBe(units('10'))
    const held = agent({
      cash: bought.cash.toString(),
      base: bought.base.toString(),
      basis: bought.basis.toString(),
      fees: bought.fees.toString(),
    })
    const sold = applyFill(
      held,
      {
        clientId: 'sell',
        symbol: 'BTC-USDT',
        side: 'sell',
        qty: bought.base,
        price: units('110'),
        exchangeId: '2',
        state: 'filled',
        filledQty: bought.base,
        quote: units('10.989'),
        baseFee: 0n,
        quoteFee: units('-0.010989'),
      },
      m.instrument.minQty,
    )
    expect(sold.cash).toBe(units('25.978011'))
    expect(sold.realized).toBe(units('0.978011'))
    expect(sold.base).toBe(0n)
    expect(sold.basis).toBe(0n)
    expect(sold.roundTrips).toBe(1)
    expect(sold.fees).toBe(units('0.020989'))
  })

  it('refuses excess fills, fees, spending and executions outside the price limit', () => {
    const m = market(),
      a = agent(),
      order = sizeOrder(a, m, 'buy', 'bad')!
    const fill = paperFill(order, m.book, m.instrument.lot)
    expect(() => applyFill(a, { ...fill, filledQty: order.qty + 1n }, m.instrument.minQty)).toThrow(
      'TRADING_FILL_INVALID',
    )
    expect(() => applyFill(a, { ...fill, quote: units('11') }, m.instrument.minQty)).toThrow(
      'TRADING_FILL_OUTSIDE_LIMIT',
    )
    expect(() => applyFill(a, { ...fill, quoteFee: units('-1') }, m.instrument.minQty)).toThrow(
      'TRADING_FEE_TOO_HIGH',
    )
    expect(() => applyFill(agent({ cash: '0' }), fill, m.instrument.minQty)).toThrow(
      'TRADING_BALANCE_NEGATIVE',
    )
  })

  it('reacts at the daily and peak drawdown thresholds, including unrealized losses', () => {
    expect(riskReason(units('98'), units('100'), units('100'))).toBe('DAILY_LOSS_LIMIT')
    expect(riskReason(units('90'), units('100'), units('91'))).toBe('DRAWDOWN_LIMIT')
    expect(riskReason(units('98.000001'), units('100'), units('100'))).toBe('')
  })

  it('applies the fee ceiling to combined quote and base charges', () => {
    const m = market(),
      a = agent(),
      order = sizeOrder(a, m, 'buy', 'combinedfees')!
    const fill = paperFill(order, m.book, m.instrument.lot)
    expect(() =>
      applyFill(
        a,
        { ...fill, baseFee: -fill.filledQty / 400n, quoteFee: -fill.quote / 400n },
        m.instrument.minQty,
      ),
    ).toThrow('TRADING_FEE_TOO_HIGH')
  })
})

describe('spot hypotheses', () => {
  it('uses closed candles and refuses stale/crossed/gapped/wide markets', () => {
    const m = market()
    expect(() => validateMarket(m)).not.toThrow()
    expect(() =>
      validateMarket({ ...m, book: { ...m.book, at: Date.now() - P.bookMaxAgeMs - 1 } }),
    ).toThrow('TRADING_STALE_MARKET')
    expect(() => validateMarket({ ...m, book: { ...m.book, asks: m.book.bids } })).toThrow(
      'TRADING_BOOK_INVALID',
    )
    expect(() => validateMarket(market('BTC-USDT', '1', '1'))).toThrow('TRADING_SPREAD_TOO_WIDE')
    const wide = market()
    wide.book.bids[0]![0] = units('100')
    wide.book.asks[0]![0] = units('100.20001')
    expect(() => validateMarket(wide)).toThrow('TRADING_SPREAD_TOO_WIDE')
    m.candles.splice(10, 1)
    expect(() => validateMarket(m)).toThrow('TRADING_CANDLES_INVALID')
  })

  it('waits without a signal, enters a dip and exits for a stop or net take profit', () => {
    expect(signal(agent(), market()).side).toBe('buy')
    expect(signal(agent(), market('BTC-USDT', '102', '102')).side).toBeNull()
    const held = agent({ base: units('0.1').toString(), basis: units('10').toString() })
    expect(signal(held, market('BTC-USDT', '96')).reason).toBe('POSITION_STOP')
    expect(signal(held, market('BTC-USDT', '102')).reason).toBe('TAKE_PROFIT')
    expect(signal(held, market(), true).reason).toBe('RISK_EXIT')
  })

  it('does not promote an immature, losing or deeply drawn-down agent', () => {
    const a = agent({
      created_at: new Date(Date.now() - 8 * 86_400_000),
      round_trips: 20,
      realized: units('1').toString(),
    })
    expect(eligible(a)).toBe(true)
    expect(eligible({ ...a, created_at: new Date() })).toBe(false)
    expect(eligible({ ...a, realized: '-1' })).toBe(false)
    expect(eligible({ ...a, max_drawdown_bps: 801 })).toBe(false)
  })
})
