import { createHash, createHmac, randomBytes } from 'node:crypto'
import { config } from './config'
import { audit, query, transaction } from './db'
import type { PublicOrderView, PublicPayRequest } from './contracts/public'
import { publicProgress } from './order-progress'
import { precheckTransfer, rpc, sandboxPayment, submitTransaction, type Rpc } from './payments'
import { buyerCopy } from './public-catalog'
import { recordTokenMiss } from './rate-limit'
import { formatEth, kopecksToWei, sepoliaChainId, sepoliaPaymentUri } from './storefront'
import type { ServiceTemplate } from './service-catalog'

/** 32 random or HMAC bytes in base64url: exactly 43 characters. */
export const orderTokenPattern = /^[A-Za-z0-9_-]{43}$/

/**
 * The secret link of a public order. It is derived from the buyer's random `requestKey` with the
 * server secret, so a retried request gets the same link back, while the database keeps only
 * its sha256. Owner rotation replaces it with a random token.
 */
export function deriveOrderToken(requestKey: string, secret = config().SESSION_SECRET) {
  return createHmac('sha256', secret).update(`order-link:v1:${requestKey}`).digest('base64url')
}
export function randomOrderToken() {
  return randomBytes(32).toString('base64url')
}
export function orderTokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/** Price rounded down to 0.000001 test ETH plus the unique invoice part (sequence < 10^12). */
const uniqueSpan = 10n ** 12n
export function invoiceWei(priceKopecks: number, rubPerEth: number, sequence: bigint) {
  if (sequence <= 0n || sequence >= uniqueSpan) throw new Error('INVOICE_SEQUENCE_EXHAUSTED')
  const base = (kopecksToWei(priceKopecks, rubPerEth) / uniqueSpan) * uniqueSpan
  return (base > 0n ? base : uniqueSpan) + sequence
}

/** Short reference a buyer can read out loud. Not a secret and not a sequence number. */
export function orderNumber(id: string) {
  return id.replace(/-/g, '').slice(0, 6).toUpperCase()
}

export function orderUrl(token: string) {
  return `/order/${token}`
}

/** Unknown, malformed and rotated links all end here with the same 404. */
async function findByToken(token: string) {
  const order =
    typeof token === 'string' && orderTokenPattern.test(token)
      ? (
          await query(
            `SELECT o.*,p.slug,p.template FROM orders o JOIN products p ON p.id=o.product_id
             WHERE o.access_token_hash=$1 AND o.source='public'`,
            [orderTokenHash(token)],
          )
        )[0]
      : undefined
  if (!order) {
    await recordTokenMiss()
    throw new Error('ORDER_NOT_FOUND')
  }
  return order
}

function preview(input: string) {
  const lines = input.split('\n').filter((line) => line.trim())
  const text = lines.slice(0, 2).join('\n')
  return text.length > 240 ? text.slice(0, 239) + '…' : text
}

