import { z } from 'zod'
import { audit, query, transaction } from './db'

export const orderResolutionSchema = z
  .object({ reason: z.string().trim().min(10).max(1000) })
  .strict()

/** An explicit owner decision closes a test obligation without claiming delivery or a refund. */
export async function resolveOrder(id: string, reason: string) {
  const input = orderResolutionSchema.parse({ reason })
  return transaction(async (db) => {
    // The same lock order is used by generation changes and final delivery.
    await query('SELECT id FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [order] = await query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id], db)
    if (!order) throw new Error('ORDER_NOT_FOUND')
    if (!['sandbox', 'sepolia'].includes(order.payment_mode))
      throw new Error('ORDER_NOT_RESOLVABLE')
    if (order.status === 'closed') {
      if (order.resolution_reason !== input.reason) throw new Error('ORDER_ALREADY_RESOLVED')
      return {
        id: order.id as string,
        status: 'closed' as const,
        closed_at: order.closed_at as Date,
        resolution_reason: order.resolution_reason as string,
      }
    }
    if (order.status !== 'manual_review') throw new Error('ORDER_NOT_RESOLVABLE')
    const [closed] = await query(
      `UPDATE orders SET status='closed',closed_at=now(),resolution_reason=$2
       WHERE id=$1 RETURNING id,closed_at,resolution_reason`,
      [id, input.reason],
      db,
    )
    await audit(
      'order_resolved',
      'Владелец закрыл тестовый заказ без выдачи результата. История и учтённые расходы сохранены.',
      {
        orderId: id,
        previousStatus: order.status,
        paymentMode: order.payment_mode,
        reason: input.reason,
      },
      db,
    )
    return {
      id: closed!.id as string,
      status: 'closed' as const,
      closed_at: closed!.closed_at as Date,
      resolution_reason: closed!.resolution_reason as string,
    }
  })
}
