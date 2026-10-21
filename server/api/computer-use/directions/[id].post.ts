import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import {
  deleteDirection,
  DIRECTION_LIMITS as L,
  setDirectionEnabled,
  updateDirection,
} from '../../../../core/computer-use/directions'
import { computerUseView } from '../../../../core/computer-use/view'
import { body, respond } from '../../../utils/api'
/** Edit, switch or delete one direction. Built-ins can be switched off, never deleted. */
export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    const input = await body(
      event,
      z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('update'),
            title: z
              .string()
              .max(L.titleMax * 2)
              .optional(),
            goal: z.string().max(1000).optional(),
            weight: z.number().int().min(L.minWeight).max(L.maxWeight).optional(),
          })
          .strict(),
        z.object({ action: z.literal('enable') }).strict(),
        z.object({ action: z.literal('disable') }).strict(),
        z.object({ action: z.literal('delete') }).strict(),
      ]),
    )
    if (input.action === 'update') {
      const { action: _action, ...patch } = input
      await updateDirection(id, patch)
    } else if (input.action === 'delete') await deleteDirection(id)
    else await setDirectionEnabled(id, input.action === 'enable')
    return computerUseView()
  }),
)
