import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { requestEvolution } from '../../../../core/evolution'
import { body, respond } from '../../../../server/utils/api'

/** "Проверить отбор сейчас": queues a real selection check with trigger 'owner'. */
export default defineEventHandler((event) =>
  respond(async () => {
    await body(event, z.object({}).strict().optional())
    return requestEvolution()
  }),
)
