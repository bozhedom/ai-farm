import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Real transactions on a local anvil node started with --chain-id 11155111: signed by anvil's
 * unlocked test account, mined, and read back through the server's own JSON-RPC adapter.
 * This is a local test network, not public Sepolia. Run: npm run test:crypto
 */
const anvil = process.env.ANVIL_RPC_URL
// anvil test account 9; the server only knows the address, never a key.
const receiver = '0xa0ee7a142d267c1f36714e4a8f75612f20a79720'
vi.hoisted(() => {
  if (!process.env.ANVIL_RPC_URL) return
  process.env.PAYMENT_MODE = 'sepolia'
  process.env.SEPOLIA_RPC_URL = process.env.ANVIL_RPC_URL
  process.env.SEPOLIA_LOCAL_NODE = 'true'
  process.env.SEPOLIA_RECEIVER = '0xa0ee7a142d267c1f36714e4a8f75612f20a79720'
  process.env.SEPOLIA_CONFIRMATIONS = '3'
})

import { pool, query } from '../../core/db'
import { createPublicOrder } from '../../core/orders'
import { reconcilePayments, submitTransaction } from '../../core/payments'
import { payPublicOrder, publicOrderView } from '../../core/public-orders'
import { applyMigrations, resetDatabase } from './helpers/db'
import { fulfillNext, publishProducts } from './helpers/public'

const skipped =
  'crypto-anvil пропущен: ANVIL_RPC_URL не задан. Запустите npm run test:crypto (поднимет anvil в Docker).'
// The reporter hides console output of skipped files; write past it.
if (!anvil) process.stderr.write(`\n${skipped}\n`)

