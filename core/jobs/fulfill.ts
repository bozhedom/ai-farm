import { audit, query, transaction } from '../db'
import { closeReservation } from '../budget'
import { model } from '../providers'
import { demoResult } from '../providers/demo'
import {
  outputSchema,
  reviewSchema,
  templateSchema,
  validateOutput,
  validateInput,
} from '../policy'
import type { Job } from '../queue'
import { generationContext, reviewContext } from './text-context'

export async function fulfill(job: Job) {
  const [order] = await query('SELECT * FROM orders WHERE id=$1', [job.payload.orderId])
  if (!order) throw new Error('ORDER_NOT_FOUND')
  if (order.status === 'delivered') return
  if (!['paid', 'running'].includes(order.status)) throw new Error('ORDER_NOT_PAID')
  if (Date.now() - new Date(order.paid_at).getTime() > 30 * 60 * 1000)
    throw new Error('ORDER_REVIEW_REQUIRED')
  validateInput(order.input)
  await query("UPDATE orders SET status='running' WHERE id=$1 AND status='paid'", [order.id])
  const template = templateSchema.parse(order.product_snapshot.template)
  const demoText = demoResult(template, order.input)
  const product = { template, promise: order.product_snapshot.promise as string }
  const output = await model({
    role: 'Исполнитель',
    key: `${job.id}:generate`,
    reservationId: order.reservation_id,
    context: generationContext(product, order.input, order.strategy_snapshot.approach),
    schema: outputSchema,
    demoValue: { text: demoText },
  })
  try {
    validateOutput(template, output.text)
  } catch (error) {
    await query('UPDATE orders SET review=$2 WHERE id=$1', [
      order.id,
      {
        verdict: 'BLOCKED',
        reason: 'Ответ не прошёл серверную проверку формата или допустимого содержимого.',
      },
    ])
    throw error
  }
  const review = await model({
    role: 'Проверяющий',
    key: `${job.id}:verify`,
    reservationId: order.reservation_id,
    context: reviewContext(product, order.input, output.text),
    schema: reviewSchema,
    demoValue: {
      verdict: 'PASS',
      reason: 'Демонстрационный текст содержит исходный материал и явно обозначенные ограничения.',
    },
  })
  if (review.verdict !== 'PASS') {
    await query('UPDATE orders SET review=$2 WHERE id=$1', [order.id, review])
    throw new Error('OUTPUT_REVIEW_REQUIRED')
  }
  await transaction(async (db) => {
    const [state] = await query('SELECT mode FROM system_state WHERE id=true FOR UPDATE', [], db)
    if (state?.mode === 'emergency_stop') throw new Error('STOPPED')
    const rows = await query(
      "UPDATE orders SET status='delivered',result=$2,review=$3,delivered_at=now() WHERE id=$1 AND status IN ('paid','running') RETURNING id",
      [order.id, output.text, review],
      db,
    )
    await closeReservation(order.reservation_id, db)
    if (rows.length)
      await audit(
        'order_delivered',
        'Тестовый заказ выполнен и прошёл проверку.',
        { orderId: order.id },
        db,
      )
  })
}
