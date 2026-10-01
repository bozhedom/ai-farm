import type { Invoice, Rpc } from '../../core/payments'

export const paymentHash = '0x' + 'a'.repeat(64)
export const paymentBlockHash = '0x' + 'b'.repeat(64)
export const paymentReceiver = '0x' + 'c'.repeat(40)
export const paymentInvoice: Invoice = {
  receiver: paymentReceiver,
  amount_wei: '100000000000001',
  created_at: '2026-09-24T00:00:00Z',
  expires_at: '2026-09-24T01:00:00Z',
}
export function paymentRpc(
  overrides: Record<string, any> = {},
  invoice: Invoice = paymentInvoice,
  hash = paymentHash,
): Rpc {
  const values: Record<string, any> = {
    eth_chainId: '0xaa36a7',
    eth_getTransactionByHash: {
      hash,
      to: invoice.receiver,
      value: '0x' + BigInt(invoice.amount_wei).toString(16),
      input: '0x',
      blockHash: paymentBlockHash,
      blockNumber: '0x64',
      chainId: '0xaa36a7',
    },
    eth_getTransactionReceipt: {
      transactionHash: hash,
      to: invoice.receiver,
      status: '0x1',
      blockHash: paymentBlockHash,
      blockNumber: '0x64',
    },
    eth_getBlockByNumber: {
      hash: paymentBlockHash,
      number: '0x64',
      timestamp: '0x' + Math.floor(new Date(invoice.created_at).getTime() / 1000).toString(16),
    },
    eth_blockNumber: '0x66',
  }
  for (const [key, value] of Object.entries(overrides))
    values[key] = value && typeof value === 'object' ? { ...values[key], ...value } : value
  return async (method) => values[method]
}
