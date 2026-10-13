import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { EXECUTION_POLICY as P } from '../policy'
import { units, SCALE } from '../trading/decimal'
import { executionSecret, executionWritesAllowed } from './config'
import { createArbitrageDriver } from './drivers/arbitrage'
import { createFundingDriver } from './drivers/funding'
import { createDefiDriver } from './drivers/defi'
import { createPredictionDriver } from './drivers/prediction'
import type { AaveSettings } from './adapters/aave'
import type { ExecutionDriver, ExecutionPortfolio } from './types'
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
  switch (p.track) {
    case 'arbitrage':
      return createArbitrageDriver(p.mode)
    case 'funding':
      return createFundingDriver(p.mode, {
        credentials: {
          key: read(`FUNDING_BYBIT_${suffix}_API_KEY`),
          secret: read(`FUNDING_BYBIT_${suffix}_SECRET`),
        },
        liveEnabled: process.env.EXECUTION_LIVE_ENABLED === 'true',
        demoFeeBps: { spot: P.maxFeeBps, perp: P.maxFeeBps },
        authorizeWrite: () => {
          executionWritesAllowed(p.mode, p.track)
          return true
        },
      })
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
      } catch {
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
  }
}
