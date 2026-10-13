import { describe, expect, it } from 'vitest'
import { decodeFunctionData, parseTransaction } from 'viem'
import {
  AAVE_POOL_ABI,
  AAVE_TOKEN_ABI,
  createAaveAdapter,
  createAaveExecutionAdapter,
  createAaveRpc,
  type AaveIntent,
} from '../../core/execution/adapters/aave'
import { aaveRpcFixture } from '../fixtures/aave-rpc'
import type { ExecutionIntent } from '../../core/execution/types'

const approve: AaveIntent = { action: 'approve', amountAtoms: '5000000' }
function setup() {
  const f = aaveRpcFixture()
  return { ...f, adapter: createAaveAdapter(f.config, f.rpc) }
}
describe('bounded Aave signer and durable transaction reconciliation', () => {
  it('prepares an exact approval without sending and reuses the persisted bytes on retry', async () => {
    const f = setup()
    const p = await f.adapter.prepare(approve, 4)
    expect(f.state.sent).toEqual([])
    expect(decodeFunctionData({ abi: AAVE_TOKEN_ABI, data: p.data })).toEqual({
      functionName: 'approve',
      args: [f.config.pool.address, 5_000_000n],
    })
    expect(parseTransaction(p.rawTransaction)).toMatchObject({
      type: 'eip1559',
      chainId: 11155111,
      nonce: 4,
      to: f.config.token.address,
      gas: 120_000n,
    })
    expect(parseTransaction(p.rawTransaction).value ?? 0n).toBe(0n)
    const restored = JSON.parse(JSON.stringify(p))
    await f.adapter.broadcast(restored)
    await f.adapter.broadcast(restored)
    expect(f.state.sent).toEqual([p.rawTransaction, p.rawTransaction])
  })

  it('signs only self-recipient supply and withdrawal, with no unlimited amount', async () => {
    const f = setup()
    f.state.allowance = 5_000_000n
    const supply = await f.adapter.prepare({ ...approve, action: 'supply' })
    expect(decodeFunctionData({ abi: AAVE_POOL_ABI, data: supply.data })).toEqual({
      functionName: 'supply',
      args: [f.config.token.address, 5_000_000n, f.config.sender, 0],
    })
    const withdraw = await f.adapter.prepare({ ...approve, action: 'withdraw' })
    expect(decodeFunctionData({ abi: AAVE_POOL_ABI, data: withdraw.data })).toEqual({
      functionName: 'withdraw',
      args: [f.config.token.address, 5_000_000n, f.config.sender],
    })
    await expect(
      f.adapter.prepare({ ...approve, amountAtoms: (2n ** 256n - 1n).toString() }),
    ).rejects.toThrow('AMOUNT_INVALID')
    await expect(f.adapter.prepare({ ...approve, amountAtoms: '10000001' })).rejects.toThrow(
      'AMOUNT_LIMIT',
    )
  })

  it('requires revocation before replacing allowance and rejects both short and excessive allowances', async () => {
    const f = setup()
    f.state.allowance = 6_000_000n
    await expect(f.adapter.prepare(approve)).rejects.toThrow('REVOKE_REQUIRED')
    await expect(f.adapter.prepare({ ...approve, action: 'supply' })).rejects.toThrow(
      'EXACT_ALLOWANCE_REQUIRED',
    )
    const revoke = await f.adapter.prepare({ action: 'revoke', amountAtoms: '0' })
    expect(decodeFunctionData({ abi: AAVE_TOKEN_ABI, data: revoke.data }).args).toEqual([
      f.config.pool.address,
      0n,
    ])
    f.state.allowance = 1n
    await expect(f.adapter.prepare({ ...approve, action: 'supply' })).rejects.toThrow(
      'EXACT_ALLOWANCE_REQUIRED',
    )
  })

  it.each([
    ['chain', 1n, 'CHAIN_MISMATCH'],
    ['version', 'Geth', 'LOCAL_NODE_REQUIRED'],
    ['code', '0x6001', 'CODE_MISMATCH'],
    ['decimals', 18, 'DECIMALS_MISMATCH'],
    ['underlying', '0x2000000000000000000000000000000000000001', 'RESERVE_MISMATCH'],
    ['debt', 1n, 'DEBT_PRESENT'],
    ['wallet', 1n, 'INSUFFICIENT_TOKEN_BALANCE'],
    ['native', 1n, 'INSUFFICIENT_GAS_BALANCE'],
    ['gasEstimate', 500_000n, 'GAS_LIMIT'],
    ['gasPrice', 50_000_000_000n, 'GAS_LIMIT'],
    ['pendingNonce', 5n, 'PENDING_NONCE'],
    ['approvalOk', false, 'APPROVAL_REJECTED'],
  ])('refuses preparation when %s is inconsistent', async (field, value, error) => {
    const f = setup()
    Object.assign(f.state, { [field]: value })
    await expect(f.adapter.prepare(approve)).rejects.toThrow(error)
    expect(f.state.sent).toEqual([])
  })

  it('checks proxy implementation pins, frozen reserves and requested nonce', async () => {
    const f = setup()
    f.state.implementation = `0x${'00'.repeat(12)}${'11'.repeat(20)}`
    await expect(f.adapter.prepare(approve)).rejects.toThrow('IMPLEMENTATION_PIN_REQUIRED')
    f.state.implementation = `0x${'00'.repeat(32)}`
    f.state.reserve |= 1n << 57n
    await expect(f.adapter.prepare(approve)).rejects.toThrow('RESERVE_UNAVAILABLE')
    f.state.reserve &= ~(1n << 57n)
    await expect(f.adapter.prepare(approve, 5)).rejects.toThrow('NONCE_MISMATCH')
  })

  it('rejects changes to durable metadata and rechecks funds before sending', async () => {
    const f = setup()
    const p = await f.adapter.prepare(approve)
    await expect(f.adapter.broadcast({ ...p, amountAtoms: '6000000' })).rejects.toThrow(
      'PREPARED_MISMATCH',
    )
    await expect(f.adapter.broadcast({ ...p, nonce: 8 })).rejects.toThrow('PREPARED_MISMATCH')
    f.state.wallet = 0n
    await expect(f.adapter.broadcast(p)).rejects.toThrow('INSUFFICIENT_TOKEN_BALANCE')
    expect(f.state.sent).toEqual([])
  })

  it('reconciles a lost broadcast response without creating or resending a new operation', async () => {
    const f = setup()
    const p = await f.adapter.prepare(approve)
    f.state.loseBroadcastResponse = true
    await expect(f.adapter.broadcast(p)).rejects.toThrow('BROADCAST_UNCERTAIN')
    f.mined(p)
    expect(await f.adapter.lookup(p)).toMatchObject({
      status: 'confirmed',
      amountAtoms: '5000000',
      confirmations: 3,
      gasCostWei: '150000000000000',
      hash: p.hash,
    })
    await f.adapter.broadcast(p)
    expect(f.state.sent).toHaveLength(1)
  })

  it('does not infer success from a consumed nonce or an unknown transaction', async () => {
    const f = setup()
    const p = await f.adapter.prepare(approve)
    expect(await f.adapter.lookup(p)).toEqual({ status: 'not_found' })
    f.state.latestNonce = 5n
    expect(await f.adapter.lookup(p)).toEqual({ status: 'nonce_conflict' })
    await expect(f.adapter.broadcast(p)).rejects.toThrow('NONCE_CONFLICT')
    expect(f.state.sent).toEqual([])
  })

  it('waits for confirmations and rejects a non-canonical receipt', async () => {
    const f = setup()
    const p = await f.adapter.prepare(approve)
    f.mined(p)
    f.state.head = 101n
    expect(await f.adapter.lookup(p)).toEqual({ status: 'pending' })
    f.state.head = 102n
    f.state.blockHash = `0x${'dd'.repeat(32)}`
    await expect(f.adapter.lookup(p)).rejects.toThrow('REORG')
  })

  it.each(['supply', 'withdraw'] as const)(
    'validates the exact %s event before accounting',
    async (action) => {
      const f = setup()
      f.state.allowance = 5_000_000n
      const p = await f.adapter.prepare({ ...approve, action })
      f.mined(p)
      expect(await f.adapter.lookup(p)).toMatchObject({
        status: 'confirmed',
        amountAtoms: '5000000',
      })
      const logs = f.state.receipt!.logs as { address: string }[]
      logs[0]!.address = f.config.token.address
      await expect(f.adapter.lookup(p)).rejects.toThrow('RECEIPT_EVENT_MISMATCH')
    },
  )

  it('accounts a reverted transaction only as spent gas', async () => {
    const f = setup()
    const p = await f.adapter.prepare(approve)
    f.mined(p, '0x0')
    f.state.receipt!.logs = []
    expect(await f.adapter.lookup(p)).toMatchObject({
      status: 'reverted',
      amountAtoms: '0',
      gasCostWei: '150000000000000',
    })
  })

  it('rejects removed logs and logs attached to a different transaction', async () => {
    const f = setup()
    const p = await f.adapter.prepare(approve)
    f.mined(p)
    const logs = f.state.receipt!.logs as Record<string, unknown>[]
    logs[0]!.removed = true
    await expect(f.adapter.lookup(p)).rejects.toThrow('RECEIPT_EVENT_MISMATCH')
    logs[0]!.removed = false
    logs[0]!.transactionHash = `0x${'11'.repeat(32)}`
    await expect(f.adapter.lookup(p)).rejects.toThrow('RECEIPT_EVENT_MISMATCH')
  })

  it('requires loopback Anvil URLs in local mode and HTTPS for external endpoints', () => {
    expect(() => createAaveRpc({ network: 'local', rpcUrl: 'https://example.com' })).toThrow(
      'RPC_CONFIG_INVALID',
    )
    expect(() => createAaveRpc({ network: 'live', rpcUrl: 'http://example.com' })).toThrow(
      'RPC_CONFIG_INVALID',
    )
    expect(() =>
      createAaveRpc({ network: 'local', rpcUrl: 'http://secret@localhost:8545' }),
    ).toThrow('RPC_CONFIG_INVALID')
  })

  it('converts common execution amounts exactly and keeps ETH gas separate from token principal', async () => {
    const f = setup()
    const adapter = createAaveExecutionAdapter(
      f.config,
      { symbol: 'USDC', nativeAsset: 'ETH' },
      f.rpc,
    )
    const intent: ExecutionIntent = {
      clientId: 'aave-test-1',
      venue: 'aave',
      action: 'supply',
      symbol: 'USDC',
      quantity: '5',
      limitPrice: '1',
      quoteBudget: '5',
      positionQuantity: '0',
      expiresAt: Date.now() + 60_000,
    }
    f.state.allowance = 5_000_000n
    const p = await adapter.prepare(intent)
    f.mined(p.payload as unknown as Parameters<typeof f.mined>[0])
    expect(await adapter.lookup(p)).toEqual({
      status: 'filled',
      externalId: p.externalId,
      filledQuantity: '5',
      grossQuote: '5',
      quoteFee: '0',
      baseFee: '0',
      networkFee: { asset: 'ETH', amount: '0.00015' },
    })
    await expect(adapter.prepare({ ...intent, quantity: '5.0000001' })).rejects.toThrow(
      'AMOUNT_INVALID',
    )
    await expect(adapter.prepare({ ...intent, quoteBudget: '4' })).rejects.toThrow(
      'BUDGET_EXCEEDED',
    )
    await expect(
      adapter.prepare({ ...intent, action: 'withdraw', positionQuantity: '4' }),
    ).rejects.toThrow('POSITION_EXCEEDED')
    await expect(
      adapter.broadcast({ ...p, intent: { ...intent, quantity: '6', quoteBudget: '6' } }),
    ).rejects.toThrow('PREPARED_MISMATCH')
  })
})
