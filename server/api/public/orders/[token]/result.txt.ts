import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { publicResultText } from '../../../../../core/public-orders'
import { respond } from '../../../../utils/api'
import { limitPublic } from '../../../../utils/client'

/** GET downloads the result; HEAD answers with the same headers and no text. */
export default defineEventHandler((event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    setHeader(event, 'Allow', 'GET, HEAD')
    throw createError({ statusCode: 405, statusMessage: 'METHOD_NOT_ALLOWED' })
  }
  return respond(async () => {
    await limitPublic(event, 'result')
    const result = await publicResultText(String(getRouterParam(event, 'token') || ''))
    setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="${result.filename}"`)
    return result.text
  })
})
