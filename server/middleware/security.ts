import {
  createError,
  defineEventHandler,
  getCookie,
  getHeader,
  getRequestURL,
  setHeader,
  setResponseStatus,
} from 'h3'
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
  return (
    path === '/storefront' ||
    path === '/terms' ||
    /^\/services\/[a-z0-9][a-z0-9-]{1,60}$/.test(path)
  )
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

const badPathPage = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Неверная ссылка. AI Farm</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f3ec;color:#1d1f1c;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}main{max-width:420px}h1{font-size:24px;margin:0 0 8px}a{color:#1e6b46;font-weight:600}</style></head><body><main><h1>Неверная ссылка</h1><p>В адресе есть лишние символы. Скопируйте ссылку целиком или начните с главной.</p><p><a href="/">На главную</a></p></main></body></html>`

export default defineEventHandler(async (event) => {
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Frame-Options', 'DENY')
  setHeader(event, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // Server-side rendering calls the API internally; pass the real client along for limits.
  // Client-sent values are replaced by our own signed one.
  stampClientIp(event)
  const path = rawPath(event.path || '/')
  if (ambiguousPath(path, getRequestURL(event).pathname)) {
    // A browser opening a broken page link gets a short Russian page; API clients keep the code.
    if (!path.startsWith('/api/') && /text\/html/.test(getHeader(event, 'accept') || '')) {
      setResponseStatus(event, 400, 'BAD_PATH')
      setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
      setHeader(event, 'Cache-Control', 'no-store')
      return badPathPage
    }
    throw createError({ statusCode: 400, statusMessage: 'BAD_PATH' })
  }
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
