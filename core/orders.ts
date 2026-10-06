import { randomUUID } from 'node:crypto'
import { config, usesSourcePosts } from './config'
import { audit, query, transaction } from './db'
import { reserveBudget } from './budget'
import { productSchema, validateInput } from './policy'
import { orderProgress, paymentErrorText } from './order-progress'
import { sourceSocialDelivery, validateSourcePostInput } from './source-posts'

export async function createOrder(productId: string, input: string, requestKey: string) {
  validateInput(input)
  return transaction(async (db) => {
    // A single policy lock also serializes portfolio and generation changes.
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [existing] = await query(
      'SELECT id,product_id,input FROM orders WHERE request_key=$1',
      [requestKey],
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
    productSchema.parse(product.spec)
    if (product.template === 'social') {
      if (product.spec.promise === sourceSocialDelivery) validateSourcePostInput(input)
      else if (usesSourcePosts(config().MODEL_PROVIDER))
        throw new Error('PRODUCT_RECIPE_REFRESH_REQUIRED')
    }
    const [strategy] = await query(
      "SELECT * FROM strategies WHERE status='active' ORDER BY random() LIMIT 1",
      [],
      db,
    )
    if (!strategy) throw new Error('NO_ACTIVE_STRATEGY')
    const id = randomUUID()
    const reservationId = await reserveBudget(`order:${id}`, 'order', db)
    const [amount] = await query(
      "SELECT (100000000000000 + nextval('invoice_amount_sequence'))::text AS wei",
      [],
      db,
    )
    await query(
      `INSERT INTO orders(id,request_key,product_id,product_snapshot,strategy_id,strategy_snapshot,generation,input,payment_mode,amount_wei,receiver,reservation_id,required_confirmations)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        requestKey,
        productId,
        { ...product.spec, version: product.version },
        strategy.id,
        {
          id: strategy.id,
          name: strategy.name,
          approach: strategy.approach,
          generation: strategy.generation,
        },
        state.generation,
        input,
        config().PAYMENT_MODE,
        amount!.wei,
        config().PAYMENT_MODE === 'sepolia' ? config().SEPOLIA_RECEIVER.toLowerCase() : 'sandbox',
        reservationId,
        config().SEPOLIA_CONFIRMATIONS,
      ],
      db,
    )
    await audit(
      'order_created',
      'Создан тестовый заказ и зарезервирован бюджет исполнения.',
      { orderId: id, productId },
      db,
    )
    return { id }
  })
}

export async function orderDetails(id: string) {
  const [order] = await query('SELECT * FROM orders WHERE id=$1', [id])
  if (!order) throw new Error('ORDER_NOT_FOUND')
  const [jobs, states, attempts] = await Promise.all([
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
  ])
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
    progress: orderProgress(order, job, states[0] || {}),
    job,
    steps: [
      { label: 'Заказ создан', at: order.created_at, done: true },
      {
        label: 'Тестовая оплата подтверждена',
        at: order.paid_at,
        done: !!order.paid_at || delivered,
      },
      {
        label: 'Текст подготовлен',
        at: generated?.finished_at || null,
        done: !!generated || delivered,
      },
      { label: 'Проверка пройдена и результат выдан', at: order.delivered_at, done: delivered },
    ],
    paymentAttempts: attempts.map((a) => ({
      ...a,
      active: a.tx_hash === order.tx_hash,
      errorText: paymentErrorText(a.error_code),
    })),
  }
}
