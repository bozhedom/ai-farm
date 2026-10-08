import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { rotateOrderToken } from '../../../../core/public-orders'
import { body, respond } from '../../../utils/api'

/** Owner only (session required by the middleware): replaces a public order's secret link. */
export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    await body(event, z.object({}).strict())
    return rotateOrderToken(id)
  }),
)
