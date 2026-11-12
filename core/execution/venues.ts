import type { ExecutionExchange, ExecutionVenue } from './types'

export const executionExchanges = ['okx', 'bybit', 'binance', 'bitget'] as const

export function fundingVenue(exchange: ExecutionExchange): ExecutionVenue {
  return exchange === 'bybit' ? 'bybit-funding' : (`${exchange}-funding` as ExecutionVenue)
}

export function futuresVenue(exchange: ExecutionExchange): ExecutionVenue {
  return `${exchange}-futures` as ExecutionVenue
}

export function marginVenue(exchange: ExecutionExchange): ExecutionVenue {
  return `${exchange}-margin` as ExecutionVenue
}

export function earnVenue(exchange: ExecutionExchange): ExecutionVenue {
  if (exchange === 'bitget') throw new Error('EXECUTION_EARN_VENUE_UNSUPPORTED')
  return `${exchange}-earn` as ExecutionVenue
}

export function optionsVenue(exchange: 'okx' | 'bybit' | 'deribit'): ExecutionVenue {
  return `${exchange}-options` as ExecutionVenue
}
