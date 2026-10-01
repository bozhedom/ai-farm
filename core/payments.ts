import { randomUUID } from 'node:crypto'
import { config } from './config'
import { audit, query, transaction, type Connection } from './db'
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
export type PaymentProof = {
  chainId: number
  hash: string
  receiver: string
  amountWei: string
  blockHash: string
  blockNumber: string
  blockTime: string
  confirmations: number
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
  if (
    !body ||
    typeof body !== 'object' ||
    body.error ||
    body.jsonrpc !== '2.0' ||
    body.id !== 1 ||
    !('result' in body)
  )
    throw new Error('RPC_INVALID_RESPONSE')
  return body.result
}

function quantity(value: unknown): bigint {
  // JSON-RPC quantities are compact hexadecimal strings, never JS numbers or null.
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value))
    throw new Error('RPC_INVALID_RESPONSE')
  return BigInt(value)
}

export async function verifySepoliaPayment(
  invoice: Invoice,
  hash: string,
  call: Rpc = rpc,
  minimum = config().SEPOLIA_CONFIRMATIONS,
): Promise<{ confirmed: boolean; confirmations: number; proof: PaymentProof | null }> {
  if (!hashPattern.test(hash)) throw new Error('INVALID_TX_HASH')
  if (!Number.isInteger(minimum) || minimum < 3 || minimum > 64)
    throw new Error('INVALID_CONFIRMATION_LIMIT')
  if (quantity(await call('eth_chainId', [])) !== BigInt(POLICY.chainId))
    throw new Error('WRONG_CHAIN')
  const [tx, receipt] = await Promise.all([
    call('eth_getTransactionByHash', [hash]),
    call('eth_getTransactionReceipt', [hash]),
  ])
  if (!tx || !receipt || !tx.blockHash || !receipt.blockHash)
    return { confirmed: false, confirmations: 0, proof: null }
  const same = (a: unknown, b: string) =>
    typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
  if (!same(tx.hash, hash) || !same(receipt.transactionHash, hash))
    throw new Error('TX_HASH_MISMATCH')
  if (tx.chainId !== undefined && quantity(tx.chainId) !== BigInt(POLICY.chainId))
    throw new Error('WRONG_CHAIN')
  if (quantity(receipt.status) !== 1n) throw new Error('TX_REVERTED')
  if (!same(tx.to, invoice.receiver) || !same(receipt.to, invoice.receiver))
    throw new Error('WRONG_RECEIVER')
  if (quantity(tx.value) !== BigInt(invoice.amount_wei)) throw new Error('WRONG_AMOUNT')
  if (tx.input !== '0x') throw new Error('ONLY_NATIVE_TRANSFER_ALLOWED')
  if (
    typeof receipt.blockHash !== 'string' ||
    !hashPattern.test(receipt.blockHash) ||
    !same(tx.blockHash, receipt.blockHash) ||
    quantity(tx.blockNumber) !== quantity(receipt.blockNumber)
  )
    throw new Error('BLOCK_MISMATCH')
  const [block, latest] = await Promise.all([
    call('eth_getBlockByNumber', [receipt.blockNumber, false]),
    call('eth_blockNumber', []),
  ])
  if (
    !block ||
    !same(block.hash, receipt.blockHash) ||
    quantity(block.number) !== quantity(receipt.blockNumber)
  )
    throw new Error('NON_CANONICAL_BLOCK')
  const time = Number(quantity(block.timestamp)) * 1000
  const start = new Date(invoice.created_at).getTime()
  const end = new Date(invoice.expires_at).getTime()
  if (
    !Number.isSafeInteger(time) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    time < Math.floor(start / 1000) * 1000 ||
    time > end
  )
    throw new Error('TX_OUTSIDE_INVOICE_WINDOW')
  const confirmations = Number(quantity(latest) - quantity(receipt.blockNumber) + 1n)
  if (!Number.isSafeInteger(confirmations) || confirmations < 0 || confirmations > 2147483647)
    throw new Error('INVALID_BLOCK_HEIGHT')
  return {
    confirmed: confirmations >= minimum,
    confirmations,
    proof: {
      chainId: POLICY.chainId,
      hash: hash.toLowerCase(),
      receiver: invoice.receiver.toLowerCase(),
      amountWei: invoice.amount_wei,
      blockHash: receipt.blockHash.toLowerCase(),
      blockNumber: quantity(receipt.blockNumber).toString(),
      blockTime: new Date(time).toISOString(),
      confirmations,
    },
  }
}

// Only called with a locked, payable order after sandbox validation or RPC verification.
async function confirmPayment(
  db: Connection,
  order: Record<string, any>,
  hash: string,
  confirmations: number,
  proof: PaymentProof | null,
) {
  const [updated] = await query(
    `UPDATE orders SET status='paid',paid_at=now(),tx_hash=$2,confirmations=$3,
     payment_error=null,payment_proof=$4,payment_lease_token=null,payment_locked_until=null
     WHERE id=$1 RETURNING *`,
    [order.id, hash, confirmations, proof],
    db,
  )
  await enqueue('fulfill', `fulfill:${order.id}`, { orderId: order.id }, db)
  await audit(
    'test_payment_confirmed',
    'Подтверждена тестовая оплата. Реальная выручка не изменена.',
    { orderId: order.id, mode: order.payment_mode },
    db,
  )
  return updated
}

