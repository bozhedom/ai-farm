import { describe, expect, it } from 'vitest'
import { verifySepoliaPayment } from '../../core/payments'
import {
  paymentHash as hash,
  paymentReceiver as receiver,
  paymentBlockHash as blockHash,
  paymentInvoice as invoice,
  paymentRpc as fixture,
} from '../fixtures/sepolia'
describe('Sepolia verification', () => {
  it('accepts only the matching canonical successful transfer', async () =>
    expect(await verifySepoliaPayment(invoice, hash, fixture(), 3)).toEqual({
      confirmed: true,
      confirmations: 3,
      proof: {
        chainId: 11155111,
        hash,
        receiver,
        amountWei: invoice.amount_wei,
        blockHash,
        blockNumber: '100',
        blockTime: '2026-09-24T00:00:00.000Z',
        confirmations: 3,
      },
    }))
  it('uses the invoice confirmation threshold and refuses unsafe thresholds', async () => {
    expect(await verifySepoliaPayment(invoice, hash, fixture(), 5)).toMatchObject({
      confirmed: false,
      confirmations: 3,
    })
    await expect(verifySepoliaPayment(invoice, hash, fixture(), 2)).rejects.toThrow(
      'INVALID_CONFIRMATION_LIMIT',
    )
  })
  it('waits for confirmations', async () =>
    expect(
      await verifySepoliaPayment(invoice, hash, fixture({ eth_blockNumber: '0x65' }), 3),
    ).toMatchObject({ confirmed: false, confirmations: 2, proof: { hash, confirmations: 2 } }))
  it('waits for a mined receipt', async () =>
    expect(
      await verifySepoliaPayment(invoice, hash, fixture({ eth_getTransactionReceipt: null }), 3),
    ).toEqual({ confirmed: false, confirmations: 0, proof: null }))
  it.each([
    [{ eth_chainId: '0x1' }, 'WRONG_CHAIN'],
    [{ eth_chainId: 11155111 }, 'RPC_INVALID_RESPONSE'],
    [{ eth_getTransactionReceipt: { status: null } }, 'RPC_INVALID_RESPONSE'],
    [{ eth_getTransactionByHash: { value: '0x00' } }, 'RPC_INVALID_RESPONSE'],
    [{ eth_getTransactionReceipt: { blockNumber: false } }, 'RPC_INVALID_RESPONSE'],
    [{ eth_getBlockByNumber: { timestamp: '2026' } }, 'RPC_INVALID_RESPONSE'],
    [{ eth_blockNumber: '0x1' }, 'INVALID_BLOCK_HEIGHT'],
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
