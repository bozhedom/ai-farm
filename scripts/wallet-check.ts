import { pool } from '../core/db'
import { WALLET_POLICY } from '../core/policy'
import { checkWalletKey } from '../core/wallet/sync'
import { parseInternal, parseOnchain } from '../core/wallet/math'
import { paymentAddress } from '../core/wallet/view'

/**
 * `npm run wallet:bybit:check`: checks that BYBIT_WALLET_READ_* is a read-only key and that it
 * can read the deposit history. Prints codes and counts only; never the key or the secret.
 * Records the key status for the office; stores no deposits (the worker does that).
 */
let exitCode = 0
try {
  const address = paymentAddress()
  console.log(
    address
      ? `Payment address: ${address.network} ${address.address}${address.memo ? ` memo ${address.memo}` : ''} (foreign clients only)`
      : 'Payment address: not configured (PAYMENT_USDT_ADDRESS, PAYMENT_USDT_NETWORK)',
  )
  const { status, client } = await checkWalletKey()
  if (!client) {
    console.log('Key: not configured (BYBIT_WALLET_READ_API_KEY, BYBIT_WALLET_READ_SECRET)')
    exitCode = 2
  } else {
    console.log(`Key: ${status}`)
    const end = Date.now()
    const start = end - WALLET_POLICY.windowMs + 60_000
    const onchain = (await client.pages('/v5/asset/deposit/query-record', start, end))
      .map(parseOnchain)
      .filter((r) => !!r)
    const internal = (await client.pages('/v5/asset/deposit/query-internal-record', start, end))
      .map(parseInternal)
      .filter((r) => !!r)
    const all = [...onchain, ...internal]
    console.log(
      `Deposits in 30 days: ${all.length} (on-chain ${onchain.length}, internal ${internal.length}), ` +
        `successful ${all.filter((r) => r.status === 'success').length}`,
    )
  }
} catch (error) {
  // Codes only: never request URLs, headers or secrets.
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
      ? error.message
      : 'WALLET_CHECK_FAILED'
  console.error(code)
  exitCode = 1
} finally {
  await pool.end().catch(() => {})
}
process.exit(exitCode)
