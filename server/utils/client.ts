import { createHmac, timingSafeEqual } from 'node:crypto'
import { getHeader, type H3Event } from 'h3'
import { config } from '../../core/config'
import { checkRateLimit, type PublicRoute } from '../../core/rate-limit'

/**
 * Server-side rendering calls the API internally with the page request's headers. The security
 * middleware stores the buyer's address in these headers with an HMAC, so the internal call
 * counts against the buyer, and a value sent from outside is never trusted.
 */
export const clientIpHeader = 'x-farm-client-ip'
export const clientSigHeader = 'x-farm-client-sig'

const privatePeer =
  /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.|::ffff:172\.(?:1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:)/i

export function signClientIp(ip: string) {
  return createHmac('sha256', config().SESSION_SECRET).update(`client-ip:${ip}`).digest('hex')
}
function signed(event: H3Event) {
  const ip = getHeader(event, clientIpHeader)
  const sig = getHeader(event, clientSigHeader)
  if (!ip || !sig || ip.length > 64 || !/^[0-9a-f]{64}$/.test(sig)) return null
  const expected = Buffer.from(signClientIp(ip), 'hex')
  return timingSafeEqual(expected, Buffer.from(sig, 'hex')) ? ip : null
}

/**
 * The address behind a connection. X-Forwarded-For counts only with TRUST_PROXY and only from a
 * proxy on a private address (Caddy in compose.edge.yaml); its last entry is the one the proxy
 * added. Otherwise the socket address is the buyer, whatever the header says.
 */
export function peerClientIp(
  peer: string | undefined,
  forwardedFor: string | undefined,
  trustProxy: boolean,
) {
  if (!peer) return 'internal'
  const forwarded = forwardedFor
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (trustProxy && privatePeer.test(peer) && forwarded?.length)
    return forwarded.at(-1)!.slice(0, 64)
  return peer
}

/** The buyer's address for limits. A signed address from our own middleware wins. */
export function clientIp(event: H3Event) {
  const trusted = signed(event)
  if (trusted) return trusted
  return peerClientIp(
    event.node.req.socket?.remoteAddress,
    getHeader(event, 'x-forwarded-for'),
    config().TRUST_PROXY,
  )
}

/** Replaces any client-sent address headers with our own signed value. */
export function stampClientIp(event: H3Event) {
  const ip = clientIp(event)
  event.node.req.headers[clientIpHeader] = ip
  event.node.req.headers[clientSigHeader] = signClientIp(ip)
}

export function limitPublic(event: H3Event, route: PublicRoute) {
  return checkRateLimit(route, clientIp(event))
}
