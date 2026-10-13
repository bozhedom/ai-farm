import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { quoteService } from '../../../core/services/store'
import { body, respond } from '../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z
        .object({
          productId: z.uuid(),
          input: z.string().min(30).max(4000),
          rightsConfirmed: z.literal(true),
        })
        .strict(),
    )
    return quoteService(input.productId, input.input)
  }),
)
