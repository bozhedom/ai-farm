import { OkxVenue } from '../core/trading/okx'
import { validateMarket } from '../core/trading/strategy'
import { decimal } from '../core/trading/decimal'
import { TRADING_POLICY } from '../core/policy'
import { safeTradingError } from '../core/trading/engine'
import { pool } from '../core/db'

// Read-only connection check. This command never initializes a portfolio or submits an order.
const mode = process.argv[2] || 'paper'
if (!['paper', 'demo', 'live'].includes(mode)) throw new Error('EXPECTED_PAPER_DEMO_OR_LIVE')
try {
  const venue = new OkxVenue(mode as 'paper' | 'demo' | 'live')
  for (const symbol of TRADING_POLICY.symbols) {
    const m = await venue.market(symbol)
    validateMarket(m)
    console.log(
      `${symbol}: bid ${decimal(m.book.bids[0]![0])}, ask ${decimal(m.book.asks[0]![0])}; ${m.candles.length} closed candles; market OK`,
    )
  }
  if (mode !== 'paper') {
    await venue.account()
    if ((await venue.pending()).length) throw new Error('TRADING_EXTERNAL_ORDERS')
    console.log(`${mode}: credentials, permissions, account mode, balance format and fees OK`)
  }
} catch (error) {
  console.error(safeTradingError(error))
  process.exitCode = 1
} finally {
  await pool.end()
}
