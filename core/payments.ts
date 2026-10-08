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
    // Serialize new obligations with generation changes; keep state -> order lock order.
    await query('SELECT id FROM system_state WHERE id=true FOR UPDATE', [], db)
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

const sameAddress = (a: unknown, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/**
 * Cheap check before a buyer's hash is pinned to an order forever. A transaction the node
 * already knows must go to this invoice's receiver with its exact amount; otherwise the hash is
 * refused, so nobody can pin somebody else's transfer to their own order. Unknown or unreadable
 * transactions pass: full verification happens in `reconcilePayments`.
 */
export async function precheckTransfer(invoice: Invoice, hash: string, call: Rpc = rpc) {
  if (!hashPattern.test(hash)) throw new Error('INVALID_TX_HASH')
  let tx: any
  try {
    tx = await call('eth_getTransactionByHash', [hash])
  } catch {
    return
  }
  if (!tx || typeof tx !== 'object') return
  if (!sameAddress(tx.to, invoice.receiver)) throw new Error('WRONG_RECEIVER')
  let value: bigint
  try {
    value = quantity(tx.value)
  } catch {
    return
  }
  if (value !== BigInt(invoice.amount_wei)) throw new Error('WRONG_AMOUNT')
  if (typeof tx.input === 'string' && tx.input !== '0x')
    throw new Error('ONLY_NATIVE_TRANSFER_ALLOWED')
}

/** Blocks fetched per cycle, blocks re-read after a pause, and the furthest the scan looks back. */
export const scanStep = 12
export const scanLookback = 4
export const scanMaxBehind = 1000
/** Verified mismatches: such a hash cannot pay its order, so a matching transfer may replace it. */
export const replaceableErrors: readonly string[] = Object.freeze([
  'WRONG_AMOUNT',
  'WRONG_RECEIVER',
  'TX_REVERTED',
  'ONLY_NATIVE_TRANSFER_ALLOWED',
  'TX_OUTSIDE_INVOICE_WINDOW',
  'TX_HASH_MISMATCH',
])
/** Unhashed Sepolia invoices stay open this long after expiry so the scanner can catch up. */
export const scanGraceSeconds = 300

/**
 * Inclusive block range for one scan cycle, or null when there is nothing new. A missing,
 * stale or impossible cursor (node reset) restarts `backfill` blocks below the tip.
 */
export function planScan(
  cursor: bigint | null,
  latest: bigint,
  backfill: number,
  stale: boolean,
): { from: bigint; to: bigint } | null {
  const back = BigInt(Math.max(scanLookback, Math.min(scanMaxBehind, Math.ceil(backfill))))
  let from = cursor === null || stale || cursor > latest ? latest - back + 1n : cursor + 1n
  const floor = latest - BigInt(scanMaxBehind) + 1n
  if (from < floor) from = floor
  if (from < 0n) from = 0n
  if (from > latest) return null
  const last = from + BigInt(scanStep) - 1n
  return { from, to: last < latest ? last : latest }
}

export type OpenInvoice = Invoice & { id: string }

/**
 * Plain transfers in one block that pay an open invoice exactly: right receiver, exact unique
 * amount, no contract call, block time inside the invoice window. Malformed data aborts the
 * cycle so the cursor never skips a block it could not read.
 */
export function matchTransfers(block: any, invoices: OpenInvoice[], receiver: string) {
  if (!block || typeof block !== 'object' || !Array.isArray(block.transactions))
    throw new Error('RPC_INVALID_RESPONSE')
  const time = Number(quantity(block.timestamp)) * 1000
  const byAmount = new Map(invoices.map((invoice) => [BigInt(invoice.amount_wei), invoice]))
  const found: { orderId: string; hash: string; amountWei: string }[] = []
  for (const tx of block.transactions) {
    if (!tx || typeof tx !== 'object' || typeof tx.hash !== 'string' || !hashPattern.test(tx.hash))
      throw new Error('RPC_INVALID_RESPONSE')
    if (!sameAddress(tx.to, receiver) || tx.input !== '0x') continue
    const invoice = byAmount.get(quantity(tx.value))
    if (!invoice || !sameAddress(invoice.receiver, receiver)) continue
    const start = Math.floor(new Date(invoice.created_at).getTime() / 1000) * 1000
    if (time < start || time > new Date(invoice.expires_at).getTime()) continue
    found.push({ orderId: invoice.id, hash: tx.hash.toLowerCase(), amountWei: invoice.amount_wei })
  }
  return found
}

/** Pins a scanned transfer to its invoice with the same one-hash-one-order rule as buyers. */
async function attachDetectedPayment(orderId: string, hash: string, amountWei: string) {
  return transaction(async (db) => {
    const [order] = await query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId], db)
    if (
      !order ||
      order.payment_mode !== 'sepolia' ||
      order.status !== 'awaiting_payment' ||
      String(order.amount_wei) !== amountWei ||
      order.tx_hash === hash ||
      (order.tx_hash && !replaceableErrors.includes(order.payment_error))
    )
      return false
    await query(
      `INSERT INTO payment_attempts(tx_hash,order_id,detected_by_scan) VALUES($1,$2,true)
       ON CONFLICT(tx_hash) DO NOTHING`,
      [hash, orderId],
      db,
    )
    const [attempt] = await query(
      'SELECT order_id FROM payment_attempts WHERE tx_hash=$1',
      [hash],
      db,
    )
    if (attempt?.order_id !== orderId) return false
    await query(
      `UPDATE orders SET tx_hash=$2,confirmations=0,payment_error=null,last_payment_check=null,
       payment_proof=null,payment_lease_token=null,payment_locked_until=null WHERE id=$1`,
      [orderId, hash],
      db,
    )
    await audit(
      'payment_detected',
      'Найден тестовый перевод на точную сумму счёта. Хеш сохранён для сверки.',
      { orderId, hash },
      db,
    )
    return true
  })
}

