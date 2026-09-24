import { randomUUID } from 'node:crypto'
import { config } from './config'
import { audit, query, transaction } from './db'
import { reserveBudget } from './budget'
import { productSchema, validateInput } from './policy'

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
      `INSERT INTO orders(id,request_key,product_id,product_snapshot,strategy_id,strategy_snapshot,generation,input,payment_mode,amount_wei,receiver,reservation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
