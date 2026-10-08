import { defineEventHandler, getRouterParam } from 'h3'
import { publicService } from '../../../../core/public-catalog'
import { respond } from '../../../utils/api'
import { limitPublic } from '../../../utils/client'

export default defineEventHandler((event) =>
  respond(async () => {
    await limitPublic(event, 'service')
    return publicService(String(getRouterParam(event, 'slug') || ''))
  }),
)