/**
 * Finds buyer transfers without a submitted hash: reads new Sepolia blocks with transactions
 * and pins exact-amount transfers to open invoices. Read-only RPC; the server holds no keys.
 * Confirmation still goes through `verifySepoliaPayment`, exactly like a submitted hash.
 */
export async function scanPayments(call: Rpc = rpc, now = new Date()) {
  const c = config()
  if (c.PAYMENT_MODE !== 'sepolia' || !c.SEPOLIA_SCAN_ENABLED) return { scanned: 0, found: 0 }
  const receiver = c.SEPOLIA_RECEIVER.toLowerCase()
  const invoices = await query<OpenInvoice>(
    `SELECT id,amount_wei::text AS amount_wei,receiver,created_at,expires_at FROM orders
     WHERE payment_mode='sepolia' AND status='awaiting_payment' AND receiver=$1
     AND expires_at>now()-make_interval(secs=>$2)
     AND (tx_hash IS NULL OR payment_error=ANY($3::text[]))`,
    [receiver, scanGraceSeconds, replaceableErrors],
  )
  // Idle: no RPC traffic. The next invoice restarts the scan from its creation time.
  if (!invoices.length) return { scanned: 0, found: 0 }
  const lease = randomUUID()
  await query(
    'INSERT INTO payment_scan_state(chain_id) VALUES($1) ON CONFLICT(chain_id) DO NOTHING',
    [POLICY.chainId],
  )
  const [state] = await query(
    `UPDATE payment_scan_state SET lease_token=$2,locked_until=now()+interval '1 minute'
     WHERE chain_id=$1 AND (locked_until IS NULL OR locked_until<now())
     RETURNING last_block::text AS last_block,updated_at`,
    [POLICY.chainId, lease],
  )
  if (!state) return { scanned: 0, found: 0 }
  let cursor: bigint | null = state.last_block === null ? null : BigInt(state.last_block)
  let scanned = 0
  let found = 0
  try {
    if (quantity(await call('eth_chainId', [])) !== BigInt(POLICY.chainId))
      throw new Error('WRONG_CHAIN')
    const latest = quantity(await call('eth_blockNumber', []))
    const oldest = Math.min(...invoices.map((i) => new Date(i.created_at).getTime()))
    const stale = cursor === null || new Date(state.updated_at).getTime() < oldest - 60000
    const plan = planScan(cursor, latest, scanLookback + (now.getTime() - oldest) / 1000, stale)
    if (plan) {
      const numbers: bigint[] = []
      for (let n = plan.from; n <= plan.to; n++) numbers.push(n)
      const blocks = await Promise.all(
        numbers.map((n) => call('eth_getBlockByNumber', ['0x' + n.toString(16), true])),
      )
      for (const [index, block] of blocks.entries()) {
        // A block the node does not serve yet ends this cycle; the cursor stays before it.
        if (!block) break
        if (quantity(block.number) !== numbers[index]) throw new Error('BLOCK_MISMATCH')
        for (const match of matchTransfers(block, invoices, receiver))
          if (await attachDetectedPayment(match.orderId, match.hash, match.amountWei)) found++
        cursor = numbers[index]!
        scanned++
      }
    } else if (cursor === null || cursor > latest) cursor = latest
  } finally {
    await query(
      `UPDATE payment_scan_state SET last_block=$3,updated_at=now(),lease_token=null,
       locked_until=null WHERE chain_id=$1 AND lease_token=$2`,
      [POLICY.chainId, lease, cursor === null ? null : cursor.toString()],
    )
  }
  return { scanned, found }
}

async function expireInvoices() {
  const c = config()
  const grace = c.PAYMENT_MODE === 'sepolia' && c.SEPOLIA_SCAN_ENABLED ? scanGraceSeconds : 0
  await transaction(async (db) => {
    const expired = await query(
      `UPDATE orders SET status=CASE WHEN tx_hash IS NULL THEN 'expired' ELSE 'manual_review' END,
       payment_lease_token=null,payment_locked_until=null
       WHERE status='awaiting_payment' AND ((tx_hash IS NULL AND expires_at<now()-make_interval(
         secs=>CASE WHEN payment_mode='sepolia' THEN $1::int ELSE 0 END))
         OR expires_at<now()-interval '24 hours')
       RETURNING id,reservation_id,status`,
      [grace],
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
  // Scan first: a transfer mined just before expiry gets its hash before the invoice closes.
  try {
    await scanPayments(call)
  } catch {
    console.error('PAYMENT_SCAN_FAILED')
  }
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
        // RPC stays outside the lock; confirming a payment is atomic with OPEN_OBLIGATIONS.
        await query('SELECT id FROM system_state WHERE id=true FOR UPDATE', [], db)
        const [current] = await query(
          `SELECT * FROM orders WHERE id=$1 AND tx_hash=$2 AND payment_lease_token=$3
         AND payment_locked_until>clock_timestamp() AND status='awaiting_payment' FOR UPDATE`,
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
