import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { allocateLive } from '../../../core/trading/store'
import { exchanges } from '../../../core/trading/types'
import { body, respond } from '../../utils/api'

const schema = z
  .object({ amounts: z.record(z.enum(exchanges), z.number().int().min(0).max(100)) })
  .strict()
export default defineEventHandler((event) =>
  respond(async () => {
    await allocateLive((await body(event, schema)).amounts)
    return { ok: true }
  }),
)
