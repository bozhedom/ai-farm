import { randomUUID } from 'node:crypto'
import { config } from './config'
import { audit, query, transaction, type Connection } from './db'
import { closeReservation, fundOrderReservation } from './budget'
import { enqueue } from './queue'
import { POLICY } from './policy'
import { publicDayCounts } from './public-catalog'

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

/** Why a paid public order may not start today, or null when it may. */
export const capacityErrors: readonly string[] = Object.freeze([
  'PAID_ORDERS_LIMIT',
  'BUDGET_BLOCKED',
])

/**
 * A public order holds no model budget until it is paid. Here, under the caller's system_state
 * lock, it gets its reservation, within the daily cap of paid public orders.
 */
async function admitPublicOrder(db: Connection, order: Record<string, any>) {
  if (order.source !== 'public') return null
  if ((await publicDayCounts(db)).paid >= config().PUBLIC_PAID_ORDERS_PER_DAY)
    return 'PAID_ORDERS_LIMIT'
  try {
    await fundOrderReservation(order.reservation_id, db)
  } catch (error) {
    if (error instanceof Error && error.message === 'BUDGET_BLOCKED') return 'BUDGET_BLOCKED'
    throw error
  }
  return null
}

// Only called with a locked, payable order after sandbox validation or RPC verification.
async function confirmPayment(
  db: Connection,
  order: Record<string, any>,
  hash: string,
  confirmations: number,
  proof: PaymentProof | null,
  options: { refuseWhenFull?: boolean } = {},
) {
  const blocked = await admitPublicOrder(db, order)
  if (blocked && options.refuseWhenFull) throw new Error('PUBLIC_CAPACITY_REACHED')
  if (blocked) {
    // The transfer is real (in test ETH), so the order is paid, but the work does not start.
    const [held] = await query(
      `UPDATE orders SET status='manual_review',paid_at=now(),tx_hash=$2,confirmations=$3,
       payment_error=$4,payment_proof=$5,payment_lease_token=null,payment_locked_until=null
       WHERE id=$1 RETURNING *`,
      [order.id, hash, confirmations, blocked, proof],
      db,
    )
    await closeReservation(order.reservation_id, db)
    await audit(
      'public_order_held',
      blocked === 'BUDGET_BLOCKED'
        ? 'Тестовая оплата подтверждена, но бюджета модели на этот заказ нет. Заказ ждёт владельца.'
        : 'Тестовая оплата подтверждена, но дневной предел оплаченных заказов исчерпан. Заказ ждёт владельца.',
      { orderId: order.id, reason: blocked },
      db,
    )
    return held
  }
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

/**
 * Confirms a sandbox payment. `refuseWhenFull` (the buyer's own button) refuses a public order
 * that cannot start today instead of taking it and holding it for the owner.
 */
export async function sandboxPayment(id: string, options: { refuseWhenFull?: boolean } = {}) {
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
    return confirmPayment(db, order, `sandbox:${id}`, 0, null, options)
  })
}

/**
 * Pins `hash` to a locked order: one hash, one order. A hash already pinned elsewhere moves to
 * this order only when the other order provably cannot be paid by it: either this claim proved
 * the transfer's exact amount is this invoice's (`proven`; amounts are unique per invoice), or
 * the other order's own check already rejected it. A confirmed payment never moves. This keeps
 * someone who pins a victim's hash first from holding the victim's transfer hostage.
 */
