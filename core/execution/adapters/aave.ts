import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { decimal, SCALE, units } from '../../trading/decimal'
import {
  ExecutionRejected,
  type ExecutionAdapter,
  type ExecutionIntent,
  type PreparedExecution,
  type ExecutionReceipt,
  type Json,
} from '../types'

// Pool ABI: https://aave.com/docs/aave-v3/smart-contracts/pool
// Event ABI: aave/aave-v3-origin, src/contracts/interfaces/IPool.sol.
export const AAVE_POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getConfiguration(address asset) view returns (uint256)',
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
])
export const AAVE_TOKEN_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
])
const A_TOKEN_ABI = parseAbi([
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function POOL() view returns (address)',
])
const implementationSlot =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
// Circle FiatTokenProxy uses ZeppelinOS's legacy implementation slot, not EIP-1967.
const legacyImplementationSlot =
  '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' as const
const zeroAddress = '0x0000000000000000000000000000000000000000'
const maxUint256 = 2n ** 256n - 1n

export type AaveAction = 'approve' | 'revoke' | 'supply' | 'withdraw'
export type AaveRpc = (method: string, params: unknown[]) => Promise<unknown>
export interface AaveContractPin {
  address: Address
  codeHash: Hex
  // Proxy bytecode alone does not identify its implementation. Pin both when present.
  implementation?: { address: Address; codeHash: Hex }
}
export interface AaveSettings {
  rpcUrl: string
  network: 'local' | 'testnet' | 'live'
  chainId: number
  privateKey: Hex
  sender: Address
  pool: AaveContractPin
  token: AaveContractPin
  aToken: AaveContractPin
  decimals: number
  confirmations: number
  maxAmountAtoms: bigint
  maxGas: bigint
  maxFeePerGasWei: bigint
  maxGasCostWei: bigint
}
export interface AaveIntent {
  action: AaveAction
  amountAtoms: string
}
/** Internal durable data. Never expose rawTransaction to models, UI, or application logs. */
export interface PreparedAaveTransaction extends AaveIntent {
  version: 1
  chainId: number
  sender: Address
  nonce: number
  hash: Hex
  rawTransaction: Hex
  to: Address
  data: Hex
  gas: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
}
export type AaveLookup =
  | { status: 'not_found' }
  | { status: 'pending' }
  | { status: 'nonce_conflict' }
  | {
      status: 'confirmed' | 'reverted'
      hash: Hex
      blockHash: Hex
      blockNumber: string
      confirmations: number
      gasCostWei: string
      amountAtoms: string
    }

function fail(code: string): never {
  throw new Error(`EXECUTION_AAVE_${code}`)
}
function sameAddress(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
}
function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) fail('RPC_INVALID')
  return getAddress(value)
}
function hash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) fail('RPC_INVALID')
  return value.toLowerCase() as Hex
}
function bytes(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) fail('RPC_INVALID')
  return value as Hex
}
function uint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) fail('RPC_INVALID')
  return BigInt(value)
}
function amount(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,77})$/.test(value)) fail('AMOUNT_INVALID')
  const n = BigInt(value)
  if (n >= maxUint256) fail('AMOUNT_INVALID')
  return n
}
function obj(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('RPC_INVALID')
  return value as Record<string, unknown>
}
function quantity(value: bigint | number): Hex {
  return `0x${BigInt(value).toString(16)}`
}
function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('RPC_INVALID')
  return Number(value)
}

