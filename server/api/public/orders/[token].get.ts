import { defineEventHandler, getRouterParam } from 'h3'
import { publicOrderView } from '../../../../core/public-orders'
import { respond } from '../../../utils/api'
import { limitPublic } from '../../../utils/client'

export default defineEventHandler((event) =>
  respond(async () => {
    await limitPublic(event, 'order')
    return publicOrderView(String(getRouterParam(event, 'token') || ''))
  }),
)
