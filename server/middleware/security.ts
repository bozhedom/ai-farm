import { createError, defineEventHandler, getCookie, getHeader, getRequestURL, setHeader } from 'h3'
import { config } from '../../core/config'
import { validSession } from '../../core/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Frame-Options', 'DENY')
  setHeader(event, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return
  setHeader(event, 'Cache-Control', 'no-store')
  if (!['GET', 'HEAD'].includes(event.method)) {
    if (getHeader(event, 'origin') !== new URL(config().APP_ORIGIN).origin)
      throw createError({ statusCode: 403, statusMessage: 'ORIGIN_REJECTED' })
    if (!getHeader(event, 'content-type')?.startsWith('application/json'))
      throw createError({ statusCode: 415, statusMessage: 'JSON_REQUIRED' })
    const length = getHeader(event, 'content-length')
    if (!length) throw createError({ statusCode: 411, statusMessage: 'CONTENT_LENGTH_REQUIRED' })
    if (!/^\d+$/.test(length) || Number(length) > 24000)
      throw createError({ statusCode: 413, statusMessage: 'BODY_TOO_LARGE' })
  }
  if (path === '/api/health' || path === '/api/auth/login') return
  if (!(await validSession(getCookie(event, 'farm_session'))))
    throw createError({ statusCode: 401, statusMessage: 'AUTH_REQUIRED' })
})
