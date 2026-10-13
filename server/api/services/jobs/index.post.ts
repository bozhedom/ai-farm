import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { createServiceJob } from '../../../../core/services/store'
import { body, respond } from '../../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z
        .object({
          quote: z.string().min(1).max(2000),
          input: z.string().min(30).max(4000),
          requestKey: z.uuid(),
          rightsConfirmed: z.literal(true),
        })
        .strict(),
    )
    return createServiceJob(input)
  }),
)
