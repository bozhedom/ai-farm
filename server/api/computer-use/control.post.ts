import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { cancelTask, controlComputerUse } from '../../../core/computer-use/runtime'
import { computerUseView } from '../../../core/computer-use/view'
import { body, respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const input = await body(
      event,
      z.discriminatedUnion('action', [
        z.object({ action: z.enum(['enable', 'pause']) }).strict(),
        z.object({ action: z.literal('cancel'), taskId: z.uuid() }).strict(),
      ]),
    )
    if (input.action === 'cancel') await cancelTask(input.taskId)
    else await controlComputerUse(input.action)
    return computerUseView()
  }),
)
