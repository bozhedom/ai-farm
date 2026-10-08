import { defineEventHandler } from 'h3'
import { z } from 'zod'
import type { PublicOrderCreated } from '../../../../core/contracts/public'
import { createPublicOrder } from '../../../../core/orders'
import { orderUrl } from '../../../../core/public-orders'
import { clientKey } from '../../../../core/rate-limit'
import { body, respond } from '../../../utils/api'
import { clientIp, limitPublic } from '../../../utils/client'

export default defineEventHandler((event) =>
  respond(async (): Promise<PublicOrderCreated> => {
    await limitPublic(event, 'createOrder')
    const input = await body(
      event,
      z
        .object({
          slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
          input: z.string().min(1).max(4000),
          requestKey: z.uuid(),
          rightsConfirmed: z.literal(true),
        })
        .strict(),
    )
    const order = await createPublicOrder({
      slug: input.slug,
      input: input.input,
      requestKey: input.requestKey,
      clientKey: clientKey(clientIp(event)),
    })
    return { orderId: order.id, token: order.token, url: orderUrl(order.token) }
  }),
)