export async function publicOrderView(token: string, now = new Date()): Promise<PublicOrderView> {
  const order = await findByToken(token)
  const c = config()
  const [jobs, states, attempts] = await Promise.all([
    query('SELECT id,status,attempts,run_after FROM jobs WHERE dedupe_key=$1', [
      `fulfill:${order.id}`,
    ]),
    query('SELECT mode,worker_heartbeat FROM system_state WHERE id=true'),
    order.tx_hash
      ? query('SELECT detected_by_scan FROM payment_attempts WHERE tx_hash=$1 AND order_id=$2', [
          order.tx_hash,
          order.id,
        ])
      : Promise.resolve([]),
  ])
  const job = jobs[0] || null
  const generated = job
    ? (
        await query(
          `SELECT finished_at FROM tool_calls WHERE job_id=$1 AND role='Исполнитель' AND status='done'
           ORDER BY created_at LIMIT 1`,
          [job.id],
        )
      )[0]?.finished_at || null
    : null
  const progress = publicProgress(order, job, generated, states[0] || {}, now)
  const open = order.status === 'awaiting_payment' && new Date(order.expires_at) > now
  const copy = buyerCopy[order.template as ServiceTemplate]
  const local = c.SEPOLIA_LOCAL_NODE
  const amountWei = String(order.amount_wei)
  return {
    id: order.id,
    status: progress.status,
    service: {
      slug: order.slug,
      name: copy?.name || order.product_snapshot.name,
      promise: copy?.promise || order.product_snapshot.promise,
      version: order.product_snapshot.version,
    },
    price: { kopecks: order.price_kopecks, currency: 'RUB', test: true },
    payment:
      order.payment_mode === 'sepolia'
        ? {
            mode: 'sepolia',
            chainId: sepoliaChainId,
            receiver: order.receiver,
            amountWei,
            amountEth: formatEth(amountWei),
            paymentUri: sepoliaPaymentUri(order.receiver, amountWei),
            hash: order.tx_hash,
            confirmations: order.confirmations,
            required: order.required_confirmations,
            canSubmit: open,
            detectedAutomatically: !!attempts[0]?.detected_by_scan,
            network: local ? 'local' : 'sepolia',
            explorerUrl:
              order.tx_hash && !local ? `https://sepolia.etherscan.io/tx/${order.tx_hash}` : null,
          }
        : { mode: 'sandbox', canConfirm: open && c.PAYMENT_MODE === 'sandbox' },
    steps: progress.steps,
    message: progress.message,
    result:
      order.status === 'delivered' && order.result
        ? { text: order.result, downloadUrl: `/api/public/orders/${token}/result.txt` }
        : null,
    createdAt: new Date(order.created_at).toISOString(),
    expiresAt: new Date(order.expires_at).toISOString(),
    contact: c.PUBLIC_CONTACT || null,
    inputPreview: preview(order.input),
  }
}

/**
 * Buyer payment: the sandbox button, or the hash of a Sepolia transfer from the buyer's wallet.
 * The server never signs anything; a hash is only checked and kept for reconciliation.
 */
export async function payPublicOrder(token: string, request: PublicPayRequest, call: Rpc = rpc) {
  const order = await findByToken(token)
  if (request.mode !== order.payment_mode) throw new Error('PAYMENT_MODE_MISMATCH')
  if (request.mode === 'sandbox') {
    await sandboxPayment(order.id)
    return { ok: true as const }
  }
  if (order.status !== 'awaiting_payment' || new Date(order.expires_at) <= new Date())
    throw new Error('ORDER_NOT_PAYABLE')
  const hash = request.hash.toLowerCase()
  if (order.tx_hash !== hash)
    await precheckTransfer(
      {
        receiver: order.receiver,
        amount_wei: String(order.amount_wei),
        created_at: order.created_at,
        expires_at: order.expires_at,
      },
      hash,
      call,
    )
  await submitTransaction(order.id, hash)
  return { ok: true as const }
}

export async function publicResultText(token: string) {
  const order = await findByToken(token)
  if (order.status !== 'delivered' || !order.result) throw new Error('RESULT_NOT_FOUND')
  return { filename: `order-${orderNumber(order.id)}.txt`, text: order.result as string }
}

/** Owner action: the old link stops working at once; the new token is shown once. */
export async function rotateOrderToken(orderId: string) {
  const token = randomOrderToken()
  await transaction(async (db) => {
    const [order] = await query(
      `UPDATE orders SET access_token_hash=$2,token_rotated_at=now()
       WHERE id=$1 AND source='public' RETURNING id`,
      [orderId, orderTokenHash(token)],
      db,
    )
    if (!order) throw new Error('ORDER_NOT_FOUND')
    await audit(
      'public_order_link_replaced',
      'Владелец заменил ссылку заказа. Старая ссылка больше не открывается.',
      { orderId },
      db,
    )
  })
  return { token, url: orderUrl(token) }
}
