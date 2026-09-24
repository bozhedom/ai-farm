import { describe, expect, it } from 'vitest'
import { verifySepoliaPayment, type Invoice, type Rpc } from '../../core/payments'
const hash = '0x' + 'a'.repeat(64),
  blockHash = '0x' + 'b'.repeat(64),
  receiver = '0x' + 'c'.repeat(40)
const invoice: Invoice = {
  receiver,
  amount_wei: '100000000000001',
  created_at: '2026-09-24T00:00:00Z',
  expires_at: '2026-09-24T01:00:00Z',
}
function fixture(overrides: Record<string, any> = {}): Rpc {
  const values: Record<string, any> = {
    eth_chainId: '0xaa36a7',
    eth_getTransactionByHash: {
      hash,
      to: receiver,
      value: '0x' + BigInt(invoice.amount_wei).toString(16),
      input: '0x',
      blockHash,
      blockNumber: '0x64',
      chainId: '0xaa36a7',
    },
    eth_getTransactionReceipt: {
      transactionHash: hash,
      to: receiver,
      status: '0x1',
      blockHash,
      blockNumber: '0x64',
    },
    eth_getBlockByNumber: {
      hash: blockHash,
      number: '0x64',
      timestamp: '0x' + Math.floor(new Date('2026-09-24T00:10:00Z').getTime() / 1000).toString(16),
    },
    eth_blockNumber: '0x66',
  }
  for (const [key, value] of Object.entries(overrides))
    values[key] = value && typeof value === 'object' ? { ...values[key], ...value } : value
  return async (method) => values[method]
}
describe('Sepolia verification', () => {
  it('accepts only the matching canonical successful transfer', async () =>
    expect(await verifySepoliaPayment(invoice, hash, fixture(), 3)).toEqual({
      confirmed: true,
      confirmations: 3,
    }))
  it('waits for confirmations', async () =>
    expect(
      await verifySepoliaPayment(invoice, hash, fixture({ eth_blockNumber: '0x65' }), 3),
    ).toEqual({ confirmed: false, confirmations: 2 }))
  it('waits for a mined receipt', async () =>
    expect(
      await verifySepoliaPayment(invoice, hash, fixture({ eth_getTransactionReceipt: null }), 3),
    ).toEqual({ confirmed: false, confirmations: 0 }))
  it.each([
    [{ eth_chainId: '0x1' }, 'WRONG_CHAIN'],
    [{ eth_getTransactionByHash: { chainId: '0x1' } }, 'WRONG_CHAIN'],
    [{ eth_getTransactionByHash: { to: '0x' + 'd'.repeat(40) } }, 'WRONG_RECEIVER'],
    [{ eth_getTransactionByHash: { value: '0x1' } }, 'WRONG_AMOUNT'],
    [{ eth_getTransactionReceipt: { status: '0x0' } }, 'TX_REVERTED'],
    [{ eth_getTransactionReceipt: { transactionHash: '0x' + 'e'.repeat(64) } }, 'TX_HASH_MISMATCH'],
    [{ eth_getBlockByNumber: { hash: '0x' + 'f'.repeat(64) } }, 'NON_CANONICAL_BLOCK'],
    [{ eth_getTransactionByHash: { input: '0x1234' } }, 'ONLY_NATIVE_TRANSFER_ALLOWED'],
    [{ eth_getBlockByNumber: { timestamp: '0x1' } }, 'TX_OUTSIDE_INVOICE_WINDOW'],
    [
      {
        eth_getBlockByNumber: {
          timestamp:
            '0x' + Math.floor(new Date('2026-09-25T00:00:00Z').getTime() / 1000).toString(16),
        },
      },
      'TX_OUTSIDE_INVOICE_WINDOW',
    ],
  ])('rejects mismatched transfer %j', async (overrides, code) => {
    await expect(
      verifySepoliaPayment(invoice, hash, fixture(overrides as Record<string, any>), 3),
    ).rejects.toThrow(code as string)
  })
})
