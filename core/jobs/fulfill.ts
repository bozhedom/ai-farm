import { audit, query, transaction } from '../db'
import { closeReservation } from '../budget'
import { model } from '../providers'
import { reviewSchema, templateSchema, validateOutput, validateTemplateInput } from '../policy'
import type { Job } from '../queue'
import { reviewContext } from './text-context'
import { generateText } from './generate-text'

export async function fulfill(job: Job) {
  const [order] = await query('SELECT * FROM orders WHERE id=$1', [job.payload.orderId])
  if (!order) throw new Error('ORDER_NOT_FOUND')
  if (['delivered', 'closed'].includes(order.status)) return
  if (!['paid', 'running'].includes(order.status)) throw new Error('ORDER_NOT_PAID')
  if (Date.now() - new Date(order.paid_at).getTime() > 30 * 60 * 1000)
    throw new Error('ORDER_REVIEW_REQUIRED')
  const template = templateSchema.parse(order.product_snapshot.template)
  validateTemplateInput(template, order.input)
  await query("UPDATE orders SET status='running' WHERE id=$1 AND status='paid'", [order.id])
  const product = { template, promise: order.product_snapshot.promise as string }
  const output = await generateText({
    key: `${job.id}:generate`,
    reservationId: order.reservation_id,
    product,
    input: order.input,
    approach: order.strategy_snapshot.approach,
  })
  try {
    validateOutput(template, output.text)
  } catch (error) {
    await query("UPDATE orders SET review=$2 WHERE id=$1 AND status IN ('paid','running')", [
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
    await query("UPDATE orders SET review=$2 WHERE id=$1 AND status IN ('paid','running')", [
      order.id,
      review,
    ])
    throw new Error('OUTPUT_REVIEW_REQUIRED')
  }
  await transaction(async (db) => {
    const [state] = await query('SELECT mode FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [lease] = await query(
      `SELECT id FROM jobs WHERE id=$1 AND status='running'
       AND lease_token=$2 AND locked_until>clock_timestamp() FOR UPDATE`,
      [job.id, job.lease_token],
      db,
    )
    const [current] = await query(
      'SELECT status FROM orders WHERE id=$1 FOR UPDATE',
      [order.id],
      db,
    )
    if (!current || !['paid', 'running'].includes(current.status)) return
    // A late response remains in tool_calls, but only the current worker may deliver
    // or release the reservation now owned by a recovered job.
    if (!lease) throw new Error('LEASE_LOST')
    if (state?.mode === 'emergency_stop') throw new Error('STOPPED')
    const rows = await query(
      "UPDATE orders SET status='delivered',result=$2,review=$3,delivered_at=now() WHERE id=$1 AND status IN ('paid','running') RETURNING id",
      [order.id, output.text, review],
      db,
    )
    if (rows.length) {
      await closeReservation(order.reservation_id, db)
      await audit(
        'order_delivered',
        'Тестовый заказ выполнен и прошёл проверку.',
        { orderId: order.id },
        db,
      )
    }
  })
}
