import { createVenue } from '../core/trading/venues'
import { exchanges, type TradingExchange } from '../core/trading/types'
import { validateMarket } from '../core/trading/strategy'
import { decimal } from '../core/trading/decimal'
import { screen } from '../core/trading/universe'
import { safeTradingError } from '../core/trading/engine'
import { pool } from '../core/db'

// Read-only connection check. This command never initializes a portfolio or submits an order.
const mode = process.argv[2] || 'paper'
const exchange = process.argv[3] || 'okx'
if (!exchanges.includes(exchange as TradingExchange)) throw new Error('EXPECTED_SUPPORTED_EXCHANGE')
if (!['paper', 'demo', 'live'].includes(mode)) throw new Error('EXPECTED_PAPER_DEMO_OR_LIVE')
try {
  const venue = createVenue({
    exchange: exchange as TradingExchange,
    mode: mode as 'paper' | 'demo' | 'live',
  })
  const listings = await venue.discover()
  const candidates = listings
    .map((row) => screen(row))
    .filter((c) => c.reason === 'SCOUT_ON_RADAR')
    .sort((a, b) => b.score - a.score)
  const symbols = candidates.slice(0, 2).map((c) => c.symbol)
  console.log(
    `${exchange}/${mode}: ${listings.length} USDT spot pairs, ${candidates.length} passed broad screening`,
  )
  for (const symbol of symbols) {
    const m = await venue.market(symbol)
    validateMarket(m)
    console.log(
      `${exchange}/${mode} ${symbol}: bid ${decimal(m.book.bids[0]![0])}, ask ${decimal(m.book.asks[0]![0])}; ${m.candles.length} closed candles; market OK`,
    )
  }
  if (mode !== 'paper') {
    await venue.account(symbols)
    if ((await venue.pending()).length) throw new Error('TRADING_EXTERNAL_ORDERS')
    console.log(`${mode}: credentials, permissions, account mode, balance format and fees OK`)
  }
} catch (error) {
  console.error(safeTradingError(error))
  process.exitCode = 1
} finally {
  await pool.end()
}
