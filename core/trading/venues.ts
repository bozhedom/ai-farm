import { OkxVenue } from './okx'
import { BybitVenue } from './bybit'
import { BinanceVenue } from './binance'
import { BitgetVenue } from './bitget'
import type { TradingScope, TradingVenue } from './types'

export function createVenue(s: TradingScope): TradingVenue {
  switch (s.exchange) {
    case 'okx':
      return new OkxVenue(s.mode)
    case 'bybit':
      return new BybitVenue(s.mode)
    case 'binance':
      return new BinanceVenue(s.mode)
    case 'bitget':
      return new BitgetVenue(s.mode)
  }
}
