import { createError, defineEventHandler, getCookie, getHeader, getRequestURL, setHeader } from 'h3'
import { config } from '../../core/config'
import { validSession } from '../../core/auth'
import { stampClientIp } from '../utils/client'

const read = ['GET', 'HEAD']
/**
 * Buyer API paths open without the owner session. Listed exactly; everything else under /api
 * still needs `farm_session`. Order paths accept any segment so that malformed and unknown
 * links get the same 404 from the handler, not a 401 here.
 */
const publicRoutes: { methods: string[]; path: RegExp }[] = [
  { methods: read, path: /^\/api\/public\/catalog$/ },
  { methods: read, path: /^\/api\/public\/services\/[^/]+$/ },
  { methods: ['POST'], path: /^\/api\/public\/orders$/ },
  { methods: read, path: /^\/api\/public\/orders\/[^/]+$/ },
  { methods: ['POST'], path: /^\/api\/public\/orders\/[^/]+\/pay$/ },
  { methods: read, path: /^\/api\/public\/orders\/[^/]+\/result\.txt$/ },
]
export function isPublicRoute(method: string, path: string) {
  return publicRoutes.some((route) => route.methods.includes(method) && route.path.test(path))
}

export default defineEventHandler(async (event) => {
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Frame-Options', 'DENY')
  setHeader(event, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // Server-side rendering calls the API internally; pass the real client along for limits.
  // Client-sent values are replaced by our own signed one.
  stampClientIp(event)
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return
  setHeader(event, 'Cache-Control', 'no-store')
  if (!read.includes(event.method)) {
    if (getHeader(event, 'origin') !== new URL(config().APP_ORIGIN).origin)
      throw createError({ statusCode: 403, statusMessage: 'ORIGIN_REJECTED' })
    if (!getHeader(event, 'content-type')?.startsWith('application/json'))
      throw createError({ statusCode: 415, statusMessage: 'JSON_REQUIRED' })
    const length = getHeader(event, 'content-length')
    if (!length) throw createError({ statusCode: 411, statusMessage: 'CONTENT_LENGTH_REQUIRED' })
    if (!/^\d+$/.test(length) || Number(length) > 24000)
      throw createError({ statusCode: 413, statusMessage: 'BODY_TOO_LARGE' })
  }
  if (path === '/api/health' || path === '/api/readiness' || path === '/api/auth/login') return
  if (isPublicRoute(event.method, path)) return
  if (!(await validSession(getCookie(event, 'farm_session'))))
    throw createError({ statusCode: 401, statusMessage: 'AUTH_REQUIRED' })
})
