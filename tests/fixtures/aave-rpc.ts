import {
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionResult,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  AAVE_POOL_ABI,
  AAVE_TOKEN_ABI,
  type AaveRpc,
  type AaveSettings,
  type PreparedAaveTransaction,
} from '../../core/execution/adapters/aave'

// Deterministic public test fixture key. Never funded on a public chain.
const testKey = `0x${'01'.repeat(32)}` as Hex
const code = '0x60006000' as const
const aTokenAbi = parseAbi([
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function POOL() view returns (address)',
])
const abi = [...AAVE_TOKEN_ABI, ...AAVE_POOL_ABI, ...aTokenAbi]
const q = (n: bigint | number) => `0x${BigInt(n).toString(16)}`
const blankHash = `0x${'00'.repeat(32)}` as Hex
export function aaveRpcFixture() {
  const config: AaveSettings = {
    rpcUrl: 'http://127.0.0.1:18549',
    network: 'local',
    chainId: 11155111,
    privateKey: testKey,
    sender: privateKeyToAccount(testKey).address,
    pool: { address: '0x1000000000000000000000000000000000000001', codeHash: keccak256(code) },
    token: { address: '0x1000000000000000000000000000000000000002', codeHash: keccak256(code) },
    aToken: { address: '0x1000000000000000000000000000000000000003', codeHash: keccak256(code) },
    decimals: 6,
    confirmations: 3,
    maxAmountAtoms: 10_000_000n,
    maxGas: 500_000n,
    maxFeePerGasWei: 10_000_000_000n,
    maxGasCostWei: 5_000_000_000_000_000n,
  }
  const state = {
    chain: BigInt(config.chainId),
    version: 'anvil/v1.3.5',
    code: code as Hex,
    implementation: blankHash,
    decimals: 6,
    underlying: config.token.address,
    pool: config.pool.address,
    wallet: 100_000_000n,
    supplied: 20_000_000n,
    native: 100_000_000_000_000_000n,
    allowance: 0n,
    debt: 0n,
    rateRay: 50_000_000_000_000_000_000_000_000n,
    reserve: (6n << 48n) | (1n << 56n),
    latestNonce: 4n,
    pendingNonce: 4n,
    gasEstimate: 100_000n,
    baseFee: 1_000_000_000n,
    gasPrice: 1_500_000_000n,
    approvalOk: true,
    simulateWithdraw: null as bigint | null,
    head: 102n,
    blockHash: `0x${'bc'.repeat(32)}` as Hex,
    tx: null as Record<string, unknown> | null,
    receipt: null as Record<string, unknown> | null,
    sent: [] as Hex[],
    loseBroadcastResponse: false,
    calls: [] as string[],
  }
  const rpc: AaveRpc = async (method, params) => {
    state.calls.push(method)
    switch (method) {
      case 'eth_chainId':
        return q(state.chain)
      case 'web3_clientVersion':
        return state.version
      case 'eth_getCode':
        return state.code
      case 'eth_getStorageAt':
        return state.implementation
      case 'eth_getBalance':
        return q(state.native)
      case 'eth_getTransactionCount':
        return q(params[1] === 'pending' ? state.pendingNonce : state.latestNonce)
      case 'eth_estimateGas':
        return q(state.gasEstimate)
      case 'eth_gasPrice':
        return q(state.gasPrice)
      case 'eth_getBlockByNumber':
        return {
          baseFeePerGas: q(state.baseFee),
          hash: state.blockHash,
          number: params[0] === 'latest' ? q(state.head) : params[0],
        }
      case 'eth_blockNumber':
        return q(state.head)
      case 'eth_getTransactionByHash':
        return state.tx
      case 'eth_getTransactionReceipt':
        return state.receipt
      case 'eth_sendRawTransaction': {
        state.sent.push(params[0] as Hex)
        if (state.loseBroadcastResponse) throw new Error('timeout after accepting transaction')
        return keccak256(params[0] as Hex)
      }
      case 'eth_call': {
        const call = params[0] as { to: string; data: Hex }
        const decoded = decodeFunctionData({ abi, data: call.data })
        const args = decoded.args || []
        let result: unknown
        switch (decoded.functionName) {
          case 'decimals':
            result = state.decimals
            break
          case 'UNDERLYING_ASSET_ADDRESS':
            result = state.underlying
            break
          case 'POOL':
            result = state.pool
            break
          case 'balanceOf':
            result = call.to === config.token.address ? state.wallet : state.supplied
            break
          case 'allowance':
            result = state.allowance
            break
          case 'getUserAccountData':
            result = [0n, state.debt, 0n, 0n, 0n, 0n]
            break
          case 'getConfiguration':
            result = state.reserve
            break
          case 'getReserveData':
            result = [
              state.reserve,
              10n ** 27n,
              state.rateRay,
              0n,
              0n,
              0n,
              0n,
              0,
              config.aToken.address,
              config.aToken.address,
              config.aToken.address,
              config.pool.address,
              0n,
              0n,
              0n,
            ]
            break
          case 'approve':
            result = state.approvalOk
            break
          case 'withdraw':
            result = state.simulateWithdraw ?? args[1]
            break
          case 'supply':
            return '0x'
          default:
            throw new Error('unsupported fixture call')
        }
        return encodeFunctionResult({
          abi,
          functionName: decoded.functionName,
          result,
        } as Parameters<typeof encodeFunctionResult>[0])
      }
      default:
        throw new Error(`unsupported fixture rpc ${method}`)
    }
  }
  function mined(p: PreparedAaveTransaction, status = '0x1') {
    const approval = p.action === 'approve' || p.action === 'revoke'
    const n = BigInt(p.amountAtoms)
    const topics = approval
      ? encodeEventTopics({
          abi: AAVE_TOKEN_ABI,
          eventName: 'Approval',
          args: { owner: p.sender, spender: config.pool.address },
        })
      : p.action === 'supply'
        ? encodeEventTopics({
            abi: AAVE_POOL_ABI,
            eventName: 'Supply',
            args: { reserve: config.token.address, onBehalfOf: p.sender, referralCode: 0 },
          })
        : encodeEventTopics({
            abi: AAVE_POOL_ABI,
            eventName: 'Withdraw',
            args: { reserve: config.token.address, user: p.sender, to: p.sender },
          })
    const data =
      p.action === 'supply'
        ? encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [p.sender, n])
        : encodeAbiParameters([{ type: 'uint256' }], [n])
    state.tx = {
      hash: p.hash,
      from: p.sender,
      to: p.to,
      input: p.data,
      value: '0x0',
      nonce: q(p.nonce),
      chainId: q(p.chainId),
      blockHash: state.blockHash,
      blockNumber: '0x64',
    }
    state.receipt = {
      transactionHash: p.hash,
      from: p.sender,
      to: p.to,
      blockHash: state.blockHash,
      blockNumber: '0x64',
      status,
      gasUsed: '0x186a0',
      effectiveGasPrice: q(state.gasPrice),
      logs: [
        {
          address: p.to,
          topics,
          data,
          removed: false,
          transactionHash: p.hash,
          blockHash: state.blockHash,
          blockNumber: '0x64',
        },
      ],
    }
  }
  return { config, state, rpc, mined }
}
