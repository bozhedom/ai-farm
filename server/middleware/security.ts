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

/** The path exactly as the router sees it: no query, no normalization. */
export function rawPath(url: string) {
  return url.split(/[?#]/, 1)[0] || '/'
}
/**
 * The router matches the raw path, while URL parsing turns `\` into `/` and folds `..`. A path
 * that the two read differently could reach an owner handler past the public list, so such
 * paths under /api and /order are refused outright.
 */
const ambiguous = /\\|%2e|%2f|%5c|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/i
export function ambiguousPath(raw: string, normalized: string) {
  const guarded = (path: string) => /^\/(?:api|order)(?:\/|$)/i.test(path)
  return (guarded(raw) || guarded(normalized)) && ambiguous.test(raw)
}

/** Pages a search engine may index once PUBLIC_INDEXING is on; everything else is noindex. */
export function indexablePage(path: string) {
  return path === '/' || path === '/terms' || /^\/services\/[a-z0-9][a-z0-9-]{1,60}$/.test(path)
}

/**
 * Order pages carry the buyer's text and result: never cached, and scripts only from this site.
 * Nuxt hydrates with an inline script, so inline scripts stay allowed.
 */
export const orderPagePolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

export default defineEventHandler(async (event) => {
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Frame-Options', 'DENY')
  setHeader(event, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // Server-side rendering calls the API internally; pass the real client along for limits.
  // Client-sent values are replaced by our own signed one.
  stampClientIp(event)
  const path = rawPath(event.path || '/')
  if (ambiguousPath(path, getRequestURL(event).pathname))
    throw createError({ statusCode: 400, statusMessage: 'BAD_PATH' })
  if (!(config().PUBLIC_INDEXING && indexablePage(path)))
    setHeader(event, 'X-Robots-Tag', 'noindex, nofollow')
  if (path.startsWith('/order/')) {
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'Content-Security-Policy', orderPagePolicy)
  }
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
