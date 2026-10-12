import { describe, expect, it, vi } from 'vitest'
import { screen, listing, inspectCandidate, isSymbol } from '../../core/trading/universe'
import { units } from '../../core/trading/decimal'
import { emptyBalances, setBalance, compactSymbol } from '../../core/trading/wire'
import { market } from '../fixtures/trading'
import { OkxVenue } from '../../core/trading/okx'
import { BybitVenue } from '../../core/trading/bybit'
import { BinanceVenue } from '../../core/trading/binance'
import { BitgetVenue } from '../../core/trading/bitget'

const ticker = () => ({
  at: Date.now(),
  bid: '0.00000999',
  ask: '0.00001',
  last: '0.00001',
  open: '0.0000098',
  high: '0.0000102',
  low: '0.0000095',
  turnover: '15000000.000000000000000001',
})
const row = () => listing('PEPE', 'USDT', 'PEPEUSDT', { active: true }, ticker())[0]!

describe('market discovery and admission', () => {
  it('admits arbitrary spot names without allowing paths, derivatives or prototype keys', () => {
    for (const value of ['SOL-USDT', '1000SATS-USDT', 'PEPE-USDT', '1INCH-USDT', 'JUP-USDT'])
      expect(isSymbol(value)).toBe(true)
    for (const value of [
      'SOL/USDT',
      'SOL-USDC',
      'BTC-USDT-SWAP',
      'USDT-USDT',
      'btc-USDT',
      'SOL-USDT&limit=100',
      '__proto__-USDT',
    ]) {
      expect(isSymbol(value)).toBe(false)
      expect(() => compactSymbol(value as 'SOL-USDT')).toThrow('TRADING_SYMBOL_FORBIDDEN')
    }
    expect(listing('BTC', 'USDT', 'ETHUSDT', { active: true }, ticker())).toEqual([])
    expect(screen({ ...row(), symbol: 'JUP-USDT' }).reason).toBe('SCOUT_ON_RADAR')
  })
  it('keeps all balances, including tiny altcoin and unrelated holdings, without float rounding', () => {
    const b = emptyBalances()
    setBalance(b, 'PEPE', '123456789.000000000000000001', '123456789')
    setBalance(b, 'SOL', '0.000000000000000001', '0.000000000000000001')
    expect(b.PEPE!.total).toBe(units('123456789.000000000000000001'))
    expect(b.SOL!.total).toBe(1n)
    expect(() => setBalance(b, 'SOL', '1', '2')).toThrow('TRADING_BALANCE_INVALID')
  })
  it('screens activity, turnover, spread, stale data, listing age and abnormal jumps', () => {
    expect(screen(row())).toMatchObject({ reason: 'SCOUT_ON_RADAR', eligible: false })
    for (const [patch, reason] of [
      [{ active: false }, 'SCOUT_INACTIVE'],
      [{ restricted: true }, 'SCOUT_UNSUITABLE_ASSET'],
      [{ symbol: 'USDC-USDT' }, 'SCOUT_UNSUITABLE_ASSET'],
      [{ symbol: 'BTC3L-USDT' }, 'SCOUT_UNSUITABLE_ASSET'],
      [{ at: Date.now() - 120000 }, 'SCOUT_NO_DATA'],
      [{ listedAt: Date.now() - 3600000 }, 'SCOUT_NEW_LISTING'],
      [{ turnover: units('999999') }, 'SCOUT_LOW_VOLUME'],
      [{ ask: units('0.000011') }, 'TRADING_SPREAD_TOO_WIDE'],
      [{ high: units('0.00002') }, 'SCOUT_EXTREME_MOVE'],
      [{ low: units('0.00001'), high: units('0.00001001') }, 'SCOUT_QUIET'],
    ] as const)
      expect(screen({ ...row(), ...patch }).reason).toBe(reason)
  })
  it('requires recent movement, a complete history and executable depth on both sides', () => {
    const m = market('PEPE-USDT')
    const coin = screen(row())
    expect(inspectCandidate(coin, m)).toBe('SCOUT_QUIET')
    m.candles[0]!.close = units('104')
    expect(inspectCandidate(coin, m)).toBe('SCOUT_READY')
    m.instrument.minNotional = units('10')
    expect(inspectCandidate(coin, m)).toBe('SCOUT_ORDER_TOO_SMALL')
    expect(coin.eligible).toBe(false)
    m.instrument.minNotional = units('5')
    m.book.bids[0]![1] = units('0.01')
    expect(inspectCandidate({ ...coin, eligible: false }, m)).toBe('SCOUT_THIN_BOOK')
    m.candles = m.candles.slice(1)
    expect(inspectCandidate({ ...coin, eligible: false }, m)).toBe('SCOUT_SHORT_HISTORY')
  })

  for (const [exchange, Adapter] of Object.entries({
    okx: OkxVenue,
    bybit: BybitVenue,
    binance: BinanceVenue,
    bitget: BitgetVenue,
  })) {
    it(`${exchange}: joins the complete spot catalogue with exact tickers and isolates demo requests`, async () => {
      const at = Date.now()
      const transport = vi.fn<typeof fetch>(async (raw, options) => {
        const url = new URL(String(raw))
        const isInstrument = /instruments|exchangeInfo/.test(url.pathname)
        const data = ['PEPE', '1INCH'].map((base) => {
          if (exchange === 'okx')
            return isInstrument
              ? {
                  instId: base + '-USDT',
                  baseCcy: base,
                  quoteCcy: 'USDT',
                  instType: 'SPOT',
                  state: base === 'PEPE' ? 'live' : 'suspend',
                }
              : {
                  instId: base + '-USDT',
                  ts: String(at),
                  bidPx: '0.00000999',
                  askPx: '0.00001',
                  last: '0.00001',
                  open24h: '0.0000098',
                  high24h: '0.0000102',
                  low24h: '0.0000095',
                  volCcy24h: '15000000.000000000000000001',
                }
          if (exchange === 'binance')
            return isInstrument
              ? {
                  symbol: base + 'USDT',
                  baseAsset: base,
                  quoteAsset: 'USDT',
                  status: base === 'PEPE' ? 'TRADING' : 'BREAK',
                  isSpotTradingAllowed: true,
                }
              : {
                  symbol: base + 'USDT',
                  closeTime: at,
                  bidPrice: '0.00000999',
                  askPrice: '0.00001',
                  lastPrice: '0.00001',
                  openPrice: '0.0000098',
                  highPrice: '0.0000102',
                  lowPrice: '0.0000095',
                  quoteVolume: '15000000.000000000000000001',
                }
          return isInstrument
            ? {
                symbol: base + 'USDT',
                baseCoin: base,
                quoteCoin: 'USDT',
                status: base !== 'PEPE' ? 'offline' : exchange === 'bybit' ? 'Trading' : 'online',
              }
            : {
                symbol: base + 'USDT',
                ts: String(at),
                bid1Price: '0.00000999',
                ask1Price: '0.00001',
                lastPrice: '0.00001',
                prevPrice24h: '0.0000098',
                openPrice24h: '0.0000098',
                highPrice24h: '0.0000102',
                lowPrice24h: '0.0000095',
                turnover24h: '15000000.000000000000000001',
              }
        })
        if (exchange === 'bybit') expect(url.hostname).toBe('api-demo.bybit.com')
        if (exchange === 'binance') expect(url.hostname).toBe('testnet.binance.vision')
        if (exchange === 'okx')
          expect(options?.headers).toMatchObject({ 'x-simulated-trading': '1' })
        if (exchange === 'bitget') expect(options?.headers).toMatchObject({ paptrading: '1' })
        expect(url.searchParams.has('symbol')).toBe(false)
        expect(url.searchParams.has('cursor')).toBe(false)
        return new Response(
          JSON.stringify(
            exchange === 'bybit'
              ? { retCode: 0, result: { list: data } }
              : exchange === 'binance'
                ? isInstrument
                  ? { symbols: data }
                  : data
                : { code: exchange === 'okx' ? '0' : '00000', requestTime: at, data },
          ),
        )
      })
      const rows = await new Adapter('demo', transport).discover()
      expect(transport).toHaveBeenCalledTimes(2)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        symbol: 'PEPE-USDT',
        bid: units('0.00000999'),
        turnover: units('15000000.000000000000000001'),
      })
      expect(screen(rows[0]!).reason).toBe('SCOUT_ON_RADAR')
      expect(screen(rows[1]!).reason).toBe('SCOUT_INACTIVE')
    })
  }
})
