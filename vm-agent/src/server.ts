import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { actionSchema, inspectSchema } from './actions'
import { Sessions } from './browser'

/**
 * Authenticated HTTP API of the VM browser. One bearer token from VM_AGENT_TOKEN, compared in
 * constant time; JSON bodies up to 64 KB; no farm credentials, database or model access here.
 * Routes:
 *   GET    /health
 *   POST   /sessions                      -> { sessionId }
 *   GET    /sessions/:id                  -> { url, title, focused }
 *   GET    /sessions/:id/screenshot       -> { png (base64), url, title, focused }
 *   POST   /sessions/:id/inspect {x,y}    -> { element }
 *   POST   /sessions/:id/actions {action} -> { ok, error, url, title, focused }
 *   Sessions are pages of one persistent profile (VM_AGENT_PROFILE_DIR): logins persist.
 *   DELETE /sessions/:id                  -> { ok }
 */
const MAX_BODY = 64 * 1024
const token = process.env.VM_AGENT_TOKEN || ''
if (token.length < 32) throw new Error('VM_AGENT_TOKEN_REQUIRED')
const port = Number(process.env.VM_AGENT_PORT || 8787)
const host = process.env.VM_AGENT_HOST || '0.0.0.0'
const tokenHash = createHash('sha256').update(token).digest()

export function authorized(header: string | undefined) {
  const match = /^Bearer\s+(\S+)$/.exec(header || '')
  if (!match) return false
  return timingSafeEqual(tokenHash, createHash('sha256').update(match[1]!).digest())
}

const sessions = new Sessions()
const idSchema = z.string().regex(/^[0-9a-f-]{36}$/)

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const length = Number(req.headers['content-length'] || 0)
  if (!Number.isFinite(length) || length > MAX_BODY) throw new Error('BODY_TOO_LARGE')
  if (!String(req.headers['content-type'] || '').startsWith('application/json'))
    throw new Error('JSON_REQUIRED')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new Error('INVALID_INPUT')
  }
}

/** Requests of one session run strictly one after another. */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) || Promise.resolve()
  const next = previous.then(fn, fn)
  queues.set(
    id,
    next.catch(() => undefined),
  )
  return next
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://vm-agent')
  const path = url.pathname
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true })
  if (!authorized(req.headers.authorization)) return send(res, 401, { error: 'AUTH_REQUIRED' })
  if (req.method === 'POST' && path === '/sessions') {
    await readJson(req)
    try {
      return send(res, 200, { sessionId: await sessions.start() })
    } catch (error) {
      // Codes only: a browser launch error carries paths and arguments of this machine.
      const limit = error instanceof Error && error.message === 'SESSION_LIMIT'
      return send(res, limit ? 409 : 503, {
        error: limit ? 'SESSION_LIMIT' : 'BROWSER_UNAVAILABLE',
      })
    }
  }
  const match = /^\/sessions\/([^/]+)(?:\/(screenshot|inspect|actions))?$/.exec(path)
  if (!match) return send(res, 404, { error: 'NOT_FOUND' })
  const id = idSchema.safeParse(match[1])
  const session = id.success ? sessions.get(id.data) : null
  if (!session) return send(res, 404, { error: 'SESSION_NOT_FOUND' })
  const sub = match[2]
  if (req.method === 'DELETE' && !sub)
    return send(res, 200, { ok: await serialized(session.id, () => sessions.end(session.id)) })
  if (req.method === 'GET' && !sub)
    return send(res, 200, await serialized(session.id, () => sessions.state(session)))
  if (req.method === 'GET' && sub === 'screenshot')
    return send(
      res,
      200,
      await serialized(session.id, async () => ({
        png: await sessions.screenshot(session),
        ...(await sessions.reading(session)),
        ...(await sessions.state(session)),
      })),
    )
  if (req.method === 'POST' && sub === 'inspect') {
    const input = inspectSchema.safeParse(await readJson(req))
    if (!input.success) return send(res, 400, { error: 'INVALID_INPUT' })
    const element = await serialized(session.id, () =>
      sessions.inspect(session, input.data.x, input.data.y),
    )
    return send(res, 200, { element })
  }
  if (req.method === 'POST' && sub === 'actions') {
    const input = actionSchema.safeParse(await readJson(req))
    if (!input.success) return send(res, 400, { error: 'INVALID_INPUT' })
    const result = await serialized(session.id, async () => ({
      ...(await sessions.act(session, input.data)),
      ...(await sessions.state(session)),
    }))
    return send(res, 200, result)
  }
  return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : ''
    if (!res.headersSent)
      send(res, code === 'BODY_TOO_LARGE' ? 413 : code ? 400 : 500, {
        error: code || 'INTERNAL_ERROR',
      })
  })
})
server.requestTimeout = 120_000
server.listen(port, host, () => console.log(`vm-agent listening on ${host}:${port}`))

const expiry = setInterval(() => sessions.expire().catch(() => undefined), 60_000)
async function shutdown() {
  clearInterval(expiry)
  server.close()
  await sessions.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
