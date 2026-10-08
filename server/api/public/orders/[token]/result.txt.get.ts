import { defineEventHandler, getRouterParam, setHeader } from 'h3'
import { publicResultText } from '../../../../../core/public-orders'
import { respond } from '../../../../utils/api'
import { limitPublic } from '../../../../utils/client'

export default defineEventHandler((event) =>
  respond(async () => {
    await limitPublic(event, 'result')
    const result = await publicResultText(String(getRouterParam(event, 'token') || ''))
    setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="${result.filename}"`)
    return result.text
  }),
)
