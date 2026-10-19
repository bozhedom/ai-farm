import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { resolveTarget, type Resolver } from './guard'

/**
 * Forward proxy of the VM browser, bound to loopback. Chromium sends every request, redirect
 * hop and WebSocket here by name; the proxy resolves the name, refuses private addresses and
 * connects to the very address it checked. A DNS answer that changes between the check and the
 * connection (rebinding) therefore cannot reach a private network, and requests the Playwright
 * route hook never sees (WebSockets, service-worker fetches) pass the same guard.
 */
export type Dial = (address: string, port: number) => Socket
export type ProxyOptions = { resolver?: Resolver; dial?: Dial }
export type Proxy = { port: number; close(): Promise<void> }

const defaultDial: Dial = (address, port) => netConnect({ host: address, port })
/** Hop-by-hop headers belong to each connection, not to the forwarded request. */
const hopByHop = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

function plain(status: number) {
  const reason = status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Bad Gateway'
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
}

/** `host:port` of a CONNECT request; the port is required, as Chromium always sends it. */
export function parseConnectTarget(target: string | undefined) {
  if (!target || !/^[A-Za-z0-9.\-\[\]:]+:\d{1,5}$/.test(target)) return null
  let url: URL
  try {
    url = new URL(`http://${target}`)
  } catch {
    return null
  }
  // The URL parser drops a default port; the explicit one of the request line is what counts.
  const port = Number(target.slice(target.lastIndexOf(':') + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { hostname: url.hostname, port }
}

export function createProxy(options: ProxyOptions = {}): Server {
  const dial = options.dial ?? defaultDial
  const resolve = (hostname: string) => resolveTarget(hostname, options.resolver)
  const server = createServer({ keepAlive: false }, async (req, res) => {
    let url: URL
    try {
      url = new URL(req.url || '')
    } catch {
      res.socket?.end(plain(400))
      return
    }
    // Only absolute http targets; https always arrives as CONNECT.
    const address =
      url.protocol === 'http:' && !url.username && !url.password
        ? await resolve(url.hostname)
        : null
    if (!address) {
      res.writeHead(403, { 'Content-Length': 0, Connection: 'close' })
      res.end()
      return
    }
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers))
      if (value !== undefined && !hopByHop.includes(name)) headers[name] = value
    headers.host = url.host
    const port = url.port ? Number(url.port) : 80
    const upstream = httpRequest(
      {
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false,
        createConnection: () => dial(address, port),
      },
      (response) => {
        const out: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined && !hopByHop.includes(name)) out[name] = value
        res.writeHead(response.statusCode || 502, out)
        response.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0, Connection: 'close' })
      res.end()
    })
    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connect', async (req, socket, head) => {
    const target = parseConnectTarget(req.url)
    if (!target) {
      socket.end(plain(400))
      return
    }
    const address = await resolve(target.hostname)
    if (!address) {
      socket.end(plain(403))
      return
    }
    const upstream = dial(address, target.port)
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.once('error', () => {
      if (!socket.destroyed) socket.end(plain(502))
    })
    socket.once('error', () => upstream.destroy())
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
  })
  // WebSockets of a proxied browser arrive as CONNECT tunnels; a bare upgrade is not expected.
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.on('clientError', (_error, socket) => socket.destroy())
  return server
}

export async function startProxy(options: ProxyOptions = {}): Promise<Proxy> {
  const server = createProxy(options)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('PROXY_LISTEN_FAILED')
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
