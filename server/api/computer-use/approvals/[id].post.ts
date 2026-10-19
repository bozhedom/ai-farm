import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { resolveApproval } from '../../../../core/computer-use/runtime'
import { computerUseView } from '../../../../core/computer-use/view'
import { body, respond } from '../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    const { decision } = await body(
      event,
      z.object({ decision: z.enum(['approve', 'reject']) }).strict(),
    )
    await resolveApproval(id, decision)
    return computerUseView()
  }),
)
