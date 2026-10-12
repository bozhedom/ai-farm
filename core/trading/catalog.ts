import type { TradingExchange } from './types'

export const exchangeCatalog = {
  okx: {
    name: 'OKX',
    demoName: 'Demo Trading',
    account: 'Отдельный Spot / cash-аккаунт',
    apiUrl: 'https://www.okx.com/account/my-api',
    docs: 'https://www.okx.com/docs-v5/en/',
    passphrase: true,
  },
  bybit: {
    name: 'Bybit',
    demoName: 'Demo Trading',
    account: 'Выделенный Unified Trading Account без долгов и деривативов',
    apiUrl: 'https://www.bybit.com/app/user/api-management',
    docs: 'https://bybit-exchange.github.io/docs/v5/demo',
    passphrase: false,
  },
  binance: {
    name: 'Binance',
    demoName: 'Spot Testnet',
    account: 'Отдельный Spot-аккаунт; скидка комиссий в BNB выключена',
    apiUrl: 'https://www.binance.com/en/my/settings/api-management',
    docs: 'https://developers.binance.com/docs/binance-spot-api-docs/testnet',
    passphrase: false,
  },
  bitget: {
    name: 'Bitget',
    demoName: 'Demo Trading',
    account: 'Выделенный UTA в basic-режиме; списание комиссий в BGB выключено',
    apiUrl: 'https://www.bitget.com/account/newapi',
    docs: 'https://www.bitget.com/docs/uta/quick-start',
    passphrase: true,
  },
} as const satisfies Record<TradingExchange, unknown>