/** The URL comes only from owner configuration, never a model response or an HTTP request. */
export function createAaveRpc(settings: Pick<AaveSettings, 'rpcUrl' | 'network'>): AaveRpc {
  let url: URL
  try {
    url = new URL(settings.rpcUrl)
  } catch {
    fail('RPC_CONFIG_INVALID')
  }
  const local = ['localhost', '127.0.0.1', '[::1]', 'anvil'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.hash ||
    (settings.network === 'local' ? !local || url.protocol !== 'http:' : url.protocol !== 'https:')
  )
    fail('RPC_CONFIG_INVALID')
  let id = 0
  return async (method, params) => {
    const requestId = ++id
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      })
      if (!response.ok) fail('RPC_UNAVAILABLE')
      const result = obj(await response.json())
      if (result.id !== requestId || result.jsonrpc !== '2.0') fail('RPC_INVALID')
      if (result.error) fail('RPC_REJECTED')
      if (!('result' in result)) fail('RPC_INVALID')
      return result.result
    } catch (error) {
      // RPC exceptions may include authenticated endpoint URLs or signed transaction data.
      if (error instanceof Error && /^EXECUTION_AAVE_/.test(error.message)) throw error
      fail('RPC_UNAVAILABLE')
    }
  }
}

/**
 * Signing and sending are intentionally separate. The worker must persist the prepared
 * bytes/hash under a unique (chainId, sender, nonce) reservation BEFORE calling broadcast.
 * A retry reuses these same bytes. There is no automatic replacement or nonce advancement.
 */
