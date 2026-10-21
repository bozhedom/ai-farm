import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { createDirection, DIRECTION_LIMITS as L } from '../../../../core/computer-use/directions'
import { computerUseView } from '../../../../core/computer-use/view'
import { body, respond } from '../../../utils/api'
/** The owner adds a search direction; the goal passes the same checks as an owner goal. */
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z
        .object({
          title: z.string().max(L.titleMax * 2),
          goal: z.string().max(1000),
          weight: z.number().int().min(L.minWeight).max(L.maxWeight).optional(),
        })
        .strict(),
    )
    const id = await createDirection(input)
    return { id, ...(await computerUseView()) }
  }),
)
