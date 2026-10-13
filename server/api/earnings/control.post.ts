import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { controlEarnings } from '../../../core/earnings/monitor'
import { body, respond } from '../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z.object({ action: z.enum(['enable', 'pause', 'refresh']) }).strict(),
    )
    return controlEarnings(input.action)
  }),
)
