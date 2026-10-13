import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createAaveAdapter,
  createAaveRpc,
  type AaveSettings,
  type PreparedAaveTransaction,
} from '../../core/execution/adapters/aave'

// Public deterministic Anvil account 0. Local fixture only; never a customer credential.
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const sender = privateKeyToAccount(key).address
const url = process.env.AAVE_ANVIL_RPC_URL || process.env.ANVIL_RPC_URL
const fixtureAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function aToken() view returns (address)',
  'function setDebt(uint256 amount)',
])
const tokenAbi = parseAbi(['function balanceOf(address who) view returns (uint256)'])

if (!url)
  process.stderr.write(
    '\nexecution-aave-anvil skipped: run npm run test:crypto with the local Anvil fixture.\n',
  )

describe.skipIf(!url)(
  'Aave-compatible local contract fixture (not external Aave acceptance)',
  () => {
    const rpc = createAaveRpc({ rpcUrl: url || 'http://127.0.0.1:18546', network: 'local' })
    let settings: AaveSettings
    let adapter: ReturnType<typeof createAaveAdapter>
    let snapshot: string
    async function waitReceipt(txHash: unknown) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const receipt = (await rpc('eth_getTransactionReceipt', [txHash])) as {
          status: string
          contractAddress?: Address
        } | null
        if (receipt) return receipt
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('FIXTURE_RECEIPT_TIMEOUT')
    }
    async function send(to: Address | undefined, data: Hex) {
      const txHash = await rpc('eth_sendTransaction', [
        { from: sender, ...(to ? { to } : {}), data, gas: '0x4c4b40' },
      ])
      const receipt = await waitReceipt(txHash)
      expect(receipt.status).toBe('0x1')
      return receipt
    }
    const mine = (count = 2) => rpc('anvil_mine', [`0x${count.toString(16)}`])
    async function complete(p: PreparedAaveTransaction) {
      // The generic engine persists this JSON before dispatch; this roundtrip imitates restart.
      const stored = JSON.parse(JSON.stringify(p)) as PreparedAaveTransaction
      await createAaveAdapter(settings).broadcast(stored)
      await waitReceipt(stored.hash)
      await mine()
      const receipt = await createAaveAdapter(settings).lookup(stored)
      expect(receipt.status).toBe('confirmed')
      return stored
    }
    beforeAll(async () => {
      expect(String(await rpc('web3_clientVersion', []))).toMatch(/^anvil\b/i)
      expect(await rpc('eth_chainId', [])).toBe('0xaa36a7')
      const artifact = JSON.parse(
        await readFile(new URL('../fixtures/aave/bytecode.json', import.meta.url), 'utf8'),
      )
      const source = await readFile(
        new URL('../fixtures/aave/ExecutionFixture.sol', import.meta.url),
      )
      expect(createHash('sha256').update(source).digest('hex')).toBe(artifact.sourceSha256)
      const token = (await send(undefined, artifact.contracts.FixtureToken.bytecode))
        .contractAddress!
      const pool = (
        await send(
          undefined,
          encodeDeployData({
            abi: artifact.contracts.FixturePool.abi,
            bytecode: artifact.contracts.FixturePool.bytecode,
            args: [token],
          }),
        )
      ).contractAddress!
      const data = encodeFunctionData({ abi: fixtureAbi, functionName: 'aToken' })
      const encodedAToken = (await rpc('eth_call', [{ to: pool, data }, 'latest'])) as string
      const aToken = `0x${encodedAToken.slice(-40)}` as Address
      const pin = async (address: Address) => ({
        address,
        codeHash: keccak256((await rpc('eth_getCode', [address, 'latest'])) as Hex),
      })
      settings = {
        rpcUrl: url!,
        network: 'local',
        chainId: 11155111,
        privateKey: key,
        sender,
        pool: await pin(pool),
        token: await pin(token),
        aToken: await pin(aToken),
        decimals: 6,
        confirmations: 3,
        maxAmountAtoms: 10_000_000n,
        maxGas: 500_000n,
        maxFeePerGasWei: 100_000_000_000n,
        maxGasCostWei: 50_000_000_000_000_000n,
      }
      await send(
        token,
        encodeFunctionData({ abi: fixtureAbi, functionName: 'mint', args: [sender, 100_000_000n] }),
      )
      adapter = createAaveAdapter(settings)
      await adapter.verifyDeployment()
      snapshot = (await rpc('evm_snapshot', [])) as string
    }, 30_000)
    beforeEach(async () => {
      expect(await rpc('evm_revert', [snapshot])).toBe(true)
      snapshot = (await rpc('evm_snapshot', [])) as string
    })

    it('supplies and withdraws exact amounts, keeping approval and each signed transaction durable', async () => {
      const before = await adapter.balances()
      const approval = await adapter.prepare({ action: 'approve', amountAtoms: '5000000' })
      expect(await rpc('eth_getTransactionByHash', [approval.hash])).toBeNull()
      await complete(approval)
      expect((await adapter.balances()).allowance).toBe(5_000_000n)
      const supply = await complete(
        await adapter.prepare({ action: 'supply', amountAtoms: '5000000' }),
      )
      expect(await adapter.balances()).toMatchObject({
        wallet: before.wallet - 5_000_000n,
        supplied: 5_000_000n,
        allowance: 0n,
      })
      await adapter.broadcast(supply)
      expect((await adapter.balances()).supplied).toBe(5_000_000n)
      const withdraw = await complete(
        await adapter.prepare({ action: 'withdraw', amountAtoms: '5000000' }),
      )
      expect(await adapter.balances()).toMatchObject({
        wallet: before.wallet,
        supplied: 0n,
        allowance: 0n,
      })
      const receipt = await adapter.lookup(withdraw)
      expect(receipt.status).toBe('confirmed')
      if (receipt.status === 'confirmed') expect(BigInt(receipt.gasCostWei)).toBeGreaterThan(0n)
      expect(supply.nonce).toBe(approval.nonce + 1)
      expect(withdraw.nonce).toBe(supply.nonce + 1)
    })

    it('finds a transaction after losing its send response and waits for confirmations', async () => {
      const p = await adapter.prepare({ action: 'approve', amountAtoms: '5000000' })
      const unreliable = createAaveAdapter(settings, async (method, params) => {
        const result = await rpc(method, params)
        if (method === 'eth_sendRawTransaction') throw new Error('connection lost after send')
        return result
      })
      await expect(unreliable.broadcast(p)).rejects.toThrow('BROADCAST_UNCERTAIN')
      await waitReceipt(p.hash)
      expect(await adapter.lookup(p)).toEqual({ status: 'pending' })
      await mine()
      expect(await adapter.lookup(p)).toMatchObject({
        status: 'confirmed',
        hash: p.hash,
        amountAtoms: '5000000',
      })
      await adapter.broadcast(p)
      expect((await adapter.balances()).allowance).toBe(5_000_000n)
    })

    it('requires explicit revoke before another approval and refuses an account with debt', async () => {
      await complete(await adapter.prepare({ action: 'approve', amountAtoms: '5000000' }))
      await expect(adapter.prepare({ action: 'approve', amountAtoms: '6000000' })).rejects.toThrow(
        'REVOKE_REQUIRED',
      )
      await complete(await adapter.prepare({ action: 'revoke', amountAtoms: '0' }))
      expect((await adapter.balances()).allowance).toBe(0n)
      await send(
        settings.pool.address,
        encodeFunctionData({ abi: fixtureAbi, functionName: 'setDebt', args: [1n] }),
      )
      await expect(adapter.prepare({ action: 'approve', amountAtoms: '5000000' })).rejects.toThrow(
        'DEBT_PRESENT',
      )
    })

    it('refuses a replaced nonce and a modified code pin without signing another transaction', async () => {
      const p = await adapter.prepare({ action: 'approve', amountAtoms: '5000000' })
      await send(
        settings.token.address,
        encodeFunctionData({ abi: tokenAbi, functionName: 'balanceOf', args: [sender] }),
      )
      expect(await adapter.lookup(p)).toEqual({ status: 'nonce_conflict' })
      await expect(adapter.broadcast(p)).rejects.toThrow('NONCE_CONFLICT')
      const changed = createAaveAdapter({
        ...settings,
        pool: { ...settings.pool, codeHash: `0x${'00'.repeat(32)}` },
      })
      await expect(changed.prepare({ action: 'approve', amountAtoms: '5000000' })).rejects.toThrow(
        'CODE_MISMATCH',
      )
    })
  },
)
