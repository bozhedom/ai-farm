import { createHash, randomUUID } from 'node:crypto'
import { config, usesSourcePosts } from './config'
import { audit, query, transaction, type Connection } from './db'
import { openUnfundedReservation, orderBudgetAvailable, reserveBudget } from './budget'
import { deriveOrderToken, invoiceUnique, invoiceWei, orderTokenHash } from './public-orders'
import { publicDayCounts } from './public-catalog'
import { productSchema, validateInput, validateTemplateInput, type ProductSpec } from './policy'
import { orderProgress, paymentErrorText } from './order-progress'
import { sourceSocialDelivery, validateSourcePostInput } from './source-posts'
import { agentLabels, agentName, type StrategyRow } from './agents'
import { serviceName } from './service-names'
import { assertOrderModelBudget } from './order-model-budget'

export type OrderStatus =
  'awaiting_payment' | 'paid' | 'running' | 'delivered' | 'expired' | 'manual_review' | 'closed'

type OrderRecord = Record<string, any> & {
  id: string
  status: OrderStatus
  payment_mode: 'sandbox' | 'sepolia'
  product_snapshot: ProductSpec & { version: number }
  result: string | null
  review: { verdict: 'PASS' | 'REVISE' | 'BLOCKED'; reason: string } | null
  payment_error: string | null
  paid_at: Date | null
  delivered_at: Date | null
  closed_at: Date | null
  resolution_reason: string | null
}

/**
 * Idempotency keys are stored as a hash. A public order's link is derived from its key, so the
 * key itself never sits in the database.
 */
export function requestKeyHash(requestKey: string) {
  return 'sha256:' + createHash('sha256').update(requestKey.toLowerCase()).digest('hex')
}

export async function createOrder(productId: string, input: string, requestKey: string) {
  validateInput(input)
  return transaction(async (db) => {
    // A single policy lock also serializes portfolio and generation changes.
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [existing] = await query(
      'SELECT id,product_id,input FROM orders WHERE request_key=$1',
      [requestKeyHash(requestKey)],
      db,
    )
    if (existing) {
      if (existing.product_id !== productId || existing.input !== input)
        throw new Error('IDEMPOTENCY_CONFLICT')
      return { id: existing.id }
    }
    if (state?.mode !== 'running') throw new Error('NEW_ORDERS_PAUSED')
    const [product] = await query(
      "SELECT * FROM products WHERE id=$1 AND status='sandbox'",
      [productId],
      db,
    )
    if (!product) throw new Error('PRODUCT_NOT_FOUND')
    checkProductInput(product, input)
    const id = await insertOrder(db, {
      product,
      state,
      input,
      requestKey,
      amountWei: (sequence) => (100000000000000n + invoiceUnique(sequence)).toString(),
    })
    await audit(
      'order_created',
      'Создан тестовый заказ и зарезервирован бюджет исполнения.',
      { orderId: id, productId },
      db,
    )
    return { id }
  })
}

export function checkProductInput(product: Record<string, any>, input: string) {
  const spec = productSchema.parse(product.spec)
  validateTemplateInput(spec.template, input)
  if (product.template === 'social') {
    if (product.spec.promise === sourceSocialDelivery) validateSourcePostInput(input)
    else if (usesSourcePosts(config().MODEL_PROVIDER))
      throw new Error('PRODUCT_RECIPE_REFRESH_REQUIRED')
  }
}

