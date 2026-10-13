import { z } from 'zod'
import type { ExecutionMode, ExecutionTrack } from './types'
import type { TradingExchange } from '../trading/types'
import type { VenueAccess } from '../trading/wire'

const flag = (name: string) => process.env[name] === 'true'
export function executionWritesAllowed(mode: ExecutionMode, track: ExecutionTrack) {
  if (mode === 'paper') return
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
export function executionReady(track: ExecutionTrack, mode: ExecutionMode) {
  if (mode === 'paper') return ''
  try {
    executionWritesAllowed(mode, track)
    const suffix = mode.toUpperCase()
    if (
      track === 'funding' &&
      (!executionSecret(`FUNDING_BYBIT_${suffix}_API_KEY`) ||
        !executionSecret(`FUNDING_BYBIT_${suffix}_SECRET`))
    )
      return 'EXECUTION_CREDENTIALS_REQUIRED'
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
    return ''
  } catch (e) {
    return e instanceof Error && /^EXECUTION_[A-Z_]+$/.test(e.message)
      ? e.message
      : 'EXECUTION_CONFIG_INVALID'
  }
}