async function node(method: string, params: unknown[] = []) {
  const response = await fetch(anvil!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await response.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}
let sender = ''
/** eth_sendTransaction from anvil's unlocked account: the node signs with its test key. */
const send = (to: string, wei: bigint) =>
  node('eth_sendTransaction', [
    { from: sender, to, value: '0x' + wei.toString(16) },
  ]) as Promise<string>
const mine = (blocks: number) => node('anvil_mine', ['0x' + blocks.toString(16)])
const recheck = () => query('UPDATE orders SET last_payment_check=null')
/** Ended invoices are scanned from their deadline, one step of blocks per cycle. */
async function settleLate(id: string) {
  for (let i = 0; i < 40; i++) {
    await reconcilePayments()
    const [row] = await query('SELECT status FROM orders WHERE id=$1', [id])
    if (row!.status === 'manual_review') return
  }
}

async function newOrder() {
  const created = await createPublicOrder({
    slug: 'description',
    input:
      'Блокнот «Линия». Формат А5, 80 листов в точку, бумага 100 г/м². Обложка из картона. Цвет серый.',
    requestKey: randomUUID(),
    clientKey: randomUUID(),
  })
  const view = await publicOrderView(created.token)
  if (view.payment.mode !== 'sepolia') throw new Error('SEPOLIA_MODE_EXPECTED')
  return { ...created, wei: BigInt(view.payment.amountWei), view }
}

describe.skipIf(!anvil)('crypto on a local anvil node (ANVIL_RPC_URL, npm run test:crypto)', () => {
  beforeAll(async () => {
    expect(await node('eth_chainId')).toBe('0xaa36a7')
    expect(String(await node('web3_clientVersion')).toLowerCase()).toContain('anvil')
    sender = (await node('eth_accounts'))[0]
    await applyMigrations()
  })
  beforeEach(async () => {
    await resetDatabase()
    await publishProducts(['description'])
  })
  afterAll(async () => {
    await pool.end()
  })

  it('finds a real transfer without a hash and waits for three confirmations', async () => {
    const { id, token, wei, view } = await newOrder()
    expect(view.payment).toMatchObject({ network: 'local', receiver, explorerUrl: null })
    const hash = await send(receiver, wei)
    await reconcilePayments()
    let current = await publicOrderView(token)
    expect(current.message.title).toBe('Перевод найден, ждём подтверждений 1 из 3')
    expect(current.payment).toMatchObject({ hash, confirmations: 1, detectedAutomatically: true })

    await mine(1)
    await recheck()
    await reconcilePayments()
    current = await publicOrderView(token)
    expect(current.status).toBe('checking_payment')
    expect(current.message.title).toBe('Перевод найден, ждём подтверждений 2 из 3')

    await mine(1)
    await recheck()
    await reconcilePayments()
    const receipt = await node('eth_getTransactionReceipt', [hash])
    const [row] = await query('SELECT * FROM orders WHERE id=$1', [id])
    expect(row).toMatchObject({
      status: 'paid',
      tx_hash: hash,
      is_test_payment: true,
      revenue_kopecks: 0,
    })
    expect(row!.payment_proof).toMatchObject({
      chainId: 11155111,
      hash,
      receiver,
      amountWei: wei.toString(),
      blockHash: receipt.blockHash,
      confirmations: 3,
    })
    expect(await fulfillNext()).toBe(true)
    expect((await publicOrderView(token)).status).toBe('delivered')
  })

  it('confirms a hash the buyer sent from the wallet', async () => {
    const { token, wei } = await newOrder()
    const hash = await send(receiver, wei)
    await payPublicOrder(token, { mode: 'sepolia', hash })
    expect((await publicOrderView(token)).message.title).toBe('Перевод отправлен')
    await mine(2)
    await reconcilePayments()
    const view = await publicOrderView(token)
    expect(view.status).toBe('in_progress')
    expect(view.payment).toMatchObject({ hash, detectedAutomatically: false })
  })

  it('does not accept a wrong amount, and a later exact transfer still pays', async () => {
    const { id, token, wei } = await newOrder()
    const wrong = await send(receiver, wei + 1n)
    await expect(payPublicOrder(token, { mode: 'sepolia', hash: wrong })).rejects.toThrow(
      'WRONG_AMOUNT',
    )
    await mine(3)
    await reconcilePayments()
    expect((await query('SELECT status,tx_hash FROM orders WHERE id=$1', [id]))[0]).toEqual({
      status: 'awaiting_payment',
      tx_hash: null,
    })
    // Even when the wrong hash gets pinned (owner path, no precheck) verification refuses it.
    await submitTransaction(id, wrong)
    await reconcilePayments()
    expect(
      (await query('SELECT payment_error FROM orders WHERE id=$1', [id]))[0]!.payment_error,
    ).toBe('WRONG_AMOUNT')
    expect((await publicOrderView(token)).message.title).toBe('Перевод не подходит к заказу')

    const good = await send(receiver, wei)
    await recheck()
    await reconcilePayments()
    await mine(2)
    await recheck()
    await reconcilePayments()
    expect((await query('SELECT status,tx_hash FROM orders WHERE id=$1', [id]))[0]).toEqual({
      status: 'paid',
      tx_hash: good,
    })
  })

  it('refuses the same transaction for a second order', async () => {
    const first = await newOrder()
    const second = await newOrder()
    const hash = await send(receiver, first.wei)
    await payPublicOrder(first.token, { mode: 'sepolia', hash })
    await expect(payPublicOrder(second.token, { mode: 'sepolia', hash })).rejects.toThrow(
      'WRONG_AMOUNT',
    )
    await expect(submitTransaction(second.id, hash)).rejects.toThrow('TX_ALREADY_USED')
    await mine(2)
    await reconcilePayments()
    expect((await publicOrderView(first.token)).status).toBe('in_progress')
    expect((await publicOrderView(second.token)).status).toBe('awaiting_payment')
  })

  it('does not count a transfer outside the invoice window and closes an expired invoice', async () => {
    const late = await newOrder()
    const hash = await send(receiver, late.wei)
    await payPublicOrder(late.token, { mode: 'sepolia', hash })
    // The transfer is mined after this invoice ended: move the invoice window into the past.
    await query(
      `UPDATE orders SET created_at=now()-interval '3 hours',expires_at=now()-interval '2 hours'
       WHERE id=$1`,
      [late.id],
    )
    await mine(3)
    await settleLate(late.id)
    // A transfer after the deadline never starts the work: the owner returns it by hand.
    const [row] = await query('SELECT status,payment_error,paid_at FROM orders WHERE id=$1', [
      late.id,
    ])
    expect(row).toEqual({
      status: 'manual_review',
      payment_error: 'PAID_AFTER_EXPIRY',
      paid_at: null,
    })
    expect((await publicOrderView(late.token)).status).toBe('needs_attention')
    expect(
      (await query("SELECT data FROM audit_events WHERE kind='late_payment_received'"))[0]!.data,
    ).toMatchObject({ orderId: late.id, hash })

    const unpaid = await newOrder()
    await query(`UPDATE orders SET expires_at=now()-interval '10 minutes' WHERE id=$1`, [unpaid.id])
    await expect(
      payPublicOrder(unpaid.token, { mode: 'sepolia', hash: await send(receiver, unpaid.wei) }),
    ).rejects.toThrow('ORDER_NOT_PAYABLE')
    // The buyer's late transfer is not lost: the scanner reports it to the owner.
    await settleLate(unpaid.id)
    expect((await publicOrderView(unpaid.token)).status).toBe('needs_attention')
    // Without any transfer an ended invoice simply expires.
    const idle = await newOrder()
    await query(`UPDATE orders SET expires_at=now()-interval '10 minutes' WHERE id=$1`, [idle.id])
    await reconcilePayments()
    expect((await publicOrderView(idle.token)).status).toBe('expired')
  })

  it('replaces a mistyped hash with the real transfer found by the scanner', async () => {
    const { id, token, wei } = await newOrder()
    const typo = '0x' + '7'.repeat(64)
    await payPublicOrder(token, { mode: 'sepolia', hash: typo })
    await reconcilePayments()
    expect((await query('SELECT tx_hash FROM orders WHERE id=$1', [id]))[0]!.tx_hash).toBe(typo)
    const hash = await send(receiver, wei)
    await reconcilePayments()
    expect((await publicOrderView(token)).payment).toMatchObject({
      hash,
      detectedAutomatically: true,
    })
    await mine(2)
    await recheck()
    await reconcilePayments()
    expect((await query('SELECT status,tx_hash FROM orders WHERE id=$1', [id]))[0]).toEqual({
      status: 'paid',
      tx_hash: hash,
    })
  })

  it('sends a transfer for an ended invoice to the owner without starting the work', async () => {
    const { id, wei } = await newOrder()
    await query(
      `UPDATE orders SET created_at=now()-interval '40 minutes',expires_at=now()-interval '10 minutes'
       WHERE id=$1`,
      [id],
    )
    await reconcilePayments()
    expect((await query('SELECT status FROM orders WHERE id=$1', [id]))[0]!.status).toBe('expired')
    const hash = await send(receiver, wei)
    await settleLate(id)
    expect(
      (await query('SELECT status,payment_error,tx_hash,paid_at FROM orders WHERE id=$1', [id]))[0],
    ).toEqual({
      status: 'manual_review',
      payment_error: 'PAID_AFTER_EXPIRY',
      tx_hash: hash,
      paid_at: null,
    })
    expect(await query("SELECT id FROM jobs WHERE kind='fulfill'")).toEqual([])
  })

  it('hands a transfer pinned first to the wrong order to the order it pays', async () => {
    // The attacker copies a victim's hash from the mempool while the farm's node cannot answer
    // the precheck, so the hash gets pinned to the attacker's order first.
    const down = async () => {
      throw new Error('RPC_UNAVAILABLE')
    }
    const victim = await newOrder()
    const attacker = await newOrder()
    const hash = await send(receiver, victim.wei)
    await payPublicOrder(attacker.token, { mode: 'sepolia', hash }, down)
    // The victim's own hash submission wins: the node shows the victim's exact amount.
    await payPublicOrder(victim.token, { mode: 'sepolia', hash })
    // The scanner does the same for a victim who never submits a hash.
    const quiet = await newOrder()
    const thief = await newOrder()
    const quietHash = await send(receiver, quiet.wei)
    await payPublicOrder(thief.token, { mode: 'sepolia', hash: quietHash }, down)
    await mine(2)
    await reconcilePayments()
    await recheck()
    await reconcilePayments()
    for (const [order, tx] of [
      [victim, hash],
      [quiet, quietHash],
    ] as const)
      expect((await query('SELECT status,tx_hash FROM orders WHERE id=$1', [order.id]))[0]).toEqual(
        { status: 'paid', tx_hash: tx },
      )
    for (const order of [attacker, thief])
      expect((await query('SELECT status,tx_hash FROM orders WHERE id=$1', [order.id]))[0]).toEqual(
        { status: 'awaiting_payment', tx_hash: null },
      )
  })
})
