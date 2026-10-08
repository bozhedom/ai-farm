import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { requestScout } from '../../../core/autonomy'
import { body, respond } from '../../../server/utils/api'

/** "Найти идеи сейчас": one scout per agent, or one on the chosen taxonomy topic. */
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z
        .object({ topicId: z.string().max(80).optional() })
        .strict()
        .optional(),
    )
    return requestScout(input?.topicId)
  }),
)
