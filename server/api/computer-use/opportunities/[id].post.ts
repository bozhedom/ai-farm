import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { setOpportunityStatus } from '../../../../core/computer-use/runtime'
import { computerUseView } from '../../../../core/computer-use/view'
import { body, respond } from '../../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    const { status } = await body(
      event,
      z.object({ status: z.enum(['new', 'saved', 'dismissed']) }).strict(),
    )
    await setOpportunityStatus(id, status)
    return computerUseView()
  }),
)