export async function sandboxPayment(id: string) {
  if (config().PAYMENT_MODE !== 'sandbox') throw new Error('SANDBOX_DISABLED')
  return transaction(async (db) => {
    const [order] = await query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id], db)
    if (!order) throw new Error('ORDER_NOT_FOUND')
    if (order.payment_mode !== 'sandbox') throw new Error('PAYMENT_MODE_MISMATCH')
    if (['paid', 'running', 'delivered'].includes(order.status)) return order
    if (order.status !== 'awaiting_payment') throw new Error('ORDER_NOT_PAYABLE')
    if (new Date(order.expires_at) < new Date()) throw new Error('INVOICE_EXPIRED')
    return confirmPayment(db, order, `sandbox:${id}`, 0, null)
  })
}

export async function submitTransaction(id: string, hash: string) {
  if (!hashPattern.test(hash)) throw new Error('INVALID_TX_HASH')
  hash = hash.toLowerCase()
  return transaction(async (db) => {
    const [order] = await query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id], db)
    if (
      !order ||
      order.payment_mode !== 'sepolia' ||
      order.status !== 'awaiting_payment' ||
      new Date(order.expires_at) <= new Date()
    )
      throw new Error('ORDER_NOT_PAYABLE')
    await query(
      'INSERT INTO payment_attempts(tx_hash,order_id) VALUES($1,$2) ON CONFLICT(tx_hash) DO NOTHING',
      [hash, id],
      db,
    )
    const [attempt] = await query(
      'SELECT order_id FROM payment_attempts WHERE tx_hash=$1',
      [hash],
      db,
    )
    if (attempt?.order_id !== id) throw new Error('TX_ALREADY_USED')
    if (order.tx_hash === hash) return
    await query(
      `UPDATE orders SET tx_hash=$2,confirmations=0,payment_error=null,last_payment_check=null,
       payment_proof=null,payment_lease_token=null,payment_locked_until=null WHERE id=$1`,
      [id, hash],
      db,
    )
    await audit(
      'payment_submitted',
      'Хеш тестового перевода сохранён для автоматической сверки.',
      { orderId: id, hash },
      db,
    )
  })
}

async function expireInvoices() {
  await transaction(async (db) => {
    const expired = await query(
      `UPDATE orders SET status=CASE WHEN tx_hash IS NULL THEN 'expired' ELSE 'manual_review' END,
       payment_lease_token=null,payment_locked_until=null
       WHERE status='awaiting_payment' AND ((tx_hash IS NULL AND expires_at<now()) OR expires_at<now()-interval '24 hours')
       RETURNING id,reservation_id,status`,
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

export async function reconcilePayments(call: Rpc = rpc) {
  await expireInvoices()
  const orders = await transaction(async (db) => {
    const pending = await query(
      `SELECT * FROM orders WHERE payment_mode='sepolia' AND status='awaiting_payment'
       AND tx_hash IS NOT NULL AND (last_payment_check IS NULL OR last_payment_check<now()-interval '30 seconds')
       AND (payment_locked_until IS NULL OR payment_locked_until<now())
       ORDER BY last_payment_check NULLS FIRST,created_at FOR UPDATE SKIP LOCKED LIMIT 4`,
      [],
      db,
    )
    for (const order of pending) {
      order.payment_lease_token = randomUUID()
      await query(
        `UPDATE orders SET last_payment_check=now(),payment_lease_token=$2,
         payment_locked_until=now()+interval '2 minutes' WHERE id=$1`,
        [order.id, order.payment_lease_token],
        db,
      )
    }
    return pending
  })
  // Four parallel verifications bound a cycle to three RPC timeouts, not 20 sequential transfers.
  await Promise.all(
    orders.map(async (order) => {
      let result: Awaited<ReturnType<typeof verifySepoliaPayment>> | undefined
      let code: string | null = null
      try {
        result = await verifySepoliaPayment(
          order as Invoice,
          order.tx_hash,
          call,
          order.required_confirmations,
        )
      } catch (error) {
        code =
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'RPC_UNAVAILABLE'
      }
      // Hash + lease fence prevents a delayed response from replacing a newer verification.
      await transaction(async (db) => {
        const [current] = await query(
          `SELECT * FROM orders WHERE id=$1 AND tx_hash=$2 AND payment_lease_token=$3
         AND payment_locked_until>now() AND status='awaiting_payment' FOR UPDATE`,
          [order.id, order.tx_hash, order.payment_lease_token],
          db,
        )
        if (!current) return
        await query(
          `UPDATE payment_attempts SET checked_at=now(),confirmations=$2,error_code=$3,proof=$4,
         confirmed_at=CASE WHEN $5 THEN now() ELSE confirmed_at END WHERE tx_hash=$1 AND order_id=$6`,
          [
            order.tx_hash,
            result?.confirmations ?? 0,
            code,
            result?.proof ?? null,
            result?.confirmed ?? false,
            order.id,
          ],
          db,
        )
        if (result?.confirmed) {
          await confirmPayment(db, current, order.tx_hash, result.confirmations, result.proof)
        } else {
          await query(
            `UPDATE orders SET confirmations=$2,payment_error=$3,
           payment_lease_token=null,payment_locked_until=null WHERE id=$1`,
            [order.id, result?.confirmations ?? 0, code],
            db,
          )
        }
      })
    }),
  )
  await query('UPDATE system_state SET payment_heartbeat=now() WHERE id=true')
}
