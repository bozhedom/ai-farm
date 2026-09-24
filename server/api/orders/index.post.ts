import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { createOrder } from '../../../core/orders'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z
        .object({ productId: z.uuid(), input: z.string().min(30).max(4000), requestKey: z.uuid() })
        .strict(),
    )
    return createOrder(input.productId, input.input, input.requestKey)
  }),
)
