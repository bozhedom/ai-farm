import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { EXECUTION_POLICY as P } from '../policy'
import { units, SCALE } from '../trading/decimal'
import { executionSecret, executionWritesAllowed } from './config'
import { createArbitrageDriver } from './drivers/arbitrage'
import { createFundingDriver } from './drivers/funding'
import { createDefiDriver } from './drivers/defi'
import { createPredictionDriver } from './drivers/prediction'
import { createFuturesDriver } from './drivers/futures'
import { createMarginDriver } from './drivers/margin'
import { createEarnDriver } from './drivers/earn'
import { createSwapDriver } from './drivers/swap'
import { createOptionsDriver } from './drivers/options'
import { assertAaveConfigNetwork } from './aave-networks'
import { createFundingVenue, fundingEnvPrefix } from './adapters/funding-venues'
import { createPaperFundingVenue } from './adapters/paper-funding'
import { createEarnClient } from './adapters/earn-venues'
import { createUniswapClient } from './adapters/uniswap'
import type { AaveSettings } from './adapters/aave'
import type { ExecutionDriver, ExecutionExchange, ExecutionPortfolio } from './types'
import { paperAaveYield } from './yield-source'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const pin = z
  .object({
    address,
    codeHash: hash,
    implementation: z.object({ address, codeHash: hash }).strict().optional(),
  })
  .strict()
const aaveConfig = z
  .object({
    rpcUrl: z.url(),
    network: z.enum(['local', 'testnet', 'live']),
    chainId: z.number().int().positive(),
    sender: address,
    pool: pin,
    token: pin,
    aToken: pin,
    confirmations: z.number().int().min(P.minConfirmations).max(64).default(P.minConfirmations),
  })
  .strict()
export function createExecutionDriver(p: ExecutionPortfolio): ExecutionDriver {
  const suffix = p.mode.toUpperCase()
  const read = (name: string) => executionSecret(name)
  const venueExchange = p.settings.venue || 'bybit'
  switch (p.track) {
    case 'arbitrage':
      return createArbitrageDriver(p.mode)
    case 'funding': {
      const exchange = p.settings.venue || 'bybit'
      const prefix = fundingEnvPrefix(exchange, p.mode === 'paper' ? 'demo' : p.mode)
      const options = {
        mode: (p.mode === 'paper' ? 'demo' : p.mode) as 'demo' | 'live',
        exchange,
        credentials: {
          key: read(`${prefix}_API_KEY`),
          secret: read(`${prefix}_SECRET`),
          passphrase: read(`${prefix}_PASSPHRASE`),
        },
        liveEnabled: process.env.EXECUTION_LIVE_ENABLED === 'true',
        authorizeWrite: () => {
          executionWritesAllowed(p.mode, p.track)
          return true
        },
      }
      const venue =
        p.mode === 'paper' && exchange !== 'bybit'
          ? createPaperFundingVenue(`paper-funding:${exchange}`)
          : createFundingVenue(options)
      return createFundingDriver(
        p.mode,
        {
          credentials: { key: options.credentials.key, secret: options.credentials.secret },
          liveEnabled: options.liveEnabled,
          demoFeeBps: { spot: P.maxFeeBps, perp: P.maxFeeBps },
          authorizeWrite: options.authorizeWrite,
        },
        { venue, exchange },
      )
    }
    case 'defi': {
      if (p.mode === 'paper') return createDefiDriver(p.mode, null, paperAaveYield)
      const raw = read(`DEFI_${suffix}_CONFIG`)
      if (!raw) throw new Error('EXECUTION_WALLET_REQUIRED')
      let settings: AaveSettings
      try {
        const conf = aaveConfig.parse(
          JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8')),
        )
        const key = hash.parse(read(`DEFI_${suffix}_PRIVATE_KEY`))
        settings = {
          ...conf,
          privateKey: key,
          decimals: 6,
          maxAmountAtoms: (units(p.capital) * 1_000_000n) / SCALE,
          maxGas: BigInt(P.defiMaxGas),
          maxFeePerGasWei: BigInt(P.defiMaxFeePerGasWei),
          maxGasCostWei: BigInt(P.defiMaxGasCostWei),
        } as AaveSettings
        assertAaveConfigNetwork(p.mode, (p.settings.defiNetwork || 'sepolia'), conf)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('EXECUTION_DEFI_')) throw error
        throw new Error('EXECUTION_WALLET_CONFIG_INVALID')
      }
      return createDefiDriver(p.mode, settings)
    }
    case 'prediction':
      return createPredictionDriver(
        p.mode,
        p.mode === 'paper'
          ? null
          : {
              mode: p.mode,
              keyId: read(`PREDICTION_KALSHI_${suffix}_KEY_ID`),
              privateKey: read(`PREDICTION_KALSHI_${suffix}_PRIVATE_KEY`).replaceAll('\\n', '\n'),
              accountId: read(`PREDICTION_KALSHI_${suffix}_ACCOUNT_ID`),
              subaccount: Number(read(`PREDICTION_KALSHI_${suffix}_SUBACCOUNT`) || '0'),
              liveEnabled: process.env.EXECUTION_LIVE_ENABLED === 'true',
              eligibilityConfirmed: read('PREDICTION_KALSHI_ELIGIBILITY_CONFIRMED') === 'true',
              maxQuoteAgeMs: P.prediction.maxQuoteAgeMs,
              requestTimeoutMs: P.prediction.requestTimeoutMs,
              maxPages: P.prediction.maxPages,
            },
      )

    case 'futures':
      return createFuturesDriver(p.mode, venueExchange)
    case 'margin':
      return createMarginDriver(p.mode, venueExchange)
    case 'earn':
      if ((p.settings.venue || 'bybit') === 'bitget') throw new Error('EXECUTION_EARN_VENUE_UNSUPPORTED')
      return createEarnDriver(
        p.mode,
        venueExchange,
        p.mode === 'paper'
          ? undefined
          : venueExchange === 'bitget'
            ? undefined
            : createEarnClient(venueExchange, p.mode, {
              key: read(`EARN_${venueExchange.toUpperCase()}_${suffix}_API_KEY`),
              secret: read(`EARN_${venueExchange.toUpperCase()}_${suffix}_SECRET`),
              passphrase: read(`EARN_${venueExchange.toUpperCase()}_${suffix}_PASSPHRASE`),
            }),
      )
    case 'swap':
      return createSwapDriver(
        p.mode,
        p.mode === 'paper'
          ? undefined
          : createUniswapClient(
              {
                rpcUrl: read(`SWAP_${suffix}_RPC_URL`),
                network: p.mode === 'live' ? 'mainnet' : 'sepolia',
                chainId: p.mode === 'live' ? 1 : 11155111,
                sender: address.parse(read(`SWAP_${suffix}_SENDER`)) as `0x${string}`,
                privateKey: hash.parse(read(`SWAP_${suffix}_PRIVATE_KEY`)) as `0x${string}`,
                slippageBps: (p.settings.slippageBps ?? P.swap.defaultSlippageBps),
              },
              {
                async quote() {
                  throw new Error('EXECUTION_WALLET_REQUIRED')
                },
              },
            ),
      )
    case 'options':
      return createOptionsDriver(p.mode, (p.settings.venue || 'bybit') === 'okx' ? 'okx' : 'bybit')
  }
}
