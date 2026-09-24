import { randomUUID } from 'node:crypto'
import { config } from './config'
import { audit, query, transaction } from './db'
import { closeReservation } from './budget'
import { enqueue } from './queue'
import { POLICY } from './policy'

export type Rpc = (method: string, params: unknown[]) => Promise<any>
export type Invoice = {
  receiver: string
  amount_wei: string
  created_at: Date | string
  expires_at: Date | string
}
export const hashPattern = /^0x[0-9a-fA-F]{64}$/

export const rpc: Rpc = async (method, params) => {
  const response = await fetch(config().SEPOLIA_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error('RPC_UNAVAILABLE')
  const body = await response.json()
  if (body.error || body.jsonrpc !== '2.0' || body.id !== 1) throw new Error('RPC_INVALID_RESPONSE')
  return body.result
}

export async function verifySepoliaPayment(
  invoice: Invoice,
  hash: string,
  call: Rpc = rpc,
  minimum = config().SEPOLIA_CONFIRMATIONS,
): Promise<{ confirmed: boolean; confirmations: number }> {
  if (!hashPattern.test(hash)) throw new Error('INVALID_TX_HASH')
  const chain = await call('eth_chainId', [])
  if (BigInt(chain) !== BigInt(POLICY.chainId)) throw new Error('WRONG_CHAIN')
  const [tx, receipt] = await Promise.all([
    call('eth_getTransactionByHash', [hash]),
    call('eth_getTransactionReceipt', [hash]),
  ])
  if (!tx || !receipt || !tx.blockHash || !receipt.blockHash)
    return { confirmed: false, confirmations: 0 }
  const same = (a: unknown, b: string) =>
    typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
  if (!same(tx.hash, hash) || !same(receipt.transactionHash, hash))
    throw new Error('TX_HASH_MISMATCH')
  if (tx.chainId && BigInt(tx.chainId) !== BigInt(POLICY.chainId)) throw new Error('WRONG_CHAIN')
  if (BigInt(receipt.status) !== 1n) throw new Error('TX_REVERTED')
  if (!same(tx.to, invoice.receiver) || !same(receipt.to, invoice.receiver))
    throw new Error('WRONG_RECEIVER')
  if (BigInt(tx.value) !== BigInt(invoice.amount_wei)) throw new Error('WRONG_AMOUNT')
  if (tx.input !== '0x') throw new Error('ONLY_NATIVE_TRANSFER_ALLOWED')
  if (
    !same(tx.blockHash, receipt.blockHash) ||
    BigInt(tx.blockNumber) !== BigInt(receipt.blockNumber)
  )
    throw new Error('BLOCK_MISMATCH')
  const [block, latest] = await Promise.all([
    call('eth_getBlockByNumber', [receipt.blockNumber, false]),
    call('eth_blockNumber', []),
  ])
  if (
    !block ||
    !same(block.hash, receipt.blockHash) ||
    BigInt(block.number) !== BigInt(receipt.blockNumber)
  )
    throw new Error('NON_CANONICAL_BLOCK')
  const time = Number(BigInt(block.timestamp)) * 1000
  if (
    !Number.isSafeInteger(time) ||
    time < Math.floor(new Date(invoice.created_at).getTime() / 1000) * 1000 ||
    time > new Date(invoice.expires_at).getTime()
  )
    throw new Error('TX_OUTSIDE_INVOICE_WINDOW')
  const confirmations = Number(BigInt(latest) - BigInt(receipt.blockNumber) + 1n)
  if (!Number.isSafeInteger(confirmations) || confirmations < 0)
    throw new Error('INVALID_BLOCK_HEIGHT')
  return { confirmed: confirmations >= Math.max(3, minimum), confirmations }
}

export async function confirmPayment(
  id: string,
  hash: string,
  confirmations: number,
  expectedMode: 'sandbox' | 'sepolia',
) {
  return transaction(async (db) => {
    const [order] = await query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id], db)
    if (!order) throw new Error('ORDER_NOT_FOUND')
    if (order.payment_mode !== expectedMode) throw new Error('PAYMENT_MODE_MISMATCH')
    if (['paid', 'running', 'delivered'].includes(order.status)) return order
    if (order.status !== 'awaiting_payment') throw new Error('ORDER_NOT_PAYABLE')
    if (expectedMode === 'sandbox' && new Date(order.expires_at) < new Date())
      throw new Error('INVOICE_EXPIRED')
    if (expectedMode === 'sepolia' && order.tx_hash !== hash) throw new Error('TX_CHANGED')
    const [updated] = await query(
      "UPDATE orders SET status='paid',paid_at=now(),tx_hash=$2,confirmations=$3,payment_error=null WHERE id=$1 RETURNING *",
      [id, hash, confirmations],
      db,
    )
    await enqueue('fulfill', `fulfill:${id}`, { orderId: id }, db)
    await audit(
      'test_payment_confirmed',
      'Подтверждена тестовая оплата. Реальная выручка не изменена.',
      { orderId: id, mode: expectedMode },
      db,
    )
    return updated
  })
}

export async function sandboxPayment(id: string) {
  if (config().PAYMENT_MODE !== 'sandbox') throw new Error('SANDBOX_DISABLED')
  return confirmPayment(id, `sandbox:${id}`, 0, 'sandbox')
}

export async function submitTransaction(id: string, hash: string) {
  if (!hashPattern.test(hash)) throw new Error('INVALID_TX_HASH')
  const rows = await query(
    "UPDATE orders SET tx_hash=$2,payment_error=null,last_payment_check=null WHERE id=$1 AND payment_mode='sepolia' AND status='awaiting_payment' AND expires_at>now() RETURNING id",
    [id, hash.toLowerCase()],
  )
  if (!rows.length) throw new Error('ORDER_NOT_PAYABLE')
}

export async function reconcilePayments() {
  const orders =
    await query(`SELECT * FROM orders WHERE payment_mode='sepolia' AND status='awaiting_payment'
    AND tx_hash IS NOT NULL AND (last_payment_check IS NULL OR last_payment_check<now()-interval '30 seconds') ORDER BY created_at LIMIT 20`)
  for (const order of orders) {
    await query('UPDATE orders SET last_payment_check=now() WHERE id=$1', [order.id])
    try {
      const result = await verifySepoliaPayment(order as Invoice, order.tx_hash)
      await query(
        'UPDATE orders SET confirmations=$2,payment_error=null WHERE id=$1 AND tx_hash=$3',
        [order.id, result.confirmations, order.tx_hash],
      )
      if (result.confirmed)
        await confirmPayment(order.id, order.tx_hash, result.confirmations, 'sepolia')
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'RPC_UNAVAILABLE'
      await query('UPDATE orders SET payment_error=$2 WHERE id=$1 AND tx_hash=$3', [
        order.id,
        code,
        order.tx_hash,
      ])
    }
  }
  await transaction(async (db) => {
    const expired = await query(
      `UPDATE orders SET status=CASE WHEN tx_hash IS NULL THEN 'expired' ELSE 'manual_review' END
      WHERE status='awaiting_payment' AND ((tx_hash IS NULL AND expires_at<now()) OR expires_at<now()-interval '24 hours') RETURNING id,reservation_id,status`,
      [],
      db,
    )
    for (const order of expired) {
      await closeReservation(order.reservation_id, db)
      await audit(
        'invoice_expired',
        order.status === 'manual_review'
          ? 'Тестовый платёж требует проверки владельцем.'
          : 'Срок тестового счёта истёк; резерв освобождён.',
        { orderId: order.id },
        db,
      )
    }
  })
}
