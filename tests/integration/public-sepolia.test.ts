import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// This file runs the public site in Sepolia mode against an in-memory chain (no network).
vi.hoisted(() => {
  process.env.PAYMENT_MODE = 'sepolia'
  process.env.SEPOLIA_RECEIVER = '0x' + 'c'.repeat(40)
  process.env.SEPOLIA_RPC_URL = 'https://sepolia.invalid'
  process.env.SEPOLIA_CONFIRMATIONS = '3'
})

import { pool, query } from '../../core/db'
import * as settings from '../../core/config'
import { createPublicOrder } from '../../core/orders'
import {
  reconcilePayments,
  scanGraceSeconds,
  scanPayments,
  scanStep,
  submitTransaction,
} from '../../core/payments'
import { payPublicOrder, publicOrderView } from '../../core/public-orders'
import { formatEth } from '../../core/storefront'
import { mockChain } from '../fixtures/chain'
import { applyMigrations, resetDatabase } from './helpers/db'
import { fulfillNext, publishProducts } from './helpers/public'

const receiver = '0x' + 'c'.repeat(40)
const input =
  'Блокнот «Линия». Формат А5, 80 листов в точку, бумага 100 г/м². Обложка из картона. Цвет серый.'

beforeAll(applyMigrations)
beforeEach(async () => {
  await resetDatabase()
  await publishProducts(['description'])
})
afterAll(async () => {
  await pool.end()
})

async function newOrder() {
  const created = await createPublicOrder({
    slug: 'description',
    input,
    requestKey: randomUUID(),
    clientKey: randomUUID(),
  })
  const view = await publicOrderView(created.token)
  if (view.payment.mode !== 'sepolia') throw new Error('expected sepolia')
  return { ...created, view, payment: view.payment, wei: BigInt(view.payment.amountWei) }
}
/** Lets the next reconcile cycle verify again instead of waiting 30 seconds. */
const recheck = () => query('UPDATE orders SET last_payment_check=null')