async function claimAttempt(
  db: Connection,
  order: Record<string, any>,
  hash: string,
  how: { proven: boolean; byScan: boolean },
) {
  const [mine] = await query(
    `INSERT INTO payment_attempts(tx_hash,order_id,detected_by_scan,seen_at)
     VALUES($1,$2,$3,CASE WHEN $3 THEN now() END) ON CONFLICT(tx_hash) DO NOTHING
     RETURNING order_id`,
    [hash, order.id, how.byScan],
    db,
  )
  if (mine) return true
  const [attempt] = await query(
    'SELECT * FROM payment_attempts WHERE tx_hash=$1 FOR UPDATE',
    [hash],
    db,
  )
  if (!attempt) return false
  if (attempt.order_id === order.id) return true
  const [holder] = await query(
    'SELECT id,status,tx_hash,amount_wei::text AS amount_wei FROM orders WHERE id=$1 FOR UPDATE',
    [attempt.order_id],
    db,
  )
  const unusable =
    !!holder &&
    attempt.confirmed_at === null &&
    !(holder.tx_hash === hash && holder.status !== 'awaiting_payment') &&
    ((how.proven && holder.amount_wei !== String(order.amount_wei)) ||
      replaceableErrors.includes(attempt.error_code))
  if (!unusable) return false
  await query(
    `UPDATE payment_attempts SET order_id=$2,detected_by_scan=$3,submitted_at=now(),checked_at=null,
     confirmations=0,error_code=null,proof=null,confirmed_at=null,
     seen_at=CASE WHEN $3 THEN now() ELSE seen_at END WHERE tx_hash=$1`,
    [hash, order.id, how.byScan],
    db,
  )
  if (holder.tx_hash === hash)
    await query(
      `UPDATE orders SET tx_hash=null,confirmations=0,payment_error=null,last_payment_check=null,
       payment_proof=null,payment_lease_token=null,payment_locked_until=null WHERE id=$1`,
      [holder.id],
      db,
    )
  await audit(
    'payment_attempt_moved',
    'Хеш тестового перевода передан заказу с точной суммой: прежнему заказу он не подходит.',
    { orderId: order.id, fromOrderId: holder.id, hash },
    db,
  )
  return true
}

/**
 * A buyer's or the owner's hash for an open Sepolia invoice. `proven`: the caller already saw
 * this transaction on the node with this invoice's receiver and exact amount.
 */
export async function submitTransaction(id: string, hash: string, proven = false) {
  if (!hashPattern.test(hash)) throw new Error('INVALID_TX_HASH')
  hash = hash.toLowerCase()
  const refused = await transaction(async (db) => {
    const [order] = await query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id], db)
    if (
      !order ||
      order.payment_mode !== 'sepolia' ||
      order.status !== 'awaiting_payment' ||
      new Date(order.expires_at) <= new Date()
    )
      throw new Error('ORDER_NOT_PAYABLE')
    if (!(await claimAttempt(db, order, hash, { proven, byScan: false }))) {
      // Remember the conflict: such an invoice goes to the owner instead of silently expiring.
      await query(
        "UPDATE orders SET payment_error='TX_ALREADY_USED' WHERE id=$1 AND tx_hash IS NULL",
        [id],
        db,
      )
      return 'TX_ALREADY_USED'
    }
    if (order.tx_hash === hash) return null
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
    return null
  })
  if (refused) throw new Error(refused)
}