export function createAaveAdapter(settings: AaveSettings, rpc = createAaveRpc(settings)) {
  const c = settings
  if (
    !Number.isSafeInteger(c.chainId) ||
    c.chainId <= 0 ||
    (c.network === 'live' && c.chainId !== 1) ||
    (c.network === 'testnet' && c.chainId !== 11155111) ||
    !Number.isInteger(c.decimals) ||
    c.decimals < 0 ||
    c.decimals > 18 ||
    !Number.isInteger(c.confirmations) ||
    c.confirmations < 1 ||
    c.confirmations > 256 ||
    c.maxAmountAtoms <= 0n ||
    c.maxAmountAtoms >= maxUint256 ||
    c.maxGas < 21_000n ||
    c.maxFeePerGasWei <= 0n ||
    c.maxGasCostWei <= 0n
  )
    fail('CONFIG_INVALID')
  for (const pin of [c.pool, c.token, c.aToken]) {
    if (address(pin.address).toLowerCase() === zeroAddress) fail('CONFIG_INVALID')
    hash(pin.codeHash)
    if (pin.implementation) {
      if (address(pin.implementation.address).toLowerCase() === zeroAddress) fail('CONFIG_INVALID')
      hash(pin.implementation.codeHash)
    }
  }
  if (
    new Set([c.pool.address, c.token.address, c.aToken.address].map((v) => v.toLowerCase()))
      .size !== 3
  )
    fail('CONFIG_INVALID')
  let account: ReturnType<typeof privateKeyToAccount>
  try {
    account = privateKeyToAccount(c.privateKey)
  } catch {
    fail('KEY_INVALID')
  }
  if (!sameAddress(account.address, c.sender)) fail('SENDER_MISMATCH')

  async function read(abi: Abi, target: Address, name: string, args: unknown[] = []) {
    const data = encodeFunctionData({ abi, functionName: name, args })
    const result = bytes(await rpc('eth_call', [{ to: target, data }, 'latest']))
    try {
      return decodeFunctionResult({ abi, functionName: name, data: result })
    } catch {
      fail('RPC_INVALID')
    }
  }
  async function checkCode(pin: AaveContractPin) {
    const code = bytes(await rpc('eth_getCode', [pin.address, 'latest']))
    if (code === '0x' || keccak256(code).toLowerCase() !== pin.codeHash.toLowerCase())
      fail('CODE_MISMATCH')
    const implementations = await Promise.all(
      [implementationSlot, legacyImplementationSlot].map(async (slot) => {
        const stored = hash(await rpc('eth_getStorageAt', [pin.address, slot, 'latest']))
        return address(`0x${stored.slice(-40)}`)
      }),
    )
    const active = [...new Set(implementations.filter((item) => !sameAddress(item, zeroAddress)))]
    if (!pin.implementation) {
      if (active.length) fail('IMPLEMENTATION_PIN_REQUIRED')
      return
    }
    if (active.length !== 1) fail('IMPLEMENTATION_MISMATCH')
    const actualImplementation = active[0]!
    if (!sameAddress(actualImplementation, pin.implementation.address))
      fail('IMPLEMENTATION_MISMATCH')
    const implementationCode = bytes(await rpc('eth_getCode', [actualImplementation, 'latest']))
    if (
      implementationCode === '0x' ||
      keccak256(implementationCode).toLowerCase() !== pin.implementation.codeHash.toLowerCase()
    )
      fail('IMPLEMENTATION_MISMATCH')
  }
  async function verifyDeployment() {
    if (uint(await rpc('eth_chainId', [])) !== BigInt(c.chainId)) fail('CHAIN_MISMATCH')
    if (c.network === 'local' && !/^anvil\b/i.test(String(await rpc('web3_clientVersion', []))))
      fail('LOCAL_NODE_REQUIRED')
    await Promise.all([checkCode(c.pool), checkCode(c.token), checkCode(c.aToken)])
    const [tokenDecimals, aTokenDecimals, underlying, pool] = await Promise.all([
      read(AAVE_TOKEN_ABI, c.token.address, 'decimals'),
      read(AAVE_TOKEN_ABI, c.aToken.address, 'decimals'),
      read(A_TOKEN_ABI, c.aToken.address, 'UNDERLYING_ASSET_ADDRESS'),
      read(A_TOKEN_ABI, c.aToken.address, 'POOL'),
    ])
    if (tokenDecimals !== c.decimals || aTokenDecimals !== c.decimals) fail('DECIMALS_MISMATCH')
    if (!sameAddress(underlying, c.token.address) || !sameAddress(pool, c.pool.address))
      fail('RESERVE_MISMATCH')
  }
  function callFor(intent: AaveIntent): { to: Address; data: Hex; amount: bigint } {
    const n = amount(intent.amountAtoms)
    if (intent.action === 'revoke' ? n !== 0n : n <= 0n || n > c.maxAmountAtoms)
      fail('AMOUNT_LIMIT')
    switch (intent.action) {
      case 'approve':
      case 'revoke':
        return {
          to: c.token.address,
          data: encodeFunctionData({
            abi: AAVE_TOKEN_ABI,
            functionName: 'approve',
            args: [c.pool.address, n],
          }),
          amount: n,
        }
      case 'supply':
        return {
          to: c.pool.address,
          data: encodeFunctionData({
            abi: AAVE_POOL_ABI,
            functionName: 'supply',
            args: [c.token.address, n, account.address, 0],
          }),
          amount: n,
        }
      case 'withdraw':
        return {
          to: c.pool.address,
          data: encodeFunctionData({
            abi: AAVE_POOL_ABI,
            functionName: 'withdraw',
            args: [c.token.address, n, account.address],
          }),
          amount: n,
        }
      default:
        fail('ACTION_INVALID')
    }
  }
  async function balances() {
    const [wallet, supplied, allowance, native, debt] = await Promise.all([
      read(AAVE_TOKEN_ABI, c.token.address, 'balanceOf', [account.address]),
      read(AAVE_TOKEN_ABI, c.aToken.address, 'balanceOf', [account.address]),
      read(AAVE_TOKEN_ABI, c.token.address, 'allowance', [account.address, c.pool.address]),
      rpc('eth_getBalance', [account.address, 'latest']).then(uint),
      read(AAVE_POOL_ABI, c.pool.address, 'getUserAccountData', [account.address]),
    ])
    if (typeof wallet !== 'bigint' || typeof supplied !== 'bigint' || typeof allowance !== 'bigint')
      fail('RPC_INVALID')
    if (!Array.isArray(debt) || typeof debt[1] !== 'bigint') fail('RPC_INVALID')
    return { wallet, supplied, allowance, native, debt: debt[1] as bigint }
  }
  async function reserveRateBps() {
    const reserve = await read(AAVE_POOL_ABI, c.pool.address, 'getReserveData', [c.token.address])
    if (
      !Array.isArray(reserve) ||
      typeof reserve[2] !== 'bigint' ||
      !sameAddress(reserve[8], c.aToken.address)
    )
      fail('RESERVE_MISMATCH')
    // Aave currentLiquidityRate is annualized ray interest, not accrued account income.
    return safeNumber((reserve[2] * 10_000n) / 10n ** 27n)
  }
  async function checkIntent(intent: AaveIntent) {
    const call = callFor(intent)
    await verifyDeployment()
    const [balance, reserve] = await Promise.all([
      balances(),
      read(AAVE_POOL_ABI, c.pool.address, 'getConfiguration', [c.token.address]),
    ])
    if (balance.debt !== 0n) fail('DEBT_PRESENT')
    if (typeof reserve !== 'bigint') fail('RPC_INVALID')
    if (Number((reserve >> 48n) & 255n) !== c.decimals) fail('DECIMALS_MISMATCH')
    if (intent.action === 'supply' || intent.action === 'approve') {
      const active = (reserve & (1n << 56n)) !== 0n
      const frozen = (reserve & (1n << 57n)) !== 0n
      const paused = (reserve & (1n << 60n)) !== 0n
      if (!active || frozen || paused) fail('RESERVE_UNAVAILABLE')
      if (balance.wallet < call.amount) fail('INSUFFICIENT_TOKEN_BALANCE')
    }
    if (intent.action === 'approve' && balance.allowance !== 0n) fail('REVOKE_REQUIRED')
    if (intent.action === 'supply' && balance.allowance !== call.amount)
      fail('EXACT_ALLOWANCE_REQUIRED')
    if (intent.action === 'withdraw' && balance.supplied < call.amount) fail('INSUFFICIENT_SUPPLY')
    if (intent.action === 'revoke' && balance.allowance === 0n) fail('ALLOWANCE_ALREADY_ZERO')
    return { ...call, balance }
  }
  async function prepare(
    intent: AaveIntent,
    reservedNonce?: number,
  ): Promise<PreparedAaveTransaction> {
    const call = await checkIntent(intent)
    const [pending, latest, gasEstimate, block, gasPrice] = await Promise.all([
      rpc('eth_getTransactionCount', [account.address, 'pending']).then(uint),
      rpc('eth_getTransactionCount', [account.address, 'latest']).then(uint),
      rpc('eth_estimateGas', [
        { from: account.address, to: call.to, data: call.data, value: '0x0' },
      ]).then(uint),
      rpc('eth_getBlockByNumber', ['latest', false]).then(obj),
      rpc('eth_gasPrice', []).then(uint),
    ])
    if (pending !== latest) fail('PENDING_NONCE')
    const nonce = safeNumber(pending)
    if (reservedNonce !== undefined && reservedNonce !== nonce) fail('NONCE_MISMATCH')
    const baseFee = uint(block.baseFeePerGas)
    const priority = gasPrice > baseFee ? gasPrice - baseFee : 1n
    const fee = baseFee * 2n + priority
    const gas = (gasEstimate * 120n + 99n) / 100n
    if (gas < 21_000n || gas > c.maxGas || fee > c.maxFeePerGasWei || gas * fee > c.maxGasCostWei)
      fail('GAS_LIMIT')
    if (call.balance.native < gas * fee) fail('INSUFFICIENT_GAS_BALANCE')
    // Explicit simulation also checks tokens that return false without reverting on approve.
    const simulation = bytes(
      await rpc('eth_call', [
        { from: account.address, to: call.to, data: call.data, value: '0x0' },
        'latest',
      ]),
    )
    if (intent.action === 'approve' || intent.action === 'revoke') {
      if (
        decodeFunctionResult({ abi: AAVE_TOKEN_ABI, functionName: 'approve', data: simulation }) !==
        true
      )
        fail('APPROVAL_REJECTED')
    } else if (intent.action === 'withdraw') {
      if (
        decodeFunctionResult({ abi: AAVE_POOL_ABI, functionName: 'withdraw', data: simulation }) !==
        call.amount
      )
        fail('WITHDRAW_AMOUNT_MISMATCH')
    }
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId: c.chainId,
      nonce,
      to: call.to,
      data: call.data,
      value: 0n,
      gas,
      maxFeePerGas: fee,
      maxPriorityFeePerGas: priority,
    })
    return {
      version: 1,
      ...intent,
      chainId: c.chainId,
      sender: account.address,
      nonce,
      hash: keccak256(raw),
      rawTransaction: raw,
      to: call.to,
      data: call.data,
      gas: gas.toString(),
      maxFeePerGas: fee.toString(),
      maxPriorityFeePerGas: priority.toString(),
    }
  }
  async function validatePrepared(p: PreparedAaveTransaction) {
    const expected = callFor(p)
    if (
      p.version !== 1 ||
      p.chainId !== c.chainId ||
      !sameAddress(p.sender, account.address) ||
      !sameAddress(p.to, expected.to) ||
      p.data !== expected.data ||
      keccak256(bytes(p.rawTransaction)) !== p.hash
    )
      fail('PREPARED_MISMATCH')
    const tx = parseTransaction(p.rawTransaction)
    if (
      tx.type !== 'eip1559' ||
      tx.chainId !== c.chainId ||
      tx.nonce !== p.nonce ||
      !sameAddress(tx.to, expected.to) ||
      tx.data !== expected.data ||
      (tx.value ?? 0n) !== 0n ||
      tx.gas !== amount(p.gas) ||
      tx.maxFeePerGas !== amount(p.maxFeePerGas) ||
      tx.maxPriorityFeePerGas !== amount(p.maxPriorityFeePerGas) ||
      !tx.gas ||
      tx.gas > c.maxGas ||
      !tx.maxFeePerGas ||
      tx.maxFeePerGas > c.maxFeePerGasWei ||
      tx.gas * tx.maxFeePerGas > c.maxGasCostWei ||
      !sameAddress(
        await recoverTransactionAddress({
          serializedTransaction: p.rawTransaction as `0x02${string}`,
        }),
        account.address,
      )
    )
      fail('PREPARED_MISMATCH')
  }
  function verifyEvent(
    p: PreparedAaveTransaction,
    logs: unknown,
    blockHash: Hex,
    blockNumber: bigint,
  ) {
    if (!Array.isArray(logs)) fail('RECEIPT_INVALID')
    let matches = 0
    for (const item of logs) {
      const log = obj(item)
      if (!sameAddress(log.address, p.to)) continue
      try {
        if (
          log.removed !== false ||
          hash(log.transactionHash) !== p.hash ||
          hash(log.blockHash) !== blockHash ||
          uint(log.blockNumber) !== blockNumber
        )
          fail('RECEIPT_INVALID')
        if (!Array.isArray(log.topics) || log.topics.length < 1) fail('RECEIPT_INVALID')
        const event = decodeEventLog({
          abi: p.action === 'approve' || p.action === 'revoke' ? AAVE_TOKEN_ABI : AAVE_POOL_ABI,
          data: bytes(log.data),
          topics: log.topics.map(hash) as [Hex, ...Hex[]],
          strict: true,
        })
        const args = event.args as Record<string, unknown>
        const n = BigInt(p.amountAtoms)
        if (
          ((p.action === 'approve' || p.action === 'revoke') &&
            event.eventName === 'Approval' &&
            sameAddress(args.owner, p.sender) &&
            sameAddress(args.spender, c.pool.address) &&
            args.value === n) ||
          (p.action === 'supply' &&
            event.eventName === 'Supply' &&
            sameAddress(args.reserve, c.token.address) &&
            sameAddress(args.user, p.sender) &&
            sameAddress(args.onBehalfOf, p.sender) &&
            args.amount === n &&
            args.referralCode === 0) ||
          (p.action === 'withdraw' &&
            event.eventName === 'Withdraw' &&
            sameAddress(args.reserve, c.token.address) &&
            sameAddress(args.user, p.sender) &&
            sameAddress(args.to, p.sender) &&
            args.amount === n)
        )
          matches++
      } catch {
        // Other events from the pinned contract are not evidence for this operation.
      }
    }
    if (matches !== 1) fail('RECEIPT_EVENT_MISMATCH')
  }
  async function lookup(p: PreparedAaveTransaction): Promise<AaveLookup> {
    await validatePrepared(p)
    if (uint(await rpc('eth_chainId', [])) !== BigInt(c.chainId)) fail('CHAIN_MISMATCH')
    const receiptResult = await rpc('eth_getTransactionReceipt', [p.hash])
    const txResult = await rpc('eth_getTransactionByHash', [p.hash])
    if (txResult === null && receiptResult === null) {
      const nonce = uint(await rpc('eth_getTransactionCount', [p.sender, 'latest']))
      return { status: nonce > BigInt(p.nonce) ? 'nonce_conflict' : 'not_found' }
    }
    if (txResult === null) fail('RECEIPT_INVALID')
    const tx = obj(txResult)
    if (
      hash(tx.hash) !== p.hash ||
      !sameAddress(tx.from, p.sender) ||
      !sameAddress(tx.to, p.to) ||
      tx.input !== p.data ||
      uint(tx.value) !== 0n ||
      uint(tx.nonce) !== BigInt(p.nonce) ||
      uint(tx.chainId) !== BigInt(c.chainId)
    )
      fail('TRANSACTION_MISMATCH')
    if (receiptResult === null) return { status: 'pending' }
    const receipt = obj(receiptResult)
    const blockNumber = uint(receipt.blockNumber)
    const blockHash = hash(receipt.blockHash)
    if (
      hash(receipt.transactionHash) !== p.hash ||
      !sameAddress(receipt.from, p.sender) ||
      !sameAddress(receipt.to, p.to) ||
      hash(tx.blockHash) !== blockHash ||
      uint(tx.blockNumber) !== blockNumber ||
      (receipt.status !== '0x1' && receipt.status !== '0x0')
    )
      fail('RECEIPT_INVALID')
    const block = obj(await rpc('eth_getBlockByNumber', [quantity(blockNumber), false]))
    if (hash(block.hash) !== blockHash || uint(block.number) !== blockNumber) fail('REORG')
    const head = uint(await rpc('eth_blockNumber', []))
    if (head < blockNumber) fail('REORG')
    const confirmations = safeNumber(head - blockNumber + 1n)
    if (confirmations < c.confirmations) return { status: 'pending' }
    const gasUsed = uint(receipt.gasUsed)
    const gasPrice = uint(receipt.effectiveGasPrice)
    if (gasUsed > BigInt(p.gas) || gasPrice > BigInt(p.maxFeePerGas)) fail('RECEIPT_INVALID')
    if (receipt.status === '0x1') verifyEvent(p, receipt.logs, blockHash, blockNumber)
    return {
      status: receipt.status === '0x1' ? 'confirmed' : 'reverted',
      hash: p.hash,
      blockHash,
      blockNumber: blockNumber.toString(),
      confirmations,
      gasCostWei: (gasUsed * gasPrice).toString(),
      amountAtoms: receipt.status === '0x1' ? p.amountAtoms : '0',
    }
  }
  async function broadcast(p: PreparedAaveTransaction): Promise<Hex> {
    await validatePrepared(p)
    const existing = await lookup(p)
    if (existing.status === 'nonce_conflict') fail('NONCE_CONFLICT')
    if (existing.status !== 'not_found') return p.hash
    // Revalidate deployment and available funds after the durable record was written.
    await checkIntent(p)
    const pending = uint(await rpc('eth_getTransactionCount', [p.sender, 'pending']))
    if (pending !== BigInt(p.nonce)) fail('NONCE_CONFLICT')
    let sent: unknown
    try {
      sent = await rpc('eth_sendRawTransaction', [p.rawTransaction])
    } catch {
      // The request may have reached the chain. The caller must reconcile this SAME hash.
      fail('BROADCAST_UNCERTAIN')
    }
    if (hash(sent) !== p.hash) fail('BROADCAST_UNCERTAIN')
    return p.hash
  }
  return {
    prepare,
    broadcast,
    lookup,
    balances,
    reserveRateBps,
    verifyDeployment,
    sender: account.address,
  }
}

