import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { orderResolutionSchema, resolveOrder } from '../../../../core/order-resolution'
import { body, respond } from '../../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    const input = await body(event, orderResolutionSchema)
    return resolveOrder(id, input.reason)
  }),
)
