import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { executionScopeSchema } from '../../../core/execution/store'
import { controlExecution } from '../../../core/execution/engine'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const { track, mode, action } = await body(
      event,
      executionScopeSchema.extend({ action: z.enum(['start', 'pause', 'close']) }).strict(),
    )
    return controlExecution(track, mode, action)
  }),
)