describe('public Sepolia payment on a mocked chain', () => {
  it('shows the invoice in rubles and exact test ETH with a wallet link', async () => {
    const { view, payment, wei } = await newOrder()
    expect(view.price).toEqual({ kopecks: 49000, currency: 'RUB', test: true })
    expect(wei / 10n ** 12n).toBe(1633n)
    expect(payment).toMatchObject({
      chainId: 11155111,
      receiver,
      amountEth: formatEth(wei),
      paymentUri: `ethereum:${receiver}@11155111?value=${wei}`,
      hash: null,
      canSubmit: true,
      network: 'sepolia',
      detectedAutomatically: false,
    })
    expect(view.message.title).toBe('Ждём перевод')
  })

  it('finds a transfer without a hash, waits for confirmations, then starts the work', async () => {
    const chain = mockChain()
    const { id, token, wei } = await newOrder()
    chain.mine()
    const hash = chain.transfer(receiver, wei)
    await reconcilePayments(chain.rpc)
    let view = await publicOrderView(token)
    expect(view.status).toBe('checking_payment')
    expect(view.message.title).toBe('Перевод найден, ждём подтверждений 1 из 3')
    expect(view.payment).toMatchObject({ hash, confirmations: 1, detectedAutomatically: true })
    const [attempt] = await query('SELECT * FROM payment_attempts WHERE tx_hash=$1', [hash])
    expect(attempt).toMatchObject({ order_id: id, detected_by_scan: true })

    chain.mine()
    chain.mine()
    await recheck()
    await reconcilePayments(chain.rpc)
    view = await publicOrderView(token)
    expect(view.status).toBe('in_progress')
    const [row] = await query('SELECT * FROM orders WHERE id=$1', [id])
    expect(row).toMatchObject({
      status: 'paid',
      tx_hash: hash,
      is_test_payment: true,
      revenue_kopecks: 0,
    })
    expect(row!.payment_proof).toMatchObject({ hash, amountWei: wei.toString(), confirmations: 3 })
    const [cursor] = await query('SELECT last_block::text AS n FROM payment_scan_state')
    // Once the transfer is pinned no invoice waits, so the scan stops at the block it read.
    expect(BigInt(cursor!.n)).toBe(101n)
    expect(await fulfillNext()).toBe(true)
    expect((await publicOrderView(token)).status).toBe('delivered')
    expect(
      (await query("SELECT kind FROM audit_events WHERE kind='payment_detected'")).length,
    ).toBe(1)
  })

  it('ignores near misses: other amounts, other receivers and contract calls', async () => {
    const chain = mockChain()
    const { id, wei } = await newOrder()
    chain.mine()
    chain.transfer(receiver, wei + 1n)
    chain.transfer(receiver, wei - 1n)
    chain.transfer('0x' + 'd'.repeat(40), wei)
    chain.transfer(receiver, wei, { input: '0xa9059cbb' })
    chain.transfer(receiver, wei, { status: '0x0' })
    await reconcilePayments(chain.rpc)
    const [row] = await query('SELECT * FROM orders WHERE id=$1', [id])
    // The reverted transfer matches by amount and is pinned, but verification rejects it.
    expect(row!.status).toBe('awaiting_payment')
    expect(row!.payment_error).toBe('TX_REVERTED')
    // A later good transfer replaces the rejected one.
    const good = chain.transfer(receiver, wei)
    chain.mine()
    chain.mine()
    await recheck()
    await reconcilePayments(chain.rpc)
    await recheck()
    await reconcilePayments(chain.rpc)
    expect((await query('SELECT status,tx_hash FROM orders WHERE id=$1', [id]))[0]).toEqual({
      status: 'paid',
      tx_hash: good,
    })
  })

  it('accepts a buyer hash, refuses a wrong one before pinning it, and one hash pays one order', async () => {
    const chain = mockChain()
    const first = await newOrder()
    const second = await newOrder()
    const wrong = chain.transfer(receiver, first.wei + 5n)
    await expect(
      payPublicOrder(first.token, { mode: 'sepolia', hash: wrong }, chain.rpc),
    ).rejects.toThrow('WRONG_AMOUNT')
    expect(await query('SELECT * FROM payment_attempts')).toEqual([])
    await expect(payPublicOrder(first.token, { mode: 'sandbox' }, chain.rpc)).rejects.toThrow(
      'PAYMENT_MODE_MISMATCH',
    )

    const paid = chain.transfer(receiver, first.wei)
    await payPublicOrder(first.token, { mode: 'sepolia', hash: paid }, chain.rpc)
    await expect(
      payPublicOrder(second.token, { mode: 'sepolia', hash: paid }, chain.rpc),
    ).rejects.toThrow('WRONG_AMOUNT')
    await expect(submitTransaction(second.id, paid)).rejects.toThrow('TX_ALREADY_USED')
    chain.mine()
    chain.mine()
    await reconcilePayments(chain.rpc)
    const view = await publicOrderView(first.token)
    expect(view.status).toBe('in_progress')
    expect(view.payment).toMatchObject({ hash: paid, detectedAutomatically: false })
    expect((await publicOrderView(second.token)).status).toBe('awaiting_payment')
  })

  it('reads at most one step of blocks per cycle and never skips an unreadable block', async () => {
    const chain = mockChain(1000n)
    for (let i = 0; i < 40; i++) chain.mine()
    const { wei } = await newOrder()
    const first = await scanPayments(chain.rpc)
    expect(first.scanned).toBeLessThanOrEqual(scanStep)
    const before = (await query('SELECT last_block::text AS n FROM payment_scan_state'))[0]!.n
    chain.mine()
    chain.transfer(receiver, wei)
    chain.fail.eth_getBlockByNumber = () => ({ number: '0x1', timestamp: '0x1' })
    await expect(scanPayments(chain.rpc)).rejects.toThrow()
    expect(
      (await query('SELECT last_block::text AS n, lease_token FROM payment_scan_state'))[0],
    ).toEqual({
      n: before,
      lease_token: null,
    })
    delete chain.fail.eth_getBlockByNumber
    let found = 0
    for (let i = 0; i < 6 && !found; i++) found += (await scanPayments(chain.rpc)).found
    expect(found).toBe(1)
  })

  it('stays idle without open invoices and expires unpaid ones after the scan grace', async () => {
    const chain = mockChain()
    expect(await scanPayments(chain.rpc)).toEqual({ scanned: 0, found: 0 })
    expect(chain.calls).toEqual([])
    const { id, token } = await newOrder()
    await query(
      `UPDATE orders SET created_at=now()-interval '2 hours',
       expires_at=now()-make_interval(secs=>$2) WHERE id=$1`,
      [id, scanGraceSeconds - 60],
    )
    await reconcilePayments(chain.rpc)
    expect((await query('SELECT status FROM orders WHERE id=$1', [id]))[0]!.status).toBe(
      'awaiting_payment',
    )
    await expect(
      payPublicOrder(token, { mode: 'sepolia', hash: '0x' + '1'.repeat(64) }, chain.rpc),
    ).rejects.toThrow('ORDER_NOT_PAYABLE')
    await query(`UPDATE orders SET expires_at=now()-interval '10 minutes' WHERE id=$1`, [id])
    await reconcilePayments(chain.rpc)
    expect((await publicOrderView(token)).status).toBe('expired')
  })

  it('gives a hijacked transfer to the order with the exact amount: scanner path', async () => {
    const chain = mockChain()
    const victim = await newOrder()
    const attacker = await newOrder()
    // The attacker sees the victim's transfer in the mempool and pins its hash first, before
    // the farm's node knows it.
    const hash = chain.txHash()
    await payPublicOrder(attacker.token, { mode: 'sepolia', hash }, chain.rpc)
    expect((await query('SELECT order_id FROM payment_attempts'))[0]!.order_id).toBe(attacker.id)
    chain.mine([{ hash, to: receiver, value: victim.wei, input: '0x', status: '0x1' }])
    await reconcilePayments(chain.rpc)
    expect((await query('SELECT order_id FROM payment_attempts'))[0]!.order_id).toBe(victim.id)
    expect(
      (await query('SELECT tx_hash,payment_error FROM orders WHERE id=$1', [attacker.id]))[0],
    ).toEqual({ tx_hash: null, payment_error: null })
    chain.mine()
    chain.mine()
    await recheck()
    await reconcilePayments(chain.rpc)
    expect((await publicOrderView(victim.token)).status).toBe('in_progress')
    expect((await publicOrderView(attacker.token)).status).toBe('awaiting_payment')
    expect(
      (await query("SELECT data FROM audit_events WHERE kind='payment_attempt_moved'"))[0]!.data,
    ).toMatchObject({ orderId: victim.id, fromOrderId: attacker.id, hash })
  })

  it('gives a hijacked transfer to the order with the exact amount: buyer hash path', async () => {
    const chain = mockChain()
    const victim = await newOrder()
    const attacker = await newOrder()
    const hash = chain.txHash()
    await payPublicOrder(attacker.token, { mode: 'sepolia', hash }, chain.rpc)
    chain.mine([{ hash, to: receiver, value: victim.wei, input: '0x', status: '0x1' }])
    // The attacker cannot take it back by repeating the claim: the node shows another amount.
    await payPublicOrder(victim.token, { mode: 'sepolia', hash }, chain.rpc)
    await expect(
      payPublicOrder(attacker.token, { mode: 'sepolia', hash }, chain.rpc),
    ).rejects.toThrow('WRONG_AMOUNT')
    chain.mine()
    chain.mine()
    await reconcilePayments(chain.rpc)
    expect((await query('SELECT status,tx_hash FROM orders WHERE id=$1', [victim.id]))[0]).toEqual({
      status: 'paid',
      tx_hash: hash,
    })
  })

  it('releases a hash its order already rejected, and never moves a confirmed payment', async () => {
    const chain = mockChain()
    const first = await newOrder()
    const second = await newOrder()
    const paid = chain.transfer(receiver, first.wei)
    // Without the scanner (it would hand the hash over at once) the wrong order holds it via the
    // owner path, which has no precheck, and its own check rejects it.
    const real = settings.config()
    vi.spyOn(settings, 'config').mockReturnValue({ ...real, SEPOLIA_SCAN_ENABLED: false })
    await submitTransaction(second.id, paid)
    await reconcilePayments(chain.rpc)
    expect(
      (await query('SELECT payment_error FROM orders WHERE id=$1', [second.id]))[0]!.payment_error,
    ).toBe('WRONG_AMOUNT')
    // Even without a proof, the rejected hash is free for another order now.
    await submitTransaction(first.id, paid)
    chain.mine()
    chain.mine()
    await recheck()
    await reconcilePayments(chain.rpc)
    expect((await query('SELECT status FROM orders WHERE id=$1', [first.id]))[0]!.status).toBe(
      'paid',
    )
    const third = await newOrder()
    await expect(submitTransaction(third.id, paid)).rejects.toThrow('TX_ALREADY_USED')
    expect((await query('SELECT order_id FROM payment_attempts'))[0]!.order_id).toBe(first.id)
    vi.restoreAllMocks()
  })

  it('sends an unresolved hash conflict to the owner instead of expiring it', async () => {
    const chain = mockChain()
    const first = await newOrder()
    const second = await newOrder()
    const hash = chain.transfer(receiver, first.wei)
    await payPublicOrder(first.token, { mode: 'sepolia', hash }, chain.rpc)
    await expect(submitTransaction(second.id, hash)).rejects.toThrow('TX_ALREADY_USED')
    await query(
      `UPDATE orders SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'
       WHERE id=$1`,
      [second.id],
    )
    await reconcilePayments(chain.rpc)
    const view = await publicOrderView(second.token)
    expect(view.status).toBe('needs_attention')
    expect(view.message.detail).toBe(
      'Этот перевод указали и в другом заказе. Владелец разберётся сам.',
    )
  })

  it('closes an invoice whose hash never appeared on the node an hour after it ended', async () => {
    const chain = mockChain()
    const { id, token } = await newOrder()
    const random = '0x' + 'ab'.repeat(32)
    await payPublicOrder(token, { mode: 'sepolia', hash: random }, chain.rpc)
    await query(
      `UPDATE orders SET created_at=now()-interval '3 hours',expires_at=now()-interval '30 minutes'
       WHERE id=$1`,
      [id],
    )
    await reconcilePayments(chain.rpc)
    await reconcilePayments(chain.rpc)
    // Half an hour after the deadline the hash is still checked.
    expect((await query('SELECT status FROM orders WHERE id=$1', [id]))[0]!.status).toBe(
      'awaiting_payment',
    )
    await query(`UPDATE orders SET expires_at=now()-interval '2 hours' WHERE id=$1`, [id])
    await query(`UPDATE payment_attempts SET checked_at=now() WHERE order_id=$1`, [id])
    await reconcilePayments(chain.rpc)
    expect((await publicOrderView(token)).status).toBe('expired')
    // A hash the node did show (a real transfer) still gets the full day and goes to the owner.
    const other = await newOrder()
    const late = chain.transfer(receiver, other.wei)
    await payPublicOrder(other.token, { mode: 'sepolia', hash: late }, chain.rpc)
    await query(
      `UPDATE orders SET created_at=now()-interval '4 hours',expires_at=now()-interval '3 hours'
       WHERE id=$1`,
      [other.id],
    )
    await reconcilePayments(chain.rpc)
    await recheck()
    await reconcilePayments(chain.rpc)
    expect(
      (await query('SELECT status,payment_error FROM orders WHERE id=$1', [other.id]))[0],
    ).toEqual({ status: 'awaiting_payment', payment_error: 'TX_OUTSIDE_INVOICE_WINDOW' })
  })

  it('replaces a hash the node never showed with the exact transfer the scanner finds', async () => {
    const chain = mockChain()
    const { id, token, wei } = await newOrder()
    // A typo: a well-formed hash that does not exist on the node.
    const typo = '0x' + '7'.repeat(64)
    await payPublicOrder(token, { mode: 'sepolia', hash: typo }, chain.rpc)
    await reconcilePayments(chain.rpc)
    expect((await query('SELECT tx_hash FROM orders WHERE id=$1', [id]))[0]!.tx_hash).toBe(typo)
    const real = chain.transfer(receiver, wei)
    await reconcilePayments(chain.rpc)
    expect((await query('SELECT tx_hash,payment_error FROM orders WHERE id=$1', [id]))[0]).toEqual({
      tx_hash: real,
      payment_error: null,
    })
    expect(
      (await query("SELECT data FROM audit_events WHERE kind='payment_hash_replaced'"))[0]!.data,
    ).toMatchObject({ orderId: id, hash: real, replacedHash: typo })
    // The buyer's typo cannot take the slot back from the transfer the node showed.
    await payPublicOrder(token, { mode: 'sepolia', hash: typo }, chain.rpc)
    expect((await query('SELECT tx_hash FROM orders WHERE id=$1', [id]))[0]!.tx_hash).toBe(real)
    chain.mine()
    chain.mine()
    await recheck()
    await reconcilePayments(chain.rpc)
    expect((await publicOrderView(token)).status).toBe('in_progress')
  })

  it('never replaces a transfer the node already showed', async () => {
    const chain = mockChain()
    const { id, token, wei } = await newOrder()
    const paid = chain.transfer(receiver, wei)
    await payPublicOrder(token, { mode: 'sepolia', hash: paid }, chain.rpc)
    await reconcilePayments(chain.rpc)
    // A second transfer of the same amount (a double payment) does not move the pinned one.
    chain.transfer(receiver, wei)
    await reconcilePayments(chain.rpc)
    expect((await query('SELECT tx_hash FROM orders WHERE id=$1', [id]))[0]!.tx_hash).toBe(paid)
    expect(await query("SELECT id FROM audit_events WHERE kind='payment_hash_replaced'")).toEqual(
      [],
    )
  })

  it('reports a transfer after the invoice ended to the owner and never starts the work', async () => {
    const chain = mockChain(5000n)
    const { id, token, wei } = await newOrder()
    await query(
      `UPDATE orders SET created_at=now()-interval '40 minutes',expires_at=now()-interval '10 minutes'
       WHERE id=$1`,
      [id],
    )
    await reconcilePayments(chain.rpc)
    expect((await publicOrderView(token)).status).toBe('expired')
    const hash = chain.transfer(receiver, wei)
    // The scan catches up from the deadline, one step of blocks per cycle.
    for (let i = 0; i < 80; i++) {
      await reconcilePayments(chain.rpc)
      if ((await query('SELECT status FROM orders WHERE id=$1', [id]))[0]!.status !== 'expired')
        break
    }
    const [row] = await query('SELECT * FROM orders WHERE id=$1', [id])
    expect(row).toMatchObject({
      status: 'manual_review',
      payment_error: 'PAID_AFTER_EXPIRY',
      tx_hash: hash,
      paid_at: null,
      revenue_kopecks: 0,
    })
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toEqual([])
    const [event] = await query(
      "SELECT message,data FROM audit_events WHERE kind='late_payment_received'",
    )
    expect(event!.message).toContain('верните перевод вручную')
    expect(event!.data).toMatchObject({ orderId: id, hash, previousStatus: 'expired' })
    // Reported once; later cycles leave it with the owner.
    chain.mine()
    await reconcilePayments(chain.rpc)
    expect(
      (await query("SELECT id FROM audit_events WHERE kind='late_payment_received'")).length,
    ).toBe(1)
    expect((await publicOrderView(token)).status).toBe('needs_attention')
  })

  it('re-reads a mined transfer every few seconds and an unseen hash every 30 seconds', async () => {
    const chain = mockChain()
    const mined = await newOrder()
    chain.transfer(receiver, mined.wei)
    await reconcilePayments(chain.rpc)
    const unseen = await newOrder()
    await payPublicOrder(unseen.token, { mode: 'sepolia', hash: '0x' + '5'.repeat(64) }, chain.rpc)
    await reconcilePayments(chain.rpc)
    await query("UPDATE orders SET last_payment_check=now()-interval '6 seconds'")
    chain.mine()
    await reconcilePayments(chain.rpc)
    const checked = await query(
      "SELECT id,confirmations FROM orders WHERE last_payment_check>now()-interval '2 seconds'",
    )
    expect(checked).toEqual([{ id: mined.id, confirmations: 2 }])
  })
})