/** Shared insert for owner and public orders; runs under the caller's system_state lock. */
export async function insertOrder(
  db: Connection,
  o: {
    product: Record<string, any>
    state: Record<string, any>
    input: string
    requestKey: string
    /** Builds the unique invoice amount from the next value of `invoice_amount_sequence`. */
    amountWei: (sequence: bigint) => string
    source?: 'owner' | 'public'
    priceKopecks?: number
    accessTokenHash?: string | null
    clientKey?: string | null
    /** Public orders hold no model budget until their payment is confirmed. */
    fundOnPayment?: boolean
  },
) {
  const [strategy] = await query(
    "SELECT * FROM strategies WHERE status='active' ORDER BY random() LIMIT 1",
    [],
    db,
  )
  if (!strategy) throw new Error('NO_ACTIVE_STRATEGY')
  assertOrderModelBudget({
    product: productSchema.parse(o.product.spec),
    input: o.input,
    approach: strategy.approach,
  })
  const id = randomUUID()
  const reservationId = o.fundOnPayment
    ? await openUnfundedReservation(`order:${id}`, db)
    : await reserveBudget(`order:${id}`, 'order', db)
  const [sequence] = await query("SELECT nextval('invoice_amount_sequence')::text AS n", [], db)
  await query(
    `INSERT INTO orders(id,request_key,product_id,product_snapshot,strategy_id,strategy_snapshot,generation,input,payment_mode,amount_wei,receiver,reservation_id,required_confirmations,source,price_kopecks,access_token_hash,client_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      id,
      requestKeyHash(o.requestKey),
      o.product.id,
      { ...o.product.spec, version: o.product.version },
      strategy.id,
      {
        id: strategy.id,
        name: strategy.name,
        approach: strategy.approach,
        generation: strategy.generation,
      },
      o.state.generation,
      o.input,
      config().PAYMENT_MODE,
      o.amountWei(BigInt(sequence!.n)),
      config().PAYMENT_MODE === 'sepolia' ? config().SEPOLIA_RECEIVER.toLowerCase() : 'sandbox',
      reservationId,
      config().SEPOLIA_CONFIRMATIONS,
      o.source ?? 'owner',
      o.priceKopecks ?? 0,
      o.accessTokenHash ?? null,
      o.clientKey ?? null,
    ],
    db,
  )
  return id
}

/**
 * A buyer order from the public site. The product must be published; the secret link token is
 * returned to the caller and only its sha256 is stored. A repeated `requestKey` with the same
 * service and text returns the same order and link. Payments stay test-only, never revenue.
 * No model budget is reserved here: an unpaid order must not block the farm. The budget is
 * reserved when the payment is confirmed (`confirmPayment`).
 */
export async function createPublicOrder(o: {
  slug: string
  input: string
  requestKey: string
  clientKey: string
}): Promise<{ id: string; token: string; existing: boolean }> {
  validateInput(o.input)
  const token = deriveOrderToken(o.requestKey)
  const hash = orderTokenHash(token)
  return transaction(async (db) => {
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [existing] = await query(
      `SELECT o.id,o.input,o.source,o.access_token_hash,p.slug FROM orders o
       JOIN products p ON p.id=o.product_id WHERE o.request_key=$1`,
      [requestKeyHash(o.requestKey)],
      db,
    )
    if (existing) {
      if (existing.source !== 'public' || existing.slug !== o.slug || existing.input !== o.input)
        throw new Error('IDEMPOTENCY_CONFLICT')
      // The owner replaced this link; the old request cannot bring it back.
      if (existing.access_token_hash !== hash) throw new Error('ORDER_LINK_REPLACED')
      return { id: existing.id, token, existing: true }
    }
    if (state?.mode !== 'running') throw new Error('NEW_ORDERS_PAUSED')
    // Demo products are sold only on a demo stand; with a real model they do not exist here.
    const [product] = await query(
      `SELECT * FROM products WHERE slug=$1 AND status='sandbox' AND visibility='public'
       AND (NOT is_demo OR $2)`,
      [o.slug, config().MODEL_PROVIDER === 'demo'],
      db,
    )
    if (!product) throw new Error('PRODUCT_NOT_FOUND')
    checkProductInput(product, o.input)
    const c = config()
    const [open] = await query(
      `SELECT count(*)::int AS n FROM orders WHERE source='public' AND client_key=$1
       AND status='awaiting_payment' AND (expires_at>now() OR tx_hash IS NOT NULL)`,
      [o.clientKey],
      db,
    )
    if (open!.n >= c.PUBLIC_OPEN_ORDERS_PER_CLIENT) throw new Error('PUBLIC_OPEN_ORDERS_LIMIT')
    const day = await publicDayCounts(db)
    if (day.open >= c.PUBLIC_ORDERS_PER_DAY || day.paid >= c.PUBLIC_PAID_ORDERS_PER_DAY)
      throw new Error('PUBLIC_ORDERS_LIMIT')
    // Nothing is reserved yet, but an order the farm cannot pay for today is not taken.
    if (!(await orderBudgetAvailable(db))) throw new Error('BUDGET_BLOCKED')
    const id = await insertOrder(db, {
      product,
      state,
      input: o.input,
      requestKey: o.requestKey,
      amountWei: (sequence) =>
        invoiceWei(product.price_kopecks, c.TEST_ETH_RUB_RATE, invoiceUnique(sequence)).toString(),
      source: 'public',
      priceKopecks: product.price_kopecks,
      accessTokenHash: hash,
      clientKey: o.clientKey,
      fundOnPayment: true,
    })
    await audit(
      'public_order_created',
      'Покупатель оформил заказ на сайте. Оплата тестовая, выручка не меняется.',
      { orderId: id, productId: product.id, priceKopecks: product.price_kopecks },
      db,
    )
    return { id, token, existing: false }
  })
}

export async function orderDetails(id: string) {
  const [order] = await query<OrderRecord>(
    'SELECT o.*,p.template FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=$1',
    [id],
  )
  if (!order) throw new Error('ORDER_NOT_FOUND')
  const [jobs, states, attempts, strategies] = await Promise.all([
    query(
      'SELECT id,status,attempts,max_attempts,run_after,error_code,started_at,finished_at FROM jobs WHERE dedupe_key=$1',
      [`fulfill:${id}`],
    ),
    query(
      'SELECT mode,worker_heartbeat,payment_heartbeat,provider_readiness FROM system_state WHERE id=true',
    ),
    query(
      'SELECT tx_hash,submitted_at,checked_at,confirmations,error_code,confirmed_at FROM payment_attempts WHERE order_id=$1 ORDER BY submitted_at DESC LIMIT 20',
      [id],
    ),
    query<StrategyRow>('SELECT id,name,parent_id,generation,created_at FROM strategies'),
  ])
  const label = agentLabels(strategies).get(order.strategy_id)
  const job = jobs[0] || null
  const calls = job
    ? await query(
        'SELECT role,status,finished_at FROM tool_calls WHERE job_id=$1 ORDER BY created_at',
        [job.id],
      )
    : []
  const generated = calls.find((c) => c.role === 'Исполнитель' && c.status === 'done')
  const delivered = order.status === 'delivered'
  return {
    ...order,
    number: Number(order.number),
    productName: serviceName(order.template, order.product_snapshot?.name),
    agent: label ? { id: order.strategy_id as string, name: agentName(label), label } : null,
    progress: orderProgress(order, job, states[0] || {}),
    job,
    steps: [
      { label: 'Оформлен', at: order.created_at, done: true },
      {
        label: order.is_test_payment === false ? 'Оплачен' : 'Оплачен (тест)',
        at: order.paid_at,
        done: !!order.paid_at || delivered,
      },
      {
        label: 'Текст написан',
        at: generated?.finished_at || null,
        done: !!generated || delivered,
      },
      { label: 'Проверен и выдан', at: order.delivered_at, done: delivered },
    ],
    paymentAttempts: attempts.map((a) => ({
      ...a,
      active: a.tx_hash === order.tx_hash,
      errorText: paymentErrorText(a.error_code),
    })),
  }
}
