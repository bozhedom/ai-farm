import { encodeFunctionData, hexToBigInt, parseAbi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { EXECUTION_POLICY as P } from '../../policy'
import { BPS, units } from '../../trading/decimal'
import type { TradingSymbol } from '../../trading/types'
import type { PreparedExecution } from '../types'
import type { SwapClient, SwapQuote } from '../drivers/swap'
import { assertLiveWrite } from './rest'

/** Official Uniswap V3 addresses from the Uniswap SDK / Ethereum deployments page. */
export const UNISWAP_V3 = Object.freeze({
  mainnet: Object.freeze({
    chainId: 1,
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as Address,
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF969196C3F0f' as Address,
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    usdcDecimals: 6,
    wethDecimals: 18,
  }),
  sepolia: Object.freeze({
    chainId: 11155111,
    swapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E' as Address,
    quoterV2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3' as Address,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address,
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as Address,
    usdcDecimals: 6,
    wethDecimals: 18,
  }),
})

export const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])
export const SWAP_ROUTER_02_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
])

export type UniswapSettings = {
  rpcUrl: string
  network: 'sepolia' | 'mainnet'
  chainId: number
  sender: `0x${string}`
  privateKey: `0x${string}`
  slippageBps: number
  tokenIn?: `0x${string}`
  tokenOut?: `0x${string}`
  poolFee?: number
  liveEnabled?: boolean
}

export type EvmRpc = (method: string, params: unknown[]) => Promise<unknown>

export function uniswapSlippageCap(slippageBps: number) {
  if (slippageBps < 1 || slippageBps > P.swap.maxSlippageBps)
    throw new Error('EXECUTION_SLIPPAGE_FORBIDDEN')
  return slippageBps
}

export function pins(network: 'sepolia' | 'mainnet') {
  return UNISWAP_V3[network]
}

export function toTokenAtoms(amount18: bigint, decimals: number) {
  if (decimals === 18) return amount18
  if (decimals < 18) return amount18 / 10n ** BigInt(18 - decimals)
  return amount18 * 10n ** BigInt(decimals - 18)
}

export function fromTokenAtoms(atoms: bigint, decimals: number) {
  if (decimals === 18) return atoms
  if (decimals < 18) return atoms * 10n ** BigInt(18 - decimals)
  return atoms / 10n ** BigInt(decimals - 18)
}

export function httpRpc(url: string, fetchImpl: typeof fetch = fetch): EvmRpc {
  return async (method, params) => {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(7000),
      })
    } catch {
      throw new Error('EXECUTION_NETWORK_UNAVAILABLE')
    }
    if (!response.ok) throw new Error('EXECUTION_NETWORK_UNAVAILABLE')
    const raw = (await response.json()) as { result?: unknown; error?: { message?: string } }
    if (raw.error) throw new Error('EXECUTION_RPC_FAILED')
    return raw.result
  }
}

export function encodeExactInputSingle(p: {
  tokenIn: Address
  tokenOut: Address
  fee: number
  recipient: Address
  amountIn: bigint
  amountOutMinimum: bigint
}) {
  return encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        fee: p.fee,
        recipient: p.recipient,
        amountIn: p.amountIn,
        amountOutMinimum: p.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
}

export function createUniswapClient(
  settings: UniswapSettings,
  rpc?: EvmRpc,
  now: () => number = Date.now,
): SwapClient {
  uniswapSlippageCap(settings.slippageBps)
  if (settings.network === 'mainnet' && settings.chainId !== 1)
    throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  if (settings.network === 'sepolia' && settings.chainId !== 11155111)
    throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  const network = pins(settings.network)
  const tokenIn = (settings.tokenIn || network.usdc) as Address
  const tokenOut = (settings.tokenOut || network.weth) as Address
  const fee = settings.poolFee || 500
  const tokenInDecimals =
    tokenIn.toLowerCase() === network.weth.toLowerCase()
      ? network.wethDecimals
      : network.usdcDecimals
  const tokenOutDecimals =
    tokenOut.toLowerCase() === network.weth.toLowerCase()
      ? network.wethDecimals
      : network.usdcDecimals
  const evm = rpc || (settings.rpcUrl ? httpRpc(settings.rpcUrl) : undefined)

  async function quote(_symbol: TradingSymbol, amountIn: bigint): Promise<SwapQuote> {
    if (amountIn <= 0n) throw new Error('EXECUTION_ORDER_SIZE')
    if (!evm) throw new Error('EXECUTION_WALLET_REQUIRED')
    const atomsIn = toTokenAtoms(amountIn, tokenInDecimals)
    const data = encodeFunctionData({
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn: atomsIn, fee, sqrtPriceLimitX96: 0n }],
    })
    const result = (await evm('eth_call', [{ to: network.quoterV2, data }, 'latest'])) as string
    if (!result || result === '0x') throw new Error('EXECUTION_QUOTE_UNAVAILABLE')
    const amountOutAtoms = hexToBigInt((result as Hex).slice(0, 66) as Hex)
    const midOut = fromTokenAtoms(amountOutAtoms, tokenOutDecimals)
    const amountOut = (midOut * (BPS - BigInt(settings.slippageBps))) / BPS
    return { amountIn, amountOut, midOut, feeBps: Math.ceil(fee / 100), at: now() }
  }

  return {
    identity() {
      return settings.sender
    },
    quote,
    async prepareSwap(intent, quoted) {
      if (!evm) throw new Error('EXECUTION_WALLET_REQUIRED')
      const minOutAtoms = toTokenAtoms(quoted.amountOut, tokenOutDecimals)
      const amountInAtoms = toTokenAtoms(quoted.amountIn, tokenInDecimals)
      const data = encodeExactInputSingle({
        tokenIn,
        tokenOut,
        fee,
        recipient: settings.sender,
        amountIn: amountInAtoms,
        amountOutMinimum: minOutAtoms,
      })
      const nonceHex = (await evm('eth_getTransactionCount', [settings.sender, 'pending'])) as Hex
      const gasPriceHex = ((await evm('eth_gasPrice', [])) as Hex) || '0x1'
      const nonce = Number(hexToBigInt(nonceHex))
      const gasPrice = hexToBigInt(gasPriceHex)
      const account = privateKeyToAccount(settings.privateKey)
      const rawTransaction = await account.signTransaction({
        to: network.swapRouter02,
        data,
        chainId: settings.chainId,
        nonce,
        gas: 400000n,
        maxFeePerGas: gasPrice * 2n,
        maxPriorityFeePerGas: gasPrice,
        value: 0n,
        type: 'eip1559',
      })
      return {
        externalId: null,
        payload: {
          chainId: settings.chainId,
          sender: settings.sender,
          router: network.swapRouter02,
          amountIn: String(quoted.amountIn),
          minOut: String(quoted.amountOut),
          nonce,
          data,
          rawTransaction,
        },
      }
    },
    async broadcast(prepared: PreparedExecution) {
      if (settings.network === 'mainnet') assertLiveWrite('live', settings.liveEnabled)
      if (!evm) throw new Error('EXECUTION_WALLET_REQUIRED')
      const raw = prepared.payload.rawTransaction
      if (typeof raw !== 'string' || !raw.startsWith('0x'))
        throw new Error('EXECUTION_TRANSACTION_REQUIRED')
      const hash = (await evm('eth_sendRawTransaction', [raw])) as string
      prepared.externalId = hash
      prepared.payload.hash = hash
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