const sameAddress = (a: unknown, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/**
 * Cheap check before a buyer's hash is pinned to an order. A transaction the node already knows
 * must go to this invoice's receiver with its exact amount; otherwise the hash is refused.
 * Returns true when the node showed exactly that: such a claim wins over an earlier order that
 * pinned the same hash (see `claimAttempt`). Unknown or unreadable transactions return false and
 * are pinned only until a proven claim or the order's own check says otherwise; full
 * verification happens in `reconcilePayments`.
 */
export async function precheckTransfer(invoice: Invoice, hash: string, call: Rpc = rpc) {
  if (!hashPattern.test(hash)) throw new Error('INVALID_TX_HASH')
  let tx: any
  try {
    tx = await call('eth_getTransactionByHash', [hash])
  } catch {
    return false
  }
  if (!tx || typeof tx !== 'object') return false
  if (typeof tx.hash === 'string' && tx.hash.toLowerCase() !== hash.toLowerCase()) return false
  if (!sameAddress(tx.to, invoice.receiver)) throw new Error('WRONG_RECEIVER')
  let value: bigint
  try {
    value = quantity(tx.value)
  } catch {
    return false
  }
  if (value !== BigInt(invoice.amount_wei)) throw new Error('WRONG_AMOUNT')
  if (typeof tx.input === 'string' && tx.input !== '0x')
    throw new Error('ONLY_NATIVE_TRANSFER_ALLOWED')
  return typeof tx.hash === 'string' && tx.input === '0x'
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

/**
 * Pins a scanned transfer to its invoice with the same one-hash-one-order rule as buyers. The
 * block showed the exact amount, so the claim is proven: a hash pinned earlier to another order
 * moves here.
 */
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
    order.amount_wei = String(order.amount_wei)
    if (!(await claimAttempt(db, order, hash, { proven: true, byScan: true }))) {
      await query(
        "UPDATE orders SET payment_error='TX_ALREADY_USED' WHERE id=$1 AND tx_hash IS NULL",
        [orderId],
        db,
      )
      return false
    }
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

/** A hash the node has never shown, though it answered after the invoice ended. */
export const unseenHashSeconds = 3600

async function expireInvoices() {
  const c = config()
  const grace = c.PAYMENT_MODE === 'sepolia' && c.SEPOLIA_SCAN_ENABLED ? scanGraceSeconds : 0
  await transaction(async (db) => {
    // Unpaid invoices expire. A hash pinned elsewhere (TX_ALREADY_USED) goes to the owner. A
    // pinned hash is checked a day longer, unless the node still had never seen it an hour
    // after the deadline: such a transfer cannot have been mined inside the invoice window.
    const expired = await query(
      `WITH due AS (
         SELECT o.id,o.tx_hash,o.payment_error,o.expires_at,EXISTS(
           SELECT 1 FROM payment_attempts a WHERE a.tx_hash=o.tx_hash AND a.order_id=o.id
           AND a.seen_at IS NULL AND a.error_code IS NULL AND a.checked_at>o.expires_at) AS unseen
         FROM orders o WHERE o.status='awaiting_payment' AND o.expires_at<now())
       UPDATE orders SET status=CASE
         WHEN due.tx_hash IS NULL AND due.payment_error IS DISTINCT FROM 'TX_ALREADY_USED'
           THEN 'expired'
         WHEN due.tx_hash IS NOT NULL AND due.unseen THEN 'expired'
         ELSE 'manual_review' END,
       payment_lease_token=null,payment_locked_until=null
       FROM due WHERE orders.id=due.id AND orders.status='awaiting_payment'
       AND orders.tx_hash IS NOT DISTINCT FROM due.tx_hash
       AND orders.payment_error IS NOT DISTINCT FROM due.payment_error AND (
         (due.tx_hash IS NULL AND orders.expires_at<now()-make_interval(
           secs=>CASE WHEN orders.payment_mode='sepolia' THEN $1::int ELSE 0 END))
         OR (due.tx_hash IS NOT NULL AND due.unseen
           AND orders.expires_at<now()-make_interval(secs=>$2::int))
         OR orders.expires_at<now()-interval '24 hours')
       RETURNING orders.id,orders.reservation_id,orders.status,due.tx_hash,due.payment_error`,
      [grace, unseenHashSeconds],
      db,
    )
    for (const order of expired) {
      await closeReservation(order.reservation_id, db)
      await audit(
        'invoice_expired',
        order.status === 'manual_review'
          ? order.payment_error === 'TX_ALREADY_USED' && !order.tx_hash
            ? 'Перевод на сумму счёта уже указан в другом заказе. Нужна проверка владельцем.'
            : 'Тестовый платёж требует проверки владельцем.'
          : order.tx_hash
            ? 'Указанный перевод так и не появился в сети. Срок счёта истёк; резерв освобождён.'
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
        // The node has shown this transaction: mined, or rejected for its content.
        const seen = !!result?.proof || (!!code && replaceableErrors.includes(code))
        await query(
          `UPDATE payment_attempts SET checked_at=now(),confirmations=$2,error_code=$3,proof=$4,
         confirmed_at=CASE WHEN $5 THEN now() ELSE confirmed_at END,
         seen_at=CASE WHEN $7 THEN COALESCE(seen_at,now()) ELSE seen_at END
         WHERE tx_hash=$1 AND order_id=$6`,
          [
            order.tx_hash,
            result?.confirmations ?? 0,
            code,
            result?.proof ?? null,
            result?.confirmed ?? false,
            order.id,
            seen,
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
