import { createError, defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { query } from '../../../core/db'
import { respond } from '../../utils/api'
export default defineEventHandler((event) =>
  respond(async () => {
    const id = z.uuid().parse(getRouterParam(event, 'id'))
    const [order] = await query('SELECT * FROM orders WHERE id=$1', [id])
    if (!order) throw new Error('ORDER_NOT_FOUND')
    return order
  }),
)
