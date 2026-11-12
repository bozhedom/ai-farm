import { EXECUTION_POLICY as P } from '../../policy'
import type { ExecutionIntent } from '../types'
import type { SwapClient, SwapQuote } from '../drivers/swap'
import { BPS, units } from '../../trading/decimal'
import type { TradingSymbol } from '../../trading/types'

/** Official Uniswap V3 addresses. Owner must still supply RPC and a dedicated wallet. */
export const UNISWAP_V3 = Object.freeze({
  mainnet: Object.freeze({
    chainId: 1,
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF969196C3F0f',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  }),
  sepolia: Object.freeze({
    chainId: 11155111,
    /** Sepolia router addresses must be pinned in SWAP config after owner verification. */
    swapRouter02: '',
    quoterV2: '',
    usdc: '',
    weth: '',
  }),
})

export type UniswapSettings = {
  rpcUrl: string
  network: 'sepolia' | 'mainnet'
  chainId: number
  sender: `0x${string}`
  privateKey: `0x${string}`
  slippageBps: number
  /** Optional token-in / token-out overrides; otherwise USDC/WETH on mainnet. */
  tokenIn?: `0x${string}`
  tokenOut?: `0x${string}`
  poolFee?: number
}

export function uniswapSlippageCap(slippageBps: number) {
  if (slippageBps < 1 || slippageBps > P.swap.maxSlippageBps) throw new Error('EXECUTION_SLIPPAGE_FORBIDDEN')
  return slippageBps
}

/**
 * Builds a SwapClient that never broadcasts by itself. The execution engine persists the
 * prepared payload first; Live still requires EXECUTION_LIVE_ENABLED.
 */
export function createUniswapClient(
  settings: UniswapSettings,
  rpc: { quote: (amountIn: bigint) => Promise<SwapQuote>; encode?: (intent: ExecutionIntent, quote: SwapQuote) => Promise<{ payload: Record<string, string | number>; externalId: string | null }> },
): SwapClient {
  uniswapSlippageCap(settings.slippageBps)
  if (settings.network === 'mainnet' && settings.chainId !== 1) throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  if (settings.network === 'sepolia' && settings.chainId !== 11155111)
    throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  return {
    async quote(symbol: TradingSymbol, amountIn: bigint) {
      if (amountIn <= 0n) throw new Error('EXECUTION_ORDER_SIZE')
      void symbol
      return rpc.quote(amountIn)
    },
    async prepareSwap(intent, quote) {
      if (rpc.encode) return rpc.encode(intent, quote)
      const minOut = (quote.midOut * (BPS - BigInt(settings.slippageBps))) / BPS
      return {
        externalId: null,
        payload: {
          chainId: settings.chainId,
          sender: settings.sender,
          router: settings.network === 'mainnet' ? UNISWAP_V3.mainnet.swapRouter02 : '',
          amountIn: String(quote.amountIn),
          minOut: String(minOut),
          nonce: 0,
        },
      }
    },
  }
}

export function defaultMainnetTokens() {
  return { tokenIn: UNISWAP_V3.mainnet.usdc, tokenOut: UNISWAP_V3.mainnet.weth, fee: 500 }
}

export function parseSwapAmount(value: string) {
  const amount = units(value)
  if (amount <= 0n) throw new Error('EXECUTION_ORDER_SIZE')
  return amount
}
