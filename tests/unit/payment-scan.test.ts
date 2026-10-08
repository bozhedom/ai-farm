import { describe, expect, it } from 'vitest'
import {
  matchTransfers,
  planScan,
  precheckTransfer,
  scanLookback,
  scanMaxBehind,
  scanStep,
  type OpenInvoice,
} from '../../core/payments'
import { mockChain } from '../fixtures/chain'

const receiver = '0x' + 'c'.repeat(40)
const created = new Date('2026-10-08T12:00:00Z')
const invoice = (id: string, wei: bigint): OpenInvoice => ({
  id,
  receiver,
  amount_wei: wei.toString(),
  created_at: created,
  expires_at: new Date(created.getTime() + 3600000),
})
const inWindow = Math.floor(created.getTime() / 1000) + 60

describe('block scan plan', () => {
  it('continues after the cursor and never reads more than one step', () => {
    expect(planScan(100n, 105n, 0, false)).toEqual({ from: 101n, to: 105n })
    expect(planScan(100n, 500n, 0, false)).toEqual({ from: 101n, to: 100n + BigInt(scanStep) })
    expect(planScan(105n, 105n, 0, false)).toBeNull()
  })

  it('restarts below the tip without a cursor, after a pause or a node reset', () => {
    const fresh = planScan(null, 1000n, 0, true)!
    expect(fresh.from).toBe(1000n - BigInt(scanLookback) + 1n)
    expect(planScan(990n, 1000n, 300, true)!.from).toBe(701n)
    expect(planScan(5000n, 1000n, 0, false)!.from).toBe(1000n - BigInt(scanLookback) + 1n)
    expect(planScan(null, 5n, 100, true)).toEqual({ from: 0n, to: 5n })
  })

  it('does not look back further than the limit', () => {
    expect(planScan(1n, 100000n, 0, false)!.from).toBe(100000n - BigInt(scanMaxBehind) + 1n)
    expect(planScan(null, 100000n, 10 ** 9, true)!.from).toBe(100000n - BigInt(scanMaxBehind) + 1n)
  })
})

describe('transfer matching', () => {
  const a = invoice('a', 1633000000000042n)
  const b = invoice('b', 1633000000000043n)
  const tx = (to: string | null, value: bigint, extra: Record<string, unknown> = {}) => ({
    hash: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
    to,
    value: '0x' + value.toString(16),
    input: '0x',
    ...extra,
  })

  it('finds plain transfers with the exact amount of an open invoice', () => {
    const pay = tx(receiver.toUpperCase().replace('0X', '0x'), 1633000000000043n)
    const block = {
      timestamp: '0x' + inWindow.toString(16),
      transactions: [
        tx(receiver, 1633000000000044n),
        tx('0x' + 'd'.repeat(40), 1633000000000042n),
        tx(receiver, 1633000000000042n, { input: '0xa9059cbb' }),
        tx(null, 1633000000000042n),
        pay,
      ],
    }
    expect(matchTransfers(block, [a, b], receiver)).toEqual([
      { orderId: 'b', hash: pay.hash.toLowerCase(), amountWei: b.amount_wei },
    ])
  })

  it('ignores transfers outside the invoice window', () => {
    const early = {
      timestamp: '0x' + (inWindow - 120).toString(16),
      transactions: [tx(receiver, 1633000000000042n)],
    }
    const late = {
      timestamp: '0x' + (inWindow + 7200).toString(16),
      transactions: [tx(receiver, 1633000000000042n)],
    }
    expect(matchTransfers(early, [a], receiver)).toEqual([])
    expect(matchTransfers(late, [a], receiver)).toEqual([])
  })

  it('stops on malformed node data instead of skipping a block', () => {
    expect(() => matchTransfers(null, [a], receiver)).toThrow('RPC_INVALID_RESPONSE')
    expect(() =>
      matchTransfers({ timestamp: '0x1', transactions: ['0xabc'] }, [a], receiver),
    ).toThrow('RPC_INVALID_RESPONSE')
    expect(() => matchTransfers({ timestamp: 5, transactions: [] }, [a], receiver)).toThrow(
      'RPC_INVALID_RESPONSE',
    )
  })
})

describe('hash precheck', () => {
  it('refuses a known transfer that cannot pay this invoice and lets unknown ones wait', async () => {
    const chain = mockChain()
    const inv = invoice('a', 1633000000000042n)
    const good = chain.transfer(receiver, 1633000000000042n)
    const wrongAmount = chain.transfer(receiver, 1633000000000041n)
    const wrongReceiver = chain.transfer('0x' + 'd'.repeat(40), 1633000000000042n)
    const contract = chain.transfer(receiver, 1633000000000042n, { input: '0xa9059cbb' })
    await expect(precheckTransfer(inv, good, chain.rpc)).resolves.toBeUndefined()
    await expect(precheckTransfer(inv, wrongAmount, chain.rpc)).rejects.toThrow('WRONG_AMOUNT')
    await expect(precheckTransfer(inv, wrongReceiver, chain.rpc)).rejects.toThrow('WRONG_RECEIVER')
    await expect(precheckTransfer(inv, contract, chain.rpc)).rejects.toThrow(
      'ONLY_NATIVE_TRANSFER_ALLOWED',
    )
    await expect(precheckTransfer(inv, '0x' + '9'.repeat(64), chain.rpc)).resolves.toBeUndefined()
    chain.fail.eth_getTransactionByHash = () => {
      throw new Error('RPC_UNAVAILABLE')
    }
    await expect(precheckTransfer(inv, wrongAmount, chain.rpc)).resolves.toBeUndefined()
    await expect(precheckTransfer(inv, 'nope', chain.rpc)).rejects.toThrow('INVALID_TX_HASH')
  })
})
