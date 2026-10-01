import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { z } from 'zod'
import { productHistory } from '../../../../core/products'
import { respond } from '../../../utils/api'

export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(getQuery(event))
    return productHistory(id, before)
  }),
)