/** Compatible with the common persisted execution queue; no signing data enters its view DTO. */
export function createAaveExecutionAdapter(
  settings: AaveSettings,
  market: { symbol: string; nativeAsset: string },
  rpc?: AaveRpc,
): ExecutionAdapter {
  const adapter = createAaveAdapter(settings, rpc)
  const factor = SCALE / 10n ** BigInt(settings.decimals)
  if (!/^[A-Z0-9]{2,12}$/.test(market.symbol) || market.nativeAsset !== 'ETH')
    fail('CONFIG_INVALID')
  function convert(intent: ExecutionIntent): AaveIntent {
    if (
      intent.venue !== 'aave' ||
      intent.symbol !== market.symbol ||
      !['approve', 'revoke', 'supply', 'withdraw'].includes(intent.action)
    )
      fail('INTENT_INVALID')
    const qty = units(intent.quantity)
    if (qty < 0n || qty % factor !== 0n) fail('AMOUNT_INVALID')
    if (units(intent.limitPrice) !== SCALE) fail('INTENT_INVALID')
    if (
      (intent.action === 'approve' || intent.action === 'supply') &&
      qty > units(intent.quoteBudget)
    )
      fail('BUDGET_EXCEEDED')
    if (intent.action === 'withdraw' && qty > units(intent.positionQuantity))
      fail('POSITION_EXCEEDED')
    return { action: intent.action as AaveAction, amountAtoms: (qty / factor).toString() }
  }
  function stored(prepared: PreparedExecution): PreparedAaveTransaction {
    const intent = convert(prepared.intent)
    const payload = prepared.payload as unknown as PreparedAaveTransaction
    if (
      intent.action !== payload.action ||
      intent.amountAtoms !== payload.amountAtoms ||
      prepared.externalId !== payload.hash
    )
      fail('PREPARED_MISMATCH')
    return payload
  }
  function empty(status: ExecutionReceipt['status'], externalId: string): ExecutionReceipt {
    return { status, externalId, filledQuantity: '0', grossQuote: '0', quoteFee: '0', baseFee: '0' }
  }
  return {
    async prepare(intent) {
      if (!Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= Date.now())
        throw new ExecutionRejected('EXECUTION_AAVE_INTENT_EXPIRED')
      try {
        const result = await adapter.prepare(convert(intent))
        return {
          intent,
          payload: result as unknown as { [key: string]: Json },
          externalId: result.hash,
        }
      } catch (error) {
        // prepare never broadcasts, so all preparation failures are safe rejections.
        throw new ExecutionRejected(
          error instanceof Error && /^EXECUTION_AAVE_/.test(error.message)
            ? error.message
            : 'EXECUTION_AAVE_PREPARE_FAILED',
        )
      }
    },
    async broadcast(prepared) {
      await adapter.broadcast(stored(prepared))
    },
    async lookup(prepared) {
      const result = await adapter.lookup(stored(prepared))
      if (result.status === 'not_found') return null
      if (result.status === 'pending') return empty('pending', prepared.externalId!)
      if (result.status === 'nonce_conflict') return empty('unknown', prepared.externalId!)
      const approval = prepared.intent.action === 'approve' || prepared.intent.action === 'revoke'
      const qty = approval ? '0' : decimal(BigInt(result.amountAtoms) * factor)
      return {
        status: result.status === 'confirmed' ? 'filled' : 'rejected',
        externalId: result.hash,
        filledQuantity: qty,
        grossQuote: qty,
        quoteFee: '0',
        baseFee: '0',
        networkFee: { asset: market.nativeAsset, amount: decimal(BigInt(result.gasCostWei)) },
      }
    },
  }
}
