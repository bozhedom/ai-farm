import { createHash, createHmac } from 'node:crypto'
import type { EarnClient } from '../drivers/earn'
import type { ExecutionExchange } from '../types'

export type EarnCredentials = { key: string; secret: string; passphrase?: string }

/**
 * Flexible earn/savings adapters. Paper does not use this client. Demo/Live request
 * builders are in place, but subscribe/redeem stay pending until account-specific product
 * IDs are accepted with the owner (no silent virtual fills).
 */
export function createEarnClient(
  exchange: Exclude<ExecutionExchange, 'bitget'>,
  mode: 'demo' | 'live',
  credentials: EarnCredentials,
): EarnClient {
  return {
    async identity() {
      return createHash('sha256').update(`${exchange}:${mode}:${credentials.key}`).digest('hex')
    },
    async available() {
      throw new Error('EXECUTION_EARN_ADAPTER_PENDING')
    },
    async rateBps() {
      throw new Error('EXECUTION_EARN_ADAPTER_PENDING')
    },
    async subscribe() {
      throw new Error('EXECUTION_EARN_ADAPTER_PENDING')
    },
    async redeem() {
      throw new Error('EXECUTION_EARN_ADAPTER_PENDING')
    },
  }
}

export function earnSign(secret: string, payload: string) {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function earnProductPath(exchange: Exclude<ExecutionExchange, 'bitget'>, action: 'subscribe' | 'redeem') {
  if (exchange === 'binance')
    return action === 'subscribe'
      ? '/sapi/v1/simple-earn/flexible/subscribe'
      : '/sapi/v1/simple-earn/flexible/redeem'
  if (exchange === 'okx')
    return action === 'subscribe' ? '/api/v5/finance/savings/purchase' : '/api/v5/finance/savings/redemption'
  return action === 'subscribe' ? '/v5/earn/place-order' : '/v5/earn/redeem'
}
