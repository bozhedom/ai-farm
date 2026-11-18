import { z } from 'zod'
import type { ExecutionMode, ExecutionTrack } from './types'
import type { TradingExchange } from '../trading/types'
import type { VenueAccess } from '../trading/wire'

/** REST submission alone is not an execution adapter: reconciliation and accounting are required.
 * These books still contain placeholder receipts, account checks or income calculations.
 * Keep Paper available; no environment flag can promote incomplete code to Demo/Live.
 */
export function assertExecutionAdapterReady(
  mode: ExecutionMode,
  track: ExecutionTrack,
  venue = 'bybit',
) {
  if (mode === 'paper') return
  if (
    ['futures', 'margin', 'earn', 'swap', 'options'].includes(track) ||
    (track === 'funding' && venue !== 'bybit')
  )
    throw new Error('EXECUTION_ADAPTER_INCOMPLETE')
}

const flag = (name: string) => process.env[name] === 'true'
export function executionWritesAllowed(mode: ExecutionMode, track: ExecutionTrack) {
  if (mode === 'paper') return
  assertExecutionAdapterReady(mode, track)
  if (
    mode === 'live' &&
    (!flag('EXECUTION_LIVE_ENABLED') ||
      !(process.env.EXECUTION_LIVE_ACCEPTED_TRACKS || '').split(',').includes(track))
  )
    throw new Error('EXECUTION_LIVE_DISABLED')
}
export function executionSecret(name: string) {
  return process.env[`EXECUTION_${name}`] || ''
}
export function spotAccess(exchange: TradingExchange, mode: ExecutionMode): VenueAccess {
  const prefix = `ARBITRAGE_${exchange.toUpperCase()}_${mode.toUpperCase()}`
  const credentials = {
    key: executionSecret(`${prefix}_API_KEY`),
    secret: executionSecret(`${prefix}_SECRET`),
    passphrase: executionSecret(`${prefix}_PASSPHRASE`),
  }
  if (
    !credentials.key ||
    !credentials.secret ||
    (['okx', 'bitget'].includes(exchange) && !credentials.passphrase)
  )
    throw new Error('EXECUTION_CREDENTIALS_REQUIRED')
  return { credentials, authorize: () => executionWritesAllowed(mode, 'arbitrage') }
}

/** Token identity is owner-verified server configuration, never inferred from a shared ticker. */
const assetSchema = z
  .array(
    z
      .object({
        symbol: z.string().regex(/^[A-Z0-9]{1,32}-USDT$/),
        identity: z.string().min(3).max(200),
        exchanges: z.array(z.enum(['okx', 'bybit', 'binance', 'bitget'])).min(2),
      })
      .strict(),
  )
  .max(500)
export function verifiedAssets() {
  try {
    return assetSchema.parse(JSON.parse(executionSecret('ARBITRAGE_ASSETS') || '[]'))
  } catch {
    throw new Error('EXECUTION_ASSET_REGISTRY_INVALID')
  }
}

function hasVenueKeys(prefix: string, suffix: string, names: string[]) {
  return names.some((name) => {
    const key = executionSecret(`${prefix}_${name}_${suffix}_API_KEY`)
    const secret = executionSecret(`${prefix}_${name}_${suffix}_SECRET`)
    if (!key || !secret) return false
    if (
      ['OKX', 'BITGET'].includes(name) &&
      !executionSecret(`${prefix}_${name}_${suffix}_PASSPHRASE`)
    )
      return false
    return true
  })
}
export function executionReady(track: ExecutionTrack, mode: ExecutionMode, venue = 'bybit') {
  if (mode === 'paper') return ''
  try {
    assertExecutionAdapterReady(mode, track, venue)
    executionWritesAllowed(mode, track)
    const suffix = mode.toUpperCase()
    if (
      track === 'prediction' &&
      (!executionSecret(`PREDICTION_KALSHI_${suffix}_KEY_ID`) ||
        !executionSecret(`PREDICTION_KALSHI_${suffix}_PRIVATE_KEY`))
    )
      return 'EXECUTION_CREDENTIALS_REQUIRED'
    if (track === 'defi' && !executionSecret(`DEFI_${suffix}_CONFIG`))
      return 'EXECUTION_WALLET_REQUIRED'
    if (track === 'arbitrage' && !verifiedAssets().length)
      return 'EXECUTION_ASSET_REGISTRY_REQUIRED'
    if (
      track === 'funding' &&
      !hasVenueKeys('FUNDING', suffix, ['BYBIT', 'OKX', 'BINANCE', 'BITGET'])
    )
      return 'EXECUTION_CREDENTIALS_REQUIRED'
    if (
      (track === 'futures' || track === 'margin') &&
      !hasVenueKeys(track === 'futures' ? 'FUTURES' : 'MARGIN', suffix, [
        'BYBIT',
        'OKX',
        'BINANCE',
        'BITGET',
      ])
    )
      return 'EXECUTION_CREDENTIALS_REQUIRED'
    if (track === 'earn' && !hasVenueKeys('EARN', suffix, ['BYBIT', 'OKX', 'BINANCE']))
      return 'EXECUTION_CREDENTIALS_REQUIRED'
    if (
      track === 'swap' &&
      (!executionSecret(`SWAP_${suffix}_RPC_URL`) ||
        !executionSecret(`SWAP_${suffix}_PRIVATE_KEY`) ||
        !executionSecret(`SWAP_${suffix}_SENDER`))
    )
      return 'EXECUTION_WALLET_REQUIRED'
    if (track === 'options' && !hasVenueKeys('OPTIONS', suffix, ['BYBIT', 'OKX']))
      return 'EXECUTION_CREDENTIALS_REQUIRED'
    return ''
  } catch (e) {
    return e instanceof Error && /^EXECUTION_[A-Z_]+$/.test(e.message)
      ? e.message
      : 'EXECUTION_CONFIG_INVALID'
  }
}
