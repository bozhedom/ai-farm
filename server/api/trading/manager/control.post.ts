import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { controlManager } from '../../../../core/manager/runtime'
import { managerView } from '../../../../core/manager/view'
import { body, respond } from '../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const { action } = await body(
      event,
      z.object({ action: z.enum(['enable', 'pause', 'review']) }).strict(),
    )
    await controlManager(action)
    return managerView()
  }),
)
